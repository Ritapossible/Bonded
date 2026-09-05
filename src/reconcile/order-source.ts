/**
 * Where observed orders come from.
 *
 * Two implementations, deliberately overlapping:
 *
 * - **`UserDataStreamSource`** — Binance's user data stream, pushed in real time. This
 *   is what makes bypass detection near-instant rather than a batch job.
 * - **`PollingOrderSource`** — `GET /api/v3/allOrders` per symbol on an interval. It
 *   is the backstop: it closes the gap after a reconnect and keeps the audit path
 *   alive if the stream is unavailable at all.
 *
 * The overlap is intentional. Reconciliation de-duplicates by exchange order id, so
 * seeing the same order twice costs nothing, while seeing it *zero* times is the one
 * failure this component exists to prevent.
 *
 * Both report liveness. A source that has gone quiet is not the same as an account
 * with no activity, and the caller must be able to tell those apart — a silently dead
 * feed would turn the bond into decoration.
 */

import type { BinanceClient } from "../binance/client.js";
import type { Clock } from "../core/clock.js";
import { describeUnknownError, type BondedError } from "../core/errors.js";
import type { Logger } from "../observability/logger.js";
import { parseAllOrders, parseExecutionReport, type ObservedOrder } from "./observed-order.js";

/** How often `waitUntilHealthy` re-checks. */
const HEALTH_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OrderHandler = (orders: readonly ObservedOrder[]) => void;

/**
 * How much of the account a source can actually see.
 *
 * This is not a detail. `GET /api/v3/allOrders` requires a symbol — there is no
 * account-wide REST listing — so the polling backstop can only ask about symbols it was
 * given. An order on any other symbol is invisible to it. The user data stream is
 * account-wide and has no such blind spot.
 *
 * Treating the two as interchangeable would let BONDED report a healthy audit path
 * while being structurally unable to see the simplest evasion there is: trade a symbol
 * the mandate never mentioned.
 */
export type OrderSourceCoverage =
  /** Every order on the account, whatever the symbol. */
  | "account"
  /** Only the symbols this source was configured to watch. */
  | "symbols";

export interface OrderSource {
  readonly name: string;
  readonly coverage: OrderSourceCoverage;
  start(onOrders: OrderHandler): Promise<void>;
  stop(): Promise<void>;
  /**
   * Resolve once this source is delivering, or when `timeoutMs` elapses.
   *
   * `start()` returning does not mean a source is live: opening a websocket is a
   * handshake that completes on a later turn of the event loop. Judging coverage the
   * instant `start()` returned reported every stream as dead and refused to boot. The
   * caller needs a way to wait for the answer instead of sampling too early.
   *
   * Returns the health at the moment it gives up waiting, so the caller decides.
   */
  waitUntilHealthy(timeoutMs: number): Promise<boolean>;
  /** When this source last successfully heard from the exchange. */
  readonly lastHealthyAtMs: number | undefined;
  readonly healthy: boolean;
}

// ---------------------------------------------------------------------------
// Polling backstop
// ---------------------------------------------------------------------------

export interface PollingOrderSourceOptions {
  readonly client: BinanceClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly symbols: readonly string[];
  readonly intervalMs?: number;
  /** How far back the first poll reaches, to catch orders placed while BONDED was down. */
  readonly lookbackMs?: number;
}

export class PollingOrderSource implements OrderSource {
  readonly name = "poll";
  readonly coverage = "symbols" as const;

  readonly #client: BinanceClient;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #symbols: readonly string[];
  readonly #intervalMs: number;
  readonly #lookbackMs: number;

  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #lastHealthyAtMs: number | undefined;
  /** Per-symbol high-water mark, so each poll only asks for what it has not seen. */
  readonly #since = new Map<string, number>();

