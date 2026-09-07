/**
 * When the polling backstop counts as stalled.
 *
 * Found on a live run: with `BONDED_POLL_INTERVAL_MS=3000` the health window was six
 * seconds, while one poll pass could take far longer — four retry attempts at a
 * ten-second timeout, per symbol, sequentially. The source was judged dead while it was
 * still working, and because `auditPath` is an authority clause the gate then refused
 * every order with "no order source is delivering". On camera that turns an intended
 * `DENIED maxNotionalUsd` into a confusing `DENIED auditPath`.
 *
 * Two things fix it, and both are asserted here: a poll no longer retries inside the
 * call (the interval is the retry), and the staleness window can never be shorter than
 * one pass can legitimately take.
 */

import { describe, expect, it } from "vitest";
import { ok } from "../../src/core/result.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import { PollingOrderSource } from "../../src/reconcile/order-source.js";
import type { BinanceClient } from "../../src/binance/client.js";
import type { Clock } from "../../src/core/clock.js";

/** A clock the test moves by hand, so no assertion depends on wall time. */
function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Records the options each `allOrders` call was made with. */
function recordingClient(): BinanceClient & { calls: { retry?: boolean }[] } {
  const calls: { retry?: boolean }[] = [];
  const client = {
    calls,
    allOrders: (_symbol: string, options: { retry?: boolean } = {}) => {
      calls.push(options);
      return Promise.resolve(ok([]));
    },
  };
  return client as unknown as BinanceClient & { calls: { retry?: boolean }[] };
}

function source(intervalMs: number, clock: Clock, client: BinanceClient): PollingOrderSource {
  return new PollingOrderSource({
    client,
    clock,
    logger: createSilentLogger(),
    symbols: ["BTCUSDT", "ETHUSDT"],
    intervalMs,
  });
}

describe("the poll does not retry inside the call", () => {
  it("asks the client not to retry, because the interval is the retry", async () => {
    const client = recordingClient();
    const poll = source(3_000, fakeClock(), client);
    await poll.poll(() => undefined);

    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((c) => c.retry === false)).toBe(true);
  });
});

describe("how long a source may go quiet before it counts as stalled", () => {
  it("does not call a source dead inside the window one pass can take", async () => {
    // The case that shipped: a 3s interval gave a 6s window. Ten seconds of silence is
    // well within a single legitimate pass, and used to report the audit path as lost.
    const clock = fakeClock();
    const poll = source(3_000, clock, recordingClient());
    await poll.poll(() => undefined);
    expect(poll.healthy).toBe(true);

    clock.advance(10_000);
    expect(poll.healthy).toBe(true);
  });

  it("still calls it dead once the floor is genuinely exceeded", async () => {
    // Fail-closed is preserved: this loosens a window that was wrong, it does not
    // remove the check. A source silent for over 30s has lost the account.
    const clock = fakeClock();
    const poll = source(3_000, clock, recordingClient());
    await poll.poll(() => undefined);

    clock.advance(31_000);
    expect(poll.healthy).toBe(false);
  });

  it("leaves the default interval's window exactly as it was", async () => {
    // 15_000 * 2 == 30_000 == the floor, so nothing changes for a default deployment.
    const clock = fakeClock();
    const poll = source(15_000, clock, recordingClient());
    await poll.poll(() => undefined);

    clock.advance(29_000);
    expect(poll.healthy).toBe(true);
    clock.advance(2_000);
    expect(poll.healthy).toBe(false);
  });

  it("still widens the window for an interval longer than the floor", async () => {
    const clock = fakeClock();
    const poll = source(60_000, clock, recordingClient());
    await poll.poll(() => undefined);

    clock.advance(100_000);
    expect(poll.healthy).toBe(true);
    clock.advance(30_000);
    expect(poll.healthy).toBe(false);
  });

  it("is unhealthy before it has ever succeeded", () => {
    expect(source(3_000, fakeClock(), recordingClient()).healthy).toBe(false);
  });
});

describe("how far back the first poll reaches", () => {
  /**
   * A fresh instance with an empty decision log inherits whatever window it is given.
   * At the 24-hour default it replays a day of the account's real history it holds no
   * records for, so every order the operator legitimately authorised in that window
   * classifies as UNKNOWN_AUTHENTIC — a valid tag with no matching record — and burns
   * the bond before the instance has done anything.
   *
   * The red team hit exactly that: all four gate attacks came back `DENIED scope`
   * rather than `maxNotionalUsd`, `symbolAllowlist`, `lotSize` and `priceFilter`. Four
   * rows that read as passes while testing nothing at all.
   */
  it("honours the configured lookback for the first pass", async () => {
    const clock = fakeClock();
    const seen: (number | undefined)[] = [];
    const client = {
      allOrders: (_symbol: string, options: { startTime?: number } = {}) => {
        seen.push(options.startTime);
        return Promise.resolve(ok([]));
      },
    } as unknown as BinanceClient;

    const poll = new PollingOrderSource({
      client,
      clock,
      logger: createSilentLogger(),
      symbols: ["BTCUSDT"],
      intervalMs: 5_000,
      lookbackMs: 60_000,
    });
    await poll.start(() => undefined);
    await poll.stop();

    expect(seen[0]).toBe(clock.now() - 60_000);
  });

  it("defaults to a day, which is right for an operator restarting a real instance", async () => {
    const clock = fakeClock();
    const seen: (number | undefined)[] = [];
    const client = {
      allOrders: (_symbol: string, options: { startTime?: number } = {}) => {
        seen.push(options.startTime);
        return Promise.resolve(ok([]));
      },
    } as unknown as BinanceClient;

    const poll = new PollingOrderSource({
      client,
      clock,
      logger: createSilentLogger(),
      symbols: ["BTCUSDT"],
      intervalMs: 5_000,
    });
    await poll.start(() => undefined);
    await poll.stop();

    expect(seen[0]).toBe(clock.now() - 24 * 60 * 60 * 1000);
  });
});

