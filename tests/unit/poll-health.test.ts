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
