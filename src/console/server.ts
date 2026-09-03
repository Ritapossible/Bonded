/**
 * The owner console — a local HTTP server.
 *
 * Security posture, stated up front because this surface exposes account state:
 *
 * - **Binds to 127.0.0.1 only.** Never `0.0.0.0`. The payload includes balances, order
 *   history and the mandate's thresholds; putting that on a listening public interface
 *   would be a worse hole than the one BONDED exists to close.
 * - **Read-only.** There is no route that places an order, edits a mandate, or clears
 *   the bond. The console observes; it cannot act. A compromised browser tab therefore
 *   cannot become a trading capability.
 * - **No credentials in the payload.** The view model is assembled from the mandate and
 *   in-memory counters; `Secret` values never reach it.
 *
 * The console is a display, not a safety component. If it fails to start, BONDED logs
 * and carries on trading — a broken screen must never take the gate down with it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../observability/logger.js";
import { CONSOLE_HTML } from "./page.js";
import { buildConsoleState, type ConsoleStateSources } from "./state.js";
import type { ActivityFeed } from "./activity.js";

export interface ConsoleServerOptions extends ConsoleStateSources {
  readonly port: number;
  readonly logger: Logger;
  readonly feed: ActivityFeed;
  /** Full-state refresh cadence, so source health and counters stay live. */
  readonly refreshMs?: number;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // The console renders exchange-supplied strings; a sniffed content type would be an
  // avoidable way for one of them to be interpreted as something else.
  "x-content-type-options": "nosniff",
} as const;

export class ConsoleServer {
  readonly #options: ConsoleServerOptions;
  readonly #logger: Logger;
  readonly #clients = new Set<ServerResponse>();
  #server: Server | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #port: number | undefined;

  constructor(options: ConsoleServerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: "console" });
  }

  /** The bound port, once listening. */
  get port(): number | undefined {
    return this.#port;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * Start listening.
   *
   * Resolves either way: a console that cannot bind is reported and skipped, never
   * fatal. The one thing that must not happen is BONDED refusing to trade because a
   * display port was busy.
   */
  async start(): Promise<boolean> {
    const server = createServer((req, res) => {
      this.#handle(req, res);
    });
    this.#server = server;

    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        this.#logger.warn(
          { port: this.#options.port, code: error.code },
          "console could not bind; continuing without it",
        );
        resolve(false);
      });
      // Loopback only. See the note at the top of this file.
      server.listen(this.#options.port, "127.0.0.1", () => {
        resolve(true);
      });
    });

    if (!listening) {
      this.#server = undefined;
      return false;
    }

    this.#port = this.#options.port;

    // Push on every activity entry, so a bond burn reaches the screen immediately, and
    // on a timer as well, so counters and source health stay current without one.
    this.#unsubscribe = this.#options.feed.subscribe(() => {
      this.#broadcast();
    });
    this.#refreshTimer = setInterval(() => {
      this.#broadcast();
    }, this.#options.refreshMs ?? 2_000);
    this.#refreshTimer.unref();

    return true;
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    // Read-only by construction: anything but GET is refused before routing.
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end("method not allowed");
      return;
    }

    if (url === "/" || url.startsWith("/?")) {
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        .end(CONSOLE_HTML);
      return;
    }

    if (url === "/api/state") {
      res
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        .end(JSON.stringify(buildConsoleState(this.#options)));
      return;
    }

    if (url === "/api/events") {
      this.#openStream(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  #openStream(res: ServerResponse): void {
    res.writeHead(200, SSE_HEADERS);
    // Disable Nagle: a bond burn should reach the screen now, not when a buffer fills.
    res.socket?.setNoDelay(true);
    this.#clients.add(res);

    this.#send(res, buildConsoleState(this.#options));

    const heartbeat = setInterval(() => {
      // An SSE comment. Keeps intermediaries from closing an idle connection without
      // producing an event the page has to handle.
      res.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref();

    res.on("close", () => {
      clearInterval(heartbeat);
      this.#clients.delete(res);
    });
  }

  #send(res: ServerResponse, state: unknown): void {
    try {
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    } catch {
      // A dead socket is normal — the client navigated away. `close` cleans it up.
    }
  }

  #broadcast(): void {
    if (this.#clients.size === 0) return;
    const state = buildConsoleState(this.#options);
    for (const client of this.#clients) {
      this.#send(client, state);
    }
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#refreshTimer !== undefined) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    for (const client of this.#clients) client.end();
    this.#clients.clear();

    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // `close()` alone only stops accepting new connections — it waits indefinitely
      // for existing keep-alive sockets, which browsers and fetch pools hold open. So
      // shutdown would hang whenever the console had ever been opened, and a pooled
      // client would be handed a socket to a server that is going away. Destroying
      // them makes stop() deterministic and tells clients to re-dial.
      server.closeAllConnections();
    });
  }
}