  constructor(options: PollingOrderSourceOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: "poll-source" });
    this.#symbols = options.symbols;
    this.#intervalMs = options.intervalMs ?? 15_000;
    this.#lookbackMs = options.lookbackMs ?? 24 * 60 * 60 * 1000;
  }

  get lastHealthyAtMs(): number | undefined {
    return this.#lastHealthyAtMs;
  }

  get healthy(): boolean {
    if (this.#lastHealthyAtMs === undefined) return false;
    // Two missed intervals is a stall, not jitter.
    return this.#clock.now() - this.#lastHealthyAtMs <= this.#intervalMs * 2;
  }

  /**
   * Already settled: `start()` awaits the first pass, so this source's health is known
   * by the time anyone can ask.
   */
  waitUntilHealthy(_timeoutMs: number): Promise<boolean> {
    return Promise.resolve(this.healthy);
  }

  async start(onOrders: OrderHandler): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    const start = this.#clock.now() - this.#lookbackMs;
    for (const symbol of this.#symbols) {
      this.#since.set(symbol, start);
    }

    await this.poll(onOrders);
    this.#timer = setInterval(() => {
      void this.poll(onOrders);
    }, this.#intervalMs);
    // Do not hold the event loop open on this timer alone.
    this.#timer.unref();
  }

  /**
   * One polling pass.
   *
   * Errors are logged rather than thrown: a transient failure must not kill the audit
   * loop. Health is not updated on failure, so a sustained outage surfaces through
   * `healthy` going false instead of through silence.
   */
  async poll(onOrders: OrderHandler): Promise<void> {
    const collected: ObservedOrder[] = [];
    let anySucceeded = false;

    for (const symbol of this.#symbols) {
      const since = this.#since.get(symbol) ?? this.#clock.now() - this.#lookbackMs;
      const raw = await this.#client.allOrders(symbol, { startTime: since });
      if (!raw.ok) {
        this.#logFailure(symbol, raw.error);
        continue;
      }
      const parsed = parseAllOrders(raw.value);
      if (!parsed.ok) {
        this.#logFailure(symbol, parsed.error);
        continue;
      }
      anySucceeded = true;
      collected.push(...parsed.value);

      // Advance the watermark to the newest event seen, minus a small overlap so an
      // order landing on the boundary is not skipped between polls.
      const newest = parsed.value.reduce((max, order) => Math.max(max, order.observedAtMs), 0);
      if (newest > 0) this.#since.set(symbol, newest - 1_000);
    }

    if (anySucceeded) this.#lastHealthyAtMs = this.#clock.now();
    if (collected.length > 0) onOrders(collected);
  }

  #logFailure(symbol: string, error: BondedError): void {
    this.#logger.warn({ symbol, error: error.toJSON() }, "poll failed for symbol");
  }

  stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// User data stream
// ---------------------------------------------------------------------------

export interface UserDataStreamSourceOptions {
  readonly client: BinanceClient;
  readonly clock: Clock;
  readonly logger: Logger;
  /** e.g. `wss://stream.testnet.binance.vision/ws`. */
  readonly streamBaseUrl: string;
  /** Injected for tests. Defaults to the global WebSocket (Node 22+). */
  readonly webSocketImpl?: typeof WebSocket;
  readonly keepAliveMs?: number;
  readonly reconnectDelayMs?: number;
}

/**
 * Real-time order events over Binance's user data stream.
 *
 * Uses the **listen-key** flow rather than the WebSocket API's
 * `userDataStream.subscribe`. That newer method requires an authenticated session via
 * `session.logon`, which requires Ed25519 keys; the listen-key flow works with the
 * HMAC keys Spot Testnet issues. See MEMORY.md — this is a deliberate choice, not an
 * oversight.
 *
 * A listen key expires after 60 minutes and must be kept alive. A lapsed key stops
 * delivering events *without an error*, which would blind the audit path silently — so
 * a keepalive failure marks the source unhealthy rather than being swallowed.
 */
export class UserDataStreamSource implements OrderSource {
  readonly name = "stream";
  readonly coverage = "account" as const;

  readonly #client: BinanceClient;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #streamBaseUrl: string;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #keepAliveMs: number;
  readonly #reconnectDelayMs: number;

  #socket: WebSocket | undefined;
  #listenKey: string | undefined;
  #keepAliveTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #onOrders: OrderHandler | undefined;
  #stopped = false;
  #lastHealthyAtMs: number | undefined;

