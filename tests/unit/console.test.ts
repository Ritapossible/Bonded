/**
 * Console tests.
 *
 * Two things are worth testing here and the rest is presentation: that the server's
 * security posture holds (loopback only, read-only, no credentials in the payload),
 * and that a bond burn actually reaches a connected client.
 */

import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "../../src/core/clock.js";
import { decimalUnsafe } from "../../src/core/money.js";
import { unwrap } from "../../src/core/result.js";
import { ActivityFeed } from "../../src/console/activity.js";
import { ConsoleServer } from "../../src/console/server.js";
import { buildConsoleState } from "../../src/console/state.js";
import type { DecisionRecord } from "../../src/domain/decision.js";
import { compileMandate, type MandateSpec } from "../../src/domain/mandate.js";
import type { TradingEngine } from "../../src/engine/trading-engine.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import type { Finding } from "../../src/reconcile/classify.js";
import { ReconciliationOutcome } from "../../src/reconcile/classify.js";
import type { OrderSource } from "../../src/reconcile/order-source.js";
import type { Reconciler } from "../../src/reconcile/reconciler.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const SPEC: MandateSpec = {
  version: 1,
  env: "testnet",
  symbols: ["ETHUSDT"],
  orderTypes: ["LIMIT"],
  sides: ["BUY"],
  maxNotionalUsd: "500",
  maxOpenOrders: 2,
  dailyLossLimitUsd: "50",
  maxDrawdownPct: "5",
  tradingWindowUtc: ["00:00", "23:59"],
  expiresAt: "2026-09-08T23:59:00.000Z",
};

const mandate = unwrap(compileMandate(SPEC), "mandate");

const RECORD: DecisionRecord = {
  seq: 0,
  prevHash: "0".repeat(64),
  ts: new Date(NOW).toISOString(),
  mandateHash: mandate.hash,
  intent: {
    kind: "LIMIT",
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: decimalUnsafe("0.1"),
    price: decimalUnsafe("2000"),
  },
  outcome: "ALLOW",
  clientOrderId: "bnd_abcd1234_0_0123456789ab",
};

const FINDING: Finding = {
  outcome: ReconciliationOutcome.FOREIGN,
  explanation: "an order executed on this account that BONDED never authorised",
  evidence: {
    symbol: "ETHUSDT",
    orderId: 28461173,
    clientOrderId: "web_manual_1",
    side: "SELL",
    type: "MARKET",
    status: "FILLED",
    price: decimalUnsafe("0"),
    origQty: decimalUnsafe("5"),
    cummulativeQuoteQty: decimalUnsafe("0"),
    executedQty: decimalUnsafe("5"),
    observedAtMs: NOW,
    source: "stream",
  },
  reference: { symbol: "ETHUSDT", orderId: 28461173 },
  uncertainty: ["detection is after the fact"],
};

/** Minimal stand-ins: the console reads these, it does not drive them. */
function stubEngine(overrides: Partial<TradingEngine> = {}): TradingEngine {
  return {
    mandate,
    scopeRevoked: false,
    revocationReason: undefined,
    ...overrides,
  } as unknown as TradingEngine;
}

function stubReconciler(findings: Finding[] = []): Reconciler {
  return {
    stats: { observed: 3, authorised: 2, findings: findings.length, lastObservedAtMs: NOW },
    findings,
  } as unknown as Reconciler;
}

const stubSource = (name: string, healthy: boolean): OrderSource =>
  ({ name, healthy, lastHealthyAtMs: NOW }) as OrderSource;

