/**
 * The audit's H1: a healthy source is not the same as an adequate one.
 *
 * The polling backstop can only ask `allOrders` about symbols it was given, so an order
 * on any other symbol is invisible to it. Treating it as equivalent to the account-wide
 * stream let BONDED report a healthy audit path while being structurally unable to see
 * the simplest evasion available: trade a pair the mandate never mentioned.
 */

import { describe, expect, it } from "vitest";
import {
  currentCoverage,
  describeCoverage,
  isAuditPathAdequate,
  resolveStartupCoverage,
} from "../../src/reconcile/audit-path.js";
import type { OrderSource, OrderSourceCoverage } from "../../src/reconcile/order-source.js";

function source(name: string, coverage: OrderSourceCoverage, healthy: boolean): OrderSource {
  return {
    name,
    coverage,
    healthy,
    lastHealthyAtMs: healthy ? 1 : undefined,
    waitUntilHealthy: () => Promise.resolve(healthy),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

const poller = (healthy: boolean) => source("poll", "symbols", healthy);
const stream = (healthy: boolean) => source("stream", "account", healthy);

describe("currentCoverage", () => {
  it("is full when an account-wide source is live", () => {
    expect(currentCoverage([poller(true), stream(true)])).toBe("full");
  });

  it("is full on the account-wide source alone", () => {
    expect(currentCoverage([poller(false), stream(true)])).toBe("full");
  });

  it("is partial when only the symbol-scoped source is live", () => {
    expect(currentCoverage([poller(true), stream(false)])).toBe("partial");
  });

  it("is none when nothing is delivering", () => {
    expect(currentCoverage([poller(false), stream(false)])).toBe("none");
  });

  it("is none with no sources at all", () => {
    expect(currentCoverage([])).toBe("none");
  });
});

describe("isAuditPathAdequate", () => {
  it("permits trading on full coverage", () => {
    const sources = [poller(true), stream(true)];
    expect(isAuditPathAdequate({ sources, allowPartialCoverage: false })).toBe(true);
  });

  it("halts trading on partial coverage by default", () => {
    // The regression. `sources.some(s => s.healthy)` returned true here.
    const sources = [poller(true), stream(false)];
    expect(isAuditPathAdequate({ sources, allowPartialCoverage: false })).toBe(false);
  });

  it("permits partial coverage only when the operator opted in", () => {
    const sources = [poller(true), stream(false)];
    expect(isAuditPathAdequate({ sources, allowPartialCoverage: true })).toBe(true);
  });

  it("never permits trading with no coverage, opt-in or not", () => {
    const sources = [poller(false), stream(false)];
    expect(isAuditPathAdequate({ sources, allowPartialCoverage: true })).toBe(false);
    expect(isAuditPathAdequate({ sources, allowPartialCoverage: false })).toBe(false);
  });
});

describe("describeCoverage", () => {
  it("says plainly that partial coverage has a blind spot", () => {
    expect(describeCoverage("partial", true)).toContain("Orders on other symbols");
  });

  it("does not describe degraded coverage as healthy", () => {
    expect(describeCoverage("partial", false)).toContain("DEGRADED");
    expect(describeCoverage("none", false)).toBe("no source is delivering");
  });
});

describe("resolveStartupCoverage", () => {
  /**
   * The audit's C1. A websocket handshake completes on a later turn of the event loop,
   * so the first version of this decision — taken inline in cli.ts the instant start()
   * returned — read every stream as dead and refused to boot on a correct config.
   */
  function slowSource(openAfterMs: number): OrderSource {
    let open = false;
    setTimeout(() => {
      open = true;
    }, openAfterMs);
    return {
      name: "stream",
      coverage: "account",
      get healthy() {
        return open;
      },
      get lastHealthyAtMs() {
        return open ? 1 : undefined;
      },
      waitUntilHealthy: async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (!open && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return open;
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  }

  it("waits for a stream that is still shaking hands", async () => {
    const sources = [poller(true), slowSource(40)];
    const startup = await resolveStartupCoverage({
      sources,
      allowPartialCoverage: false,
      connectTimeoutMs: 1_000,
    });
    expect(startup.coverage).toBe("full");
    expect(startup.adequate).toBe(true);
    expect(startup.waitingFor).toEqual([]);
  });

  it("gives up after the timeout and reports what it is still waiting for", async () => {
    const sources = [poller(true), slowSource(10_000)];
    const startup = await resolveStartupCoverage({
      sources,
      allowPartialCoverage: false,
      connectTimeoutMs: 30,
    });
    expect(startup.coverage).toBe("partial");
    expect(startup.adequate).toBe(false);
    expect(startup.waitingFor).toEqual(["stream"]);
  });

  it("permits degraded coverage when the operator opted in", async () => {
    const startup = await resolveStartupCoverage({
      sources: [poller(true), slowSource(10_000)],
      allowPartialCoverage: true,
      connectTimeoutMs: 30,
    });
    expect(startup.adequate).toBe(true);
    expect(startup.detail).toContain("Orders on other symbols");
  });

  it("waits for sources in parallel, not one budget each", async () => {
    const started = Date.now();
    await resolveStartupCoverage({
      sources: [slowSource(10_000), slowSource(10_000), slowSource(10_000)],
      allowPartialCoverage: true,
      connectTimeoutMs: 60,
    });
    // Three serial 60ms waits would be ~180ms.
    expect(Date.now() - started).toBeLessThan(150);
  });
});
