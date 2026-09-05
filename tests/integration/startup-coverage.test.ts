/**
 * The audit's C1, against the real `UserDataStreamSource`.
 *
 * `tests/unit/audit-path.test.ts` covers the rule with a hand-written source. That is
 * not enough on its own: the bug was in the *interaction* between the rule and the real
 * stream's lifecycle — `start()` resolves while the socket is still `CONNECTING`, so
 * anything that sampled `healthy` immediately saw a dead stream and refused to boot. A
 * stub written by the same person who misread the lifecycle would have misread it here
 * too, so this test drives the actual class.
 */

import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { ok, type Result } from "../../src/core/result.js";
import type { BondedError } from "../../src/core/errors.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import { resolveStartupCoverage } from "../../src/reconcile/audit-path.js";
import { UserDataStreamSource, type OrderSource } from "../../src/reconcile/order-source.js";

/** A socket that behaves like a real one: CONNECTING first, OPEN on a later tick. */
class DeferredSocket {
  static openAfterMs = 40;
  readyState = 0;
  readonly #listeners: Record<string, ((event?: unknown) => void)[]> = {};

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      for (const listener of this.#listeners["open"] ?? []) listener();
    }, DeferredSocket.openAfterMs);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    (this.#listeners[type] ??= []).push(listener);
  }

  close(): void {
    this.readyState = 3;
  }
}

const listenKeyClient = {
  createListenKey: (): Promise<Result<string, BondedError>> => Promise.resolve(ok("a-listen-key")),
  keepAliveListenKey: (): Promise<Result<void, BondedError>> => Promise.resolve(ok(undefined)),
  closeListenKey: (): Promise<Result<void, BondedError>> => Promise.resolve(ok(undefined)),
};

function streamSource(): UserDataStreamSource {
  return new UserDataStreamSource({
    client: listenKeyClient as never,
    clock: systemClock,
    logger: createSilentLogger(),
    streamBaseUrl: "wss://stream.testnet.binance.vision/ws",
    webSocketImpl: DeferredSocket as never,
  });
}

const poller: OrderSource = {
  name: "poll",
  coverage: "symbols",
  healthy: true,
  lastHealthyAtMs: 1,
  waitUntilHealthy: () => Promise.resolve(true),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};

describe("startup coverage with the real stream source", () => {
  it("reports the stream as not yet healthy the instant start() returns", async () => {
    // This is the fact the bug rested on. Asserted directly so the reason the wait
    // exists cannot quietly stop being true.
    const stream = streamSource();
    await stream.start(() => undefined);
    expect(stream.healthy).toBe(false);
    await stream.stop();
  });

  it("boots on a correct configuration once the handshake completes", async () => {
    const stream = streamSource();
    await stream.start(() => undefined);

    const startup = await resolveStartupCoverage({
      sources: [poller, stream],
      allowPartialCoverage: false,
      connectTimeoutMs: 2_000,
    });

    expect(startup.coverage).toBe("full");
    expect(startup.adequate).toBe(true);
    await stream.stop();
  });

  it("still refuses when the stream never opens", async () => {
    const previous = DeferredSocket.openAfterMs;
    DeferredSocket.openAfterMs = 10_000;
    try {
      const stream = streamSource();
      await stream.start(() => undefined);

      const startup = await resolveStartupCoverage({
        sources: [poller, stream],
        allowPartialCoverage: false,
        connectTimeoutMs: 100,
      });

      expect(startup.coverage).toBe("partial");
      expect(startup.adequate).toBe(false);
      expect(startup.waitingFor).toContain("stream");
      await stream.stop();
    } finally {
      DeferredSocket.openAfterMs = previous;
    }
  });
});