describe("console state", () => {
  it("shows the mandate's thresholds, unlike the agent's view", () => {
    // The console is the owner's screen — they wrote the mandate, so hiding the
    // numbers from them would be theatre. The agent's summary omits them on purpose.
    const state = buildConsoleState({
      engine: stubEngine(),
      reconciler: stubReconciler(),
      feed: new ActivityFeed(),
      orderSources: [],
      env: "testnet",
      startedAtMs: NOW,
    });
    const notional = state.mandate.clauses.find((c) => c.name === "maxNotionalUsd");
    expect(notional?.value).toBe("500");
  });

  it("reports the bond as burned with its reason", () => {
    const state = buildConsoleState({
      engine: stubEngine({ scopeRevoked: true, revocationReason: "FOREIGN: bypass detected" }),
      reconciler: stubReconciler([FINDING]),
      feed: new ActivityFeed(),
      orderSources: [stubSource("stream", true), stubSource("poll", false)],
      env: "testnet",
      startedAtMs: NOW,
    });
    expect(state.bond).toEqual({ state: "BURNED", reason: "FOREIGN: bypass detected" });
    expect(state.reconciliation.sources).toEqual([
      { name: "stream", healthy: true },
      { name: "poll", healthy: false },
    ]);
    expect(state.findings[0]?.outcome).toBe("FOREIGN");
  });

  it("contains nothing that looks like a credential", () => {
    const feed = new ActivityFeed();
    feed.recordDecision(RECORD);
    feed.recordFinding(FINDING);
    const serialised = JSON.stringify(
      buildConsoleState({
        engine: stubEngine(),
        reconciler: stubReconciler([FINDING]),
        feed,
        orderSources: [],
        env: "testnet",
        startedAtMs: NOW,
      }),
    );
    for (const forbidden of ["apiKey", "secretKey", "hmacSecret", "signature", "X-MBX-APIKEY"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("ActivityFeed", () => {
  it("returns entries newest first", () => {
    const feed = new ActivityFeed();
    feed.recordDecision(RECORD);
    feed.recordFinding(FINDING);
    expect(feed.entries[0]?.kind).toBe("finding");
    expect(feed.entries[1]?.kind).toBe("decision");
  });

  it("drops the oldest entries past its capacity", () => {
    // It is a display buffer, not the audit trail — the log on disk is authoritative.
    const feed = new ActivityFeed(3);
    for (let seq = 0; seq < 10; seq++) feed.recordDecision({ ...RECORD, seq });
    expect(feed.entries).toHaveLength(3);
    expect((feed.entries[0] as { seq: number }).seq).toBe(9);
  });

  it("keeps delivering to other subscribers when one throws", () => {
    const feed = new ActivityFeed();
    const good = vi.fn();
    feed.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    feed.subscribe(good);
    feed.recordDecision(RECORD);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe", () => {
    const feed = new ActivityFeed();
    const listener = vi.fn();
    feed.subscribe(listener)();
    feed.recordDecision(RECORD);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ConsoleServer", () => {
  let server: ConsoleServer;
  let feed: ActivityFeed;
  let engine: TradingEngine;
  // A fresh port per test. fetch pools keep-alive sockets per host:port, so reusing one
  // port across tests hands the next test a connection to the server just shut down.
  let port = 7400;

  beforeEach(async () => {
    port += 1;
    feed = new ActivityFeed();
    engine = stubEngine();
    server = new ConsoleServer({
      port,
      logger: createSilentLogger(),
      engine,
      reconciler: stubReconciler(),
      feed,
      orderSources: [stubSource("poll", true)],
      env: "testnet",
      startedAtMs: new FixedClock(NOW).now(),
      refreshMs: 50,
    });
    expect(await server.start()).toBe(true);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("serves the page", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("BONDED");
  });

  it("serves a JSON snapshot", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`);
    const body = (await res.json()) as { bond: { state: string }; env: string };
    expect(body.bond.state).toBe("CLEARED");
    expect(body.env).toBe("testnet");
  });

  it("is read-only: refuses every method but GET", async () => {
    // A compromised browser tab must not be able to become a trading capability.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`, { method });
      expect(res.status).toBe(405);
    }
  });

  it("404s an unknown route", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it("refuses a second bind on the same port instead of throwing", async () => {
    // A busy port is a warning, not a reason to stop trading.
    const duplicate = new ConsoleServer({
      port,
      logger: createSilentLogger(),
      engine,
      reconciler: stubReconciler(),
      feed,
      orderSources: [],
      env: "testnet",
      startedAtMs: NOW,
    });
    expect(await duplicate.start()).toBe(false);
    await duplicate.stop();
  });

  it("pushes a bond burn to a connected client", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/events`);
    // Explicitly typed: Node types `res.body` loosely, and an implicit `any` here
    // would silently disable type checking inside the loop below.
    const reader: ReadableStreamDefaultReader<Uint8Array> = (
      res.body as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();
    const readChunk = async (): Promise<string> => {
      const chunk = await reader.read();
      return chunk.value === undefined ? "" : decoder.decode(chunk.value);
    };

    // First frame is the current state.
    const first = await readChunk();
    expect(first).toContain('"state":"CLEARED"');

    // Burn the bond and publish a finding; the next frame must show it.
    Object.defineProperty(engine, "scopeRevoked", { value: true, configurable: true });
    Object.defineProperty(engine, "revocationReason", {
      value: "FOREIGN: bypass detected",
      configurable: true,
    });
    feed.recordFinding(FINDING);

    let burned = "";
    for (let i = 0; i < 5 && !burned.includes("BURNED"); i++) {
      burned += await readChunk();
    }
    expect(burned).toContain('"state":"BURNED"');
    expect(burned).toContain("bypass detected");

    await reader.cancel();
  });
});

describe("DNS rebinding", () => {
  // The audit's M5. Binding to loopback does not stop a page the operator visits from
  // pointing a name it controls at 127.0.0.1 and reading this origin as same-origin:
  // balances, order history, and the mandate's thresholds. Only the Host header
  // distinguishes "someone typed 127.0.0.1" from "a hostile name resolves there".
  let secured: ConsoleServer;
  let securedPort = 7600;

  beforeEach(async () => {
    securedPort += 1;
    secured = new ConsoleServer({
      port: securedPort,
      logger: createSilentLogger(),
      engine: stubEngine(),
      reconciler: stubReconciler(),
      feed: new ActivityFeed(),
      orderSources: [stubSource("poll", true)],
      env: "testnet",
      startedAtMs: new FixedClock(NOW).now(),
      refreshMs: 1_000,
    });
    expect(await secured.start()).toBe(true);
  });

  afterEach(async () => {
    await secured.stop();
  });

  /**
   * A raw request, because `fetch` treats Host as a forbidden header and silently drops
   * an override — which would have made these tests pass against the unfixed server.
   */
  function get(
    path: string,
    host?: string,
  ): Promise<{ status: number; headers: NodeJS.Dict<string | string[]> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: securedPort,
          path,
          method: "GET",
          ...(host === undefined ? {} : { headers: { Host: host } }),
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("refuses a request that did not address a loopback name", async () => {
    const response = await get("/api/state", `attacker.example:${String(securedPort)}`);
    expect(response.status).toBe(403);
  });

  it("refuses a loopback name on the wrong port", async () => {
    const response = await get("/", "127.0.0.1:1");
    expect(response.status).toBe(403);
  });

  it.each(["127.0.0.1", "localhost"])("still serves %s", async (name) => {
    const response = await get("/api/state", `${name}:${String(securedPort)}`);
    expect(response.status).toBe(200);
  });

  it("denies framing and declares a content security policy on the page", async () => {
    const response = await get("/");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
