/**
 * What BONDED does when Binance removes an endpoint underneath it.
 *
 * Found on a real machine, not in a stub: `POST /api/v3/userDataStream` answers
 * **410 Gone** on Spot Testnet. Binance removed the listen-key REST endpoints in
 * February 2026. Before this, BONDED retried that permanently-dead endpoint every ten
 * seconds forever and reported "still retrying" — telling an operator to wait for a
 * recovery that cannot happen, with the actual cause buried in a log line.
 *
 * Two things have to hold. A gone endpoint must be recognised as permanent, and the
 * boot banner must say so instead of describing it as a slow connection.
 */

import { describe, expect, it } from "vitest";
import { ErrorCode, bondedError } from "../../src/core/errors.js";
import { err, ok } from "../../src/core/result.js";
import { systemClock } from "../../src/core/clock.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import { resolveStartupCoverage } from "../../src/reconcile/audit-path.js";
import { UserDataStreamSource, type OrderSource } from "../../src/reconcile/order-source.js";
import type { BinanceClient } from "../../src/binance/client.js";

/** A client whose listen-key endpoint answers with the given HTTP status. */
function clientReturning(status: number): BinanceClient {
  let calls = 0;
  return {
    createListenKey: () => {
      calls++;
      return Promise.resolve(
        err(
          bondedError(ErrorCode.EXCHANGE_HTTP, "binance returned an error", {
            path: "/api/v3/userDataStream",
            status,
          }),
        ),
      );
    },
    keepAliveListenKey: () => Promise.resolve(ok(undefined)),
    closeListenKey: () => Promise.resolve(ok(undefined)),
    get callCount(): number {
      return calls;
    },
  } as unknown as BinanceClient;
}

function streamSource(status: number): UserDataStreamSource {
  return new UserDataStreamSource({
    client: clientReturning(status),
    clock: systemClock,
    logger: createSilentLogger(),
    streamBaseUrl: "wss://stream.testnet.binance.vision/ws",
    reconnectDelayMs: 10,
  });
}

describe("an endpoint Binance has removed", () => {
  it("is reported as permanently unavailable, naming the cause", async () => {
    const source = streamSource(410);
    await source.start(() => undefined);

    expect(source.healthy).toBe(false);
    expect(source.unavailableReason).toBeDefined();
    expect(source.unavailableReason).toContain("410");
    expect(source.unavailableReason).toContain("polling");
    await source.stop();
  });

  it("does not spend the caller's whole timeout waiting for it", async () => {
    // The boot path gives the stream a connect budget. Burning all of it on a socket
    // that a removed endpoint means will never open just delays startup.
    const source = streamSource(410);
    await source.start(() => undefined);

    const started = Date.now();
    expect(await source.waitUntilHealthy(5_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    await source.stop();
  });

  it("still treats an ordinary failure as transient", async () => {
    // A 500 is Binance having a bad minute, not an endpoint that is gone. It must keep
    // retrying, and must NOT claim to be permanently unavailable.
    const source = streamSource(500);
    await source.start(() => undefined);

    expect(source.unavailableReason).toBeUndefined();
    await source.stop();
  });
});

describe("what the boot banner says about it", () => {
  function fixedSource(over: Partial<OrderSource>): OrderSource {
    return {
      name: "stream",
      coverage: "account",
      healthy: false,
      lastHealthyAtMs: undefined,
      waitUntilHealthy: () => Promise.resolve(false),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      ...over,
    };
  }

  it("surfaces the reason a source gives, rather than only its name", async () => {
    const startup = await resolveStartupCoverage({
      sources: [fixedSource({ unavailableReason: "Binance removed it (410 Gone)." })],
      allowPartialCoverage: false,
      connectTimeoutMs: 10,
    });

    expect(startup.unavailable).toEqual(["Binance removed it (410 Gone)."]);
    expect(startup.waitingFor).toEqual(["stream"]);
  });

  it("reports no reason when a source is merely slow", async () => {
    const startup = await resolveStartupCoverage({
      sources: [fixedSource({})],
      allowPartialCoverage: false,
      connectTimeoutMs: 10,
    });

    expect(startup.unavailable).toEqual([]);
    expect(startup.waitingFor).toEqual(["stream"]);
  });
});