  constructor(options: UserDataStreamSourceOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: "stream-source" });
    this.#streamBaseUrl = options.streamBaseUrl.replace(/\/+$/, "");
    this.#WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
    // 30 minutes, comfortably inside Binance's 60-minute expiry.
    this.#keepAliveMs = options.keepAliveMs ?? 30 * 60 * 1000;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  }

  get lastHealthyAtMs(): number | undefined {
    return this.#lastHealthyAtMs;
  }

  get healthy(): boolean {
    return this.#socket?.readyState === 1; /* OPEN */
  }

  /**
   * Wait for the socket to finish its handshake.
   *
   * Polled rather than event-driven on purpose: the socket is replaced on every
   * reconnect, so a listener attached to the one that existed when this was called
   * would be watching an object nobody uses any more. A short poll is correct across
   * a reconnect and costs nothing at this timescale.
   */
  async waitUntilHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = this.#clock.now() + timeoutMs;
    while (!this.healthy && !this.#stopped && this.#clock.now() < deadline) {
      await delay(HEALTH_POLL_MS);
    }
    return this.healthy;
  }

  async start(onOrders: OrderHandler): Promise<void> {
    this.#onOrders = onOrders;
    this.#stopped = false;
    await this.#connect();
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;

    const listenKey = await this.#client.createListenKey();
    if (!listenKey.ok) {
      this.#logger.error({ error: listenKey.error.toJSON() }, "could not open a user data stream");
      this.#scheduleReconnect();
      return;
    }
    this.#listenKey = listenKey.value;

    const socket = new this.#WebSocketImpl(`${this.#streamBaseUrl}/${listenKey.value}`);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#lastHealthyAtMs = this.#clock.now();
      this.#logger.info("user data stream connected");
      this.#startKeepAlive();
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      this.#handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      this.#logger.warn("user data stream error");
    });

    socket.addEventListener("close", () => {
      this.#stopKeepAlive();
      if (this.#stopped) return;
      // A dropped socket blinds the audit path. Reconnect, and let the polling
      // backstop cover the gap in the meantime.
      this.#logger.warn("user data stream closed; reconnecting");
      this.#scheduleReconnect();
    });
  }

  #handleMessage(data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof data === "string" ? data : String(data));
    } catch (cause: unknown) {
      this.#logger.warn({ cause: describeUnknownError(cause) }, "unparseable stream frame");
      return;
    }

    this.#lastHealthyAtMs = this.#clock.now();

    // The stream carries balance updates too; only order events are reconcilable.
    const event = payload as { e?: unknown };
    if (event.e !== "executionReport") return;

    const parsed = parseExecutionReport(payload);
    if (!parsed.ok) {
      this.#logger.warn({ error: parsed.error.toJSON() }, "unrecognised executionReport");
      return;
    }
    this.#onOrders?.([parsed.value]);
  }

  #startKeepAlive(): void {
    this.#stopKeepAlive();
    this.#keepAliveTimer = setInterval(() => {
      void this.#keepAlive();
    }, this.#keepAliveMs);
    this.#keepAliveTimer.unref();
  }

  async #keepAlive(): Promise<void> {
    const key = this.#listenKey;
    if (key === undefined) return;
    const result = await this.#client.keepAliveListenKey(key);
    if (!result.ok) {
      // An expired key stops delivering events without closing the socket, so this
      // failure must be loud: it is the silent-blindness case.
      this.#logger.error(
        { error: result.error.toJSON() },
        "listen key keepalive failed; the stream may stop delivering events",
      );
      this.#lastHealthyAtMs = undefined;
      return;
    }
    this.#lastHealthyAtMs = this.#clock.now();
  }

  #stopKeepAlive(): void {
    if (this.#keepAliveTimer !== undefined) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopKeepAlive();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#socket?.close();
    this.#socket = undefined;
    if (this.#listenKey !== undefined) {
      await this.#client.closeListenKey(this.#listenKey);
      this.#listenKey = undefined;
    }
  }
}
