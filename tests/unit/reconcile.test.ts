/**
 * Reconciliation tests.
 *
 * These cover the component whose output burns the bond, so they are written from the
 * attacker's side: for each way of getting an order onto the account without a valid
 * authorisation, assert that it is caught and classified correctly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DecisionLog } from "../../src/audit/decision-log.js";
import { mintClientOrderId } from "../../src/audit/client-order-id.js";
import { FixedClock } from "../../src/core/clock.js";
import { decimalUnsafe } from "../../src/core/money.js";
import { ok, unwrap } from "../../src/core/result.js";
import type { DecisionRecord } from "../../src/domain/decision.js";
import type { OrderIntent } from "../../src/domain/intent.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import { AuthorisationIndex } from "../../src/reconcile/authorisation-index.js";
import { ReconciliationOutcome, classify, type Finding } from "../../src/reconcile/classify.js";
import {
  parseAllOrders,
  parseExecutionReport,
  type ObservedOrder,
} from "../../src/reconcile/observed-order.js";
import { Reconciler } from "../../src/reconcile/reconciler.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const SECRET = "s".repeat(64);
const MANDATE = "b3f1".repeat(16);

const INTENT: OrderIntent = {
  kind: "LIMIT",
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: decimalUnsafe("0.1"),
  price: decimalUnsafe("2000"),
};

function authorisedRecord(seq: number, intent: OrderIntent = INTENT): DecisionRecord {
  return {
    seq,
    prevHash: "0".repeat(64),
    ts: new Date(NOW).toISOString(),
    mandateHash: MANDATE,
    intent,
    outcome: "ALLOW",
    clientOrderId: unwrap(mintClientOrderId(SECRET, MANDATE, seq), "mint"),
  };
}

function observed(overrides: Partial<ObservedOrder> = {}): ObservedOrder {
  return {
    symbol: "ETHUSDT",
    orderId: 28461173,
    clientOrderId: "",
    side: "BUY",
    type: "LIMIT",
    status: "FILLED",
    price: decimalUnsafe("2000"),
    origQty: decimalUnsafe("0.1"),
    cummulativeQuoteQty: decimalUnsafe("0"),
    timeInForce: "GTC",
    executedQty: decimalUnsafe("0.1"),
    observedAtMs: NOW,
    source: "stream",
    ...overrides,
  };
}

describe("classify", () => {
  const index = new AuthorisationIndex();
  const record = authorisedRecord(7);
  index.record(record);

  function run(order: ObservedOrder) {
    return classify({
      order,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      authorisation: index.lookup(order.clientOrderId),
    });
  }

  it("accepts an order that matches its authorisation", () => {
    const finding = run(observed({ clientOrderId: record.clientOrderId! }));
    expect(finding.outcome).toBe(ReconciliationOutcome.AUTHORISED);
    expect(finding.authorisation?.seq).toBe(7);
  });

  describe("bypass", () => {
    it("flags an order with no BONDED identifier", () => {
      const finding = run(observed({ clientOrderId: "web_a1b2c3d4" }));
      expect(finding.outcome).toBe(ReconciliationOutcome.FOREIGN);
      expect(finding.reference).toEqual({ symbol: "ETHUSDT", orderId: 28461173 });
      // The honest limit is stated in the finding itself, not only in the README.
      expect(finding.uncertainty.join(" ")).toContain("after the fact");
    });

    it("flags an order with an empty client id", () => {
      const finding = run(observed({ clientOrderId: "" }));
      expect(finding.outcome).toBe(ReconciliationOutcome.FOREIGN);
      expect(finding.explanation).toContain("no client order id");
    });

    it("flags a forged identifier more severely than a foreign one", () => {
      const authentic = record.clientOrderId!;
      const forged = `${authentic.slice(0, -1)}${authentic.endsWith("0") ? "1" : "0"}`;
      const finding = run(observed({ clientOrderId: forged }));
      expect(finding.outcome).toBe(ReconciliationOutcome.FORGED);
      expect(finding.explanation).toContain("does not verify");
    });

    it("flags a valid tag with no matching record", () => {
      // Either the log was truncated or a second instance shares the secret. Both need
      // investigating; neither may be silently accepted.
      const orphan = unwrap(mintClientOrderId(SECRET, MANDATE, 999), "mint");
      const finding = run(observed({ clientOrderId: orphan }));
      expect(finding.outcome).toBe(ReconciliationOutcome.UNKNOWN_AUTHENTIC);
    });
  });

  describe("parameter binding", () => {
    it("flags an order whose quantity differs from the authorisation", () => {
      const finding = run(
        observed({ clientOrderId: record.clientOrderId!, origQty: decimalUnsafe("5") }),
      );
      expect(finding.outcome).toBe(ReconciliationOutcome.MISMATCHED);
      expect(finding.explanation).toContain("quantity: authorised 0.1, executed 5");
    });

    it("flags a changed side", () => {
      const finding = run(observed({ clientOrderId: record.clientOrderId!, side: "SELL" }));
      expect(finding.outcome).toBe(ReconciliationOutcome.MISMATCHED);
    });

    it("flags a changed limit price", () => {
      const finding = run(
        observed({ clientOrderId: record.clientOrderId!, price: decimalUnsafe("1") }),
      );
      expect(finding.outcome).toBe(ReconciliationOutcome.MISMATCHED);
    });

    it("ignores the reported price on a market order", () => {
      // Binance reports price 0 for market orders; comparing it would be a false positive.
      const marketIndex = new AuthorisationIndex();
      const marketRecord = authorisedRecord(1, {
        kind: "MARKET_BASE",
        symbol: "ETHUSDT",
        side: "BUY",
        quantity: decimalUnsafe("0.1"),
      });
      marketIndex.record(marketRecord);
      const finding = classify({
        order: observed({
          clientOrderId: marketRecord.clientOrderId!,
          type: "MARKET",
          price: decimalUnsafe("0"),
        }),
        hmacSecret: SECRET,
        mandateHash: MANDATE,
        authorisation: marketIndex.lookup(marketRecord.clientOrderId!),
      });
      expect(finding.outcome).toBe(ReconciliationOutcome.AUTHORISED);
    });

    it("treats equal values with different precision as equal", () => {
      // Binance pads to 8 decimals; string comparison would report a false mismatch.
      const finding = run(
        observed({
          clientOrderId: record.clientOrderId!,
          origQty: decimalUnsafe("0.10000000"),
          price: decimalUnsafe("2000.00000000"),
        }),
      );
      expect(finding.outcome).toBe(ReconciliationOutcome.AUTHORISED);
    });
  });

  it("notes reduced confidence for a polled observation", () => {
    const finding = run(observed({ clientOrderId: record.clientOrderId!, source: "poll" }));
    expect(finding.uncertainty.join(" ")).toContain("polling");
  });
});

describe("Reconciler", () => {
  let index: AuthorisationIndex;
  let reconciler: Reconciler;
  let onFinding: Mock<(finding: Finding) => void>;

  beforeEach(() => {
    index = new AuthorisationIndex();
    onFinding = vi.fn<(finding: Finding) => void>();
    reconciler = new Reconciler({
      index,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      clock: new FixedClock(NOW),
      logger: createSilentLogger(),
      onFinding,
    });
  });

  it("raises a finding and notifies once for a bypass", () => {
    reconciler.observe(observed({ clientOrderId: "web_bypass" }));
    expect(onFinding).toHaveBeenCalledTimes(1);
    expect(reconciler.compromised).toBe(true);
    expect(reconciler.worstOutcome).toBe(ReconciliationOutcome.FOREIGN);
  });

  it("does not re-report an order seen twice", () => {
    // The stream and the poll deliberately overlap; duplicate alerts are how an
    // alerting channel becomes noise nobody reads.
    const order = observed({ clientOrderId: "web_bypass" });
    reconciler.observe(order);
    reconciler.observe({ ...order, source: "poll" });
    expect(onFinding).toHaveBeenCalledTimes(1);
    expect(reconciler.stats.observed).toBe(1);
  });

  it("stays quiet for an order it authorised", () => {
    const record = authorisedRecord(0);
    reconciler.authorise(record);
    reconciler.observe(observed({ clientOrderId: record.clientOrderId! }));
    expect(onFinding).not.toHaveBeenCalled();
    expect(reconciler.compromised).toBe(false);
    expect(reconciler.stats.authorised).toBe(1);
  });

  it("orders findings by severity, worst first", () => {
    const authentic = unwrap(mintClientOrderId(SECRET, MANDATE, 3), "mint");
    const forged = `${authentic.slice(0, -1)}${authentic.endsWith("0") ? "1" : "0"}`;

    reconciler.observe(observed({ orderId: 1, clientOrderId: "web_bypass" }));
    reconciler.observe(observed({ orderId: 2, clientOrderId: forged }));

    expect(reconciler.findings[0]!.outcome).toBe(ReconciliationOutcome.FORGED);
    expect(reconciler.findings[1]!.outcome).toBe(ReconciliationOutcome.FOREIGN);
  });

  it("keeps the finding when the handler throws", () => {
    onFinding.mockImplementation(() => {
      throw new Error("handler exploded");
    });
    expect(() => reconciler.observe(observed({ clientOrderId: "web_bypass" }))).not.toThrow();
    expect(reconciler.compromised).toBe(true);
  });

  it("does not treat an order authorised before a restart as a bypass", async () => {
    // Index rebuilt from the decision log rather than from process memory.
    const dir = await mkdtemp(join(tmpdir(), "bonded-reconcile-"));
    const logPath = join(dir, "decisions.jsonl");
    try {
      const log = unwrap(await DecisionLog.open(logPath), "open");
      const appended = await log.appendWith((seq) =>
        ok({
          ts: new Date(NOW).toISOString(),
          mandateHash: MANDATE,
          intent: INTENT,
          outcome: "ALLOW" as const,
          clientOrderId: unwrap(mintClientOrderId(SECRET, MANDATE, seq), "mint"),
        }),
      );
      await log.close();
      const clientOrderId = unwrap(appended, "append").clientOrderId!;

      const rebuilt = new AuthorisationIndex();
      expect(unwrap(await rebuilt.loadFromLog(logPath), "replay")).toBe(1);

      const afterRestart = new Reconciler({
        index: rebuilt,
        hmacSecret: SECRET,
        mandateHash: MANDATE,
        clock: new FixedClock(NOW),
        logger: createSilentLogger(),
        onFinding,
      });
      afterRestart.observe(observed({ clientOrderId }));
      expect(onFinding).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("wire format parsing", () => {
  it("normalises an executionReport", () => {
    const event = {
      e: "executionReport",
      E: NOW,
      s: "ETHUSDT",
      c: "bnd_ed1ff01a_7_abc123def456",
      S: "BUY",
      o: "LIMIT",
      q: "0.10000000",
      p: "2000.00000000",
      X: "FILLED",
      i: 28461173,
      z: "0.10000000",
    };
    const parsed = unwrap(parseExecutionReport(event), "parse");
    expect(parsed).toMatchObject({
      symbol: "ETHUSDT",
      orderId: 28461173,
      clientOrderId: "bnd_ed1ff01a_7_abc123def456",
      status: "FILLED",
      source: "stream",
    });
  });

  it("rejects a malformed executionReport rather than guessing", () => {
    expect(parseExecutionReport({ e: "executionReport", s: "ETHUSDT" }).ok).toBe(false);
  });

  it("ignores non-order events", () => {
    expect(parseExecutionReport({ e: "outboundAccountPosition", E: NOW }).ok).toBe(false);
  });

  it("normalises an allOrders response", () => {
    const orders = unwrap(
      parseAllOrders([
        {
          symbol: "ETHUSDT",
          orderId: 99,
          clientOrderId: "web_x",
          side: "SELL",
          type: "MARKET",
          status: "FILLED",
          price: "0.00000000",
          origQty: "1.00000000",
          executedQty: "1.00000000",
          updateTime: NOW,
        },
      ]),
      "parse",
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: 99, source: "poll", side: "SELL" });
  });

  it("rejects a non-array allOrders payload", () => {
    expect(parseAllOrders({ code: -1121 }).ok).toBe(false);
  });
});

describe("classification robustness", () => {
  /**
   * The audit's H1'. `classify` documents "never throws", and it did: the switch in
   * `authorisedParameters` was exhaustive over today's union but is also fed records
   * replayed from a log written by another version, where an unknown kind fell through
   * and returned undefined for the caller to dereference.
   */
  it("does not throw on an authorisation whose intent it cannot read", () => {
    const record = authorisedRecord(9);
    const alien = {
      ...record,
      intent: { kind: "STOP_LIMIT", symbol: "ETHUSDT", side: "BUY" },
    } as unknown as DecisionRecord;

    const index = new AuthorisationIndex();
    index.record(alien);

    const order = observed({ clientOrderId: alien.clientOrderId ?? "" });
    let finding: Finding | undefined;
    expect(() => {
      finding = classify({
        order,
        hmacSecret: SECRET,
        mandateHash: MANDATE,
        authorisation: index.lookup(order.clientOrderId),
      });
    }).not.toThrow();
    // And it does not wave the order through either.
    expect(finding?.outcome).toBe(ReconciliationOutcome.MISMATCHED);
  });

  it("reconciles the size of a quote-denominated market order", () => {
    // The audit's M1'. Only symbol, side and type were bound, so an authorisation to
    // spend 100 USDT matched an order that spent 100,000 and read as AUTHORISED.
    const intent: OrderIntent = {
      kind: "MARKET_QUOTE",
      symbol: "ETHUSDT",
      side: "BUY",
      quoteOrderQty: decimalUnsafe("100"),
    };
    const record = authorisedRecord(11, intent);
    const index = new AuthorisationIndex();
    index.record(record);

    const overspent = observed({
      clientOrderId: record.clientOrderId ?? "",
      type: "MARKET",
      cummulativeQuoteQty: decimalUnsafe("100000"),
    });
    const finding = classify({
      order: overspent,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      authorisation: index.lookup(overspent.clientOrderId),
    });
    expect(finding.outcome).toBe(ReconciliationOutcome.MISMATCHED);
    expect(finding.explanation).toContain("quoteOrderQty");
  });

  it("says so when the source reported no quote amount to check", () => {
    // Found reviewing the fix above: defaulting the absent field to "0" made it read as
    // "spent nothing", which passes every overspend check there is — silently
    // reinstating the gap the fix had just closed. Absent is not zero.
    const intent: OrderIntent = {
      kind: "MARKET_QUOTE",
      symbol: "ETHUSDT",
      side: "BUY",
      quoteOrderQty: decimalUnsafe("100"),
    };
    const record = authorisedRecord(13, intent);
    const index = new AuthorisationIndex();
    index.record(record);

    const unreported = observed({ clientOrderId: record.clientOrderId ?? "", type: "MARKET" });
    delete (unreported as { cummulativeQuoteQty?: unknown }).cummulativeQuoteQty;

    const finding = classify({
      order: unreported,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      authorisation: index.lookup(unreported.clientOrderId),
    });
    // Not a mismatch — a missing field is not evidence of an overspend — but the
    // finding must not imply the size was verified.
    expect(finding.outcome).toBe(ReconciliationOutcome.AUTHORISED);
    expect(finding.uncertainty.join(" ")).toContain("was not checked");
  });

  it("accepts a quote-denominated order that spent no more than authorised", () => {
    // Binance may spend slightly less when it cannot buy a whole lot. Underspend is
    // normal; only overspend is a mismatch.
    const intent: OrderIntent = {
      kind: "MARKET_QUOTE",
      symbol: "ETHUSDT",
      side: "BUY",
      quoteOrderQty: decimalUnsafe("100"),
    };
    const record = authorisedRecord(12, intent);
    const index = new AuthorisationIndex();
    index.record(record);

    const order = observed({
      clientOrderId: record.clientOrderId ?? "",
      type: "MARKET",
      cummulativeQuoteQty: decimalUnsafe("99.87"),
    });
    const finding = classify({
      order,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      authorisation: index.lookup(order.clientOrderId),
    });
    expect(finding.outcome).toBe(ReconciliationOutcome.AUTHORISED);
  });
});

