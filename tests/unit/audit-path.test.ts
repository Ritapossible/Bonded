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
} from "../../src/reconcile/audit-path.js";
import type { OrderSource, OrderSourceCoverage } from "../../src/reconcile/order-source.js";

function source(name: string, coverage: OrderSourceCoverage, healthy: boolean): OrderSource {
  return {
    name,
    coverage,
    healthy,
    lastHealthyAtMs: healthy ? 1 : undefined,
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