describe("the lookback window is enforced locally, not just requested", () => {
  /**
   * Found on a live run the night before recording. A fresh instance started with
   * `BONDED_LOOKBACK_MS=60000` — confirmed applied in its own config line — still came
   * up BURNED, citing thirteen orders placed roughly forty minutes earlier. The first
   * pass did send `startTime = now - 60000`; the exchange returned older orders anyway.
   *
   * `GET /api/v3/allOrders` does not document which timestamp its `startTime` filters
   * on, so treating the response as pre-filtered made `BONDED_LOOKBACK_MS` decorative:
   * an operator could set any window and still have the account's whole recent history
   * replayed against an empty decision log, where every row is a finding.
   */
  function orderAt(observedAtMs: number, orderId: number): Record<string, unknown> {
    return {
      symbol: "BTCUSDT",
      orderId,
      clientOrderId: `probe_${String(orderId)}`,
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      price: "100.00",
      origQty: "1.00",
      executedQty: "1.00",
      updateTime: observedAtMs,
    };
  }

  function sourceOver(
    clock: Clock,
    rows: Record<string, unknown>[],
    lookbackMs: number,
  ): PollingOrderSource {
    const client = {
      allOrders: () => Promise.resolve(ok(rows)),
    } as unknown as BinanceClient;
    return new PollingOrderSource({
      client,
      clock,
      logger: createSilentLogger(),
      symbols: ["BTCUSDT"],
      intervalMs: 5_000,
      lookbackMs,
    });
  }

  it("ignores orders the exchange returns from before the window", async () => {
    const clock = fakeClock();
    const now = clock.now();
    const poll = sourceOver(
      clock,
      [orderAt(now - 40 * 60 * 1000, 1), orderAt(now - 10_000, 2)],
      60_000,
    );

    const seen: number[] = [];
    await poll.start((orders) => {
      for (const order of orders) seen.push(order.orderId);
    });
    await poll.stop();

    expect(seen).toEqual([2]);
  });

  it("burns nothing when every order the exchange returns is outside the window", async () => {
    // The exact shape of the live failure: a clean decision log, a 60-second window,
    // and an account whose recent history all predates it. Nothing should reach the
    // reconciler at all.
    const clock = fakeClock();
    const now = clock.now();
    const poll = sourceOver(clock, [orderAt(now - 40 * 60 * 1000, 1)], 60_000);

    let called = false;
    await poll.start(() => {
      called = true;
    });
    await poll.stop();

    expect(called).toBe(false);
  });

  it("keeps an order it cannot date, because an undateable order is not a safe one", async () => {
    const clock = fakeClock();
    const undated = orderAt(0, 3);
    delete undated["updateTime"];
    const poll = sourceOver(clock, [undated], 60_000);

    const seen: number[] = [];
    await poll.start((orders) => {
      for (const order of orders) seen.push(order.orderId);
    });
    await poll.stop();

    expect(seen).toEqual([3]);
  });

  it("still reports everything inside a wide window", async () => {
    // The guard must not become a second, quieter way to go blind: at the 24-hour
    // default the same forty-minute-old order is squarely in scope.
    const clock = fakeClock();
    const now = clock.now();
    const poll = sourceOver(clock, [orderAt(now - 40 * 60 * 1000, 1)], 24 * 60 * 60 * 1000);

    const seen: number[] = [];
    await poll.start((orders) => {
      for (const order of orders) seen.push(order.orderId);
    });
    await poll.stop();

    expect(seen).toEqual([1]);
  });

  it("holds the window fixed across passes rather than letting it slide", async () => {
    // The window is the run's, not the poll's. An order placed just after start()
    // stays in scope on later passes instead of ageing out of a window that moves
    // with wall time.
    const clock = fakeClock();
    const placedAtMs = clock.now();
    const rows: Record<string, unknown>[] = [];
    const client = {
      allOrders: () => Promise.resolve(ok(rows)),
    } as unknown as BinanceClient;
    const poll = new PollingOrderSource({
      client,
      clock,
      logger: createSilentLogger(),
      symbols: ["BTCUSDT"],
      intervalMs: 5_000,
      lookbackMs: 60_000,
    });

    const seen: number[] = [];
    await poll.start((orders) => {
      for (const order of orders) seen.push(order.orderId);
    });

    rows.push(orderAt(placedAtMs, 7));
    clock.advance(120_000);
    await poll.poll((orders) => {
      for (const order of orders) seen.push(order.orderId);
    });
    await poll.stop();

    expect(seen).toEqual([7]);
  });
});