describe("batch isolation", () => {
  // The audit's H2'. `#seen` was populated before classification, so a failure marked
  // the order seen and it was never re-examined; and `observeAll` had no per-order
  // isolation, so one bad order aborted the batch — inside a poll timer, where the
  // escaping rejection takes the process down.
  it("keeps classifying after one order fails", () => {
    const index = new AuthorisationIndex();
    const record = authorisedRecord(21);
    index.record(record);

    const findings: Finding[] = [];
    const reconciler = new Reconciler({
      index,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      clock: new FixedClock(NOW),
      logger: createSilentLogger(),
      onFinding: (finding) => findings.push(finding),
    });

    // A getter that throws stands in for any failure inside classification.
    const poison = observed({ orderId: 1 });
    Object.defineProperty(poison, "clientOrderId", {
      get() {
        throw new Error("boom");
      },
    });
    const bypass = observed({ orderId: 2, clientOrderId: "", source: "poll" });

    const results = reconciler.observeAll([poison, bypass]);

    // The bypass after the poison order is still found.
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe(ReconciliationOutcome.FOREIGN);
    expect(findings).toHaveLength(1);
  });

  it("re-examines an order whose first classification failed", () => {
    const index = new AuthorisationIndex();
    const reconciler = new Reconciler({
      index,
      hmacSecret: SECRET,
      mandateHash: MANDATE,
      clock: new FixedClock(NOW),
      logger: createSilentLogger(),
      onFinding: () => undefined,
    });

    let failures = 1;
    const flaky = observed({ orderId: 3, clientOrderId: "", source: "poll" });
    const key = { ...flaky };
    Object.defineProperty(flaky, "clientOrderId", {
      get() {
        if (failures-- > 0) throw new Error("transient");
        return "";
      },
    });

    expect(reconciler.observeAll([flaky])).toHaveLength(0);
    // The poller re-delivers it. Before the fix this returned nothing forever, because
    // the order had already been added to the seen set.
    expect(reconciler.observeAll([key])).toHaveLength(1);
  });
});
