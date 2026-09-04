/**
 * End-to-end engine tests against a stubbed exchange.
 *
 * The property under test is the ordering guarantee: a decision record is durably
 * written before an order can reach the exchange, and no order reaches the exchange
 * without one. That ordering is what makes "this order was never authorised" a finding
 * rather than a guess.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog, verifyChain } from "../../src/audit/decision-log.js";
import { verifyClientOrderId } from "../../src/audit/client-order-id.js";
import { BinanceClient } from "../../src/binance/client.js";
import { Secret } from "../../src/config/env.js";
import { FixedClock } from "../../src/core/clock.js";
import { decimalUnsafe } from "../../src/core/money.js";
import { unwrap } from "../../src/core/result.js";
import { ClauseId, type DecisionRecord } from "../../src/domain/decision.js";
import type { OrderIntent } from "../../src/domain/intent.js";
import { compileMandate, type MandateSpec } from "../../src/domain/mandate.js";
import { StateProvider } from "../../src/engine/state-provider.js";
import { TradingEngine } from "../../src/engine/trading-engine.js";
import { createSilentLogger } from "../../src/observability/logger.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const SECRET = "s".repeat(64);

const SPEC: MandateSpec = {
  version: 1,
  env: "testnet",
  symbols: ["ETHUSDT"],
  orderTypes: ["LIMIT", "MARKET"],
  sides: ["BUY", "SELL"],
  maxNotionalUsd: "500",
  maxOpenOrders: 5,
  dailyLossLimitUsd: "50",
  maxDrawdownPct: "5",
  tradingWindowUtc: ["00:00", "23:59"],
  expiresAt: "2026-09-08T23:59:00.000Z",
};

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: "ETHUSDT",
      status: "TRADING",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "9000", stepSize: "0.0001" },
        { filterType: "NOTIONAL", minNotional: "5" },
      ],
    },
  ],
};

/** Extract the request URL for every input shape `fetch` accepts. */
type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Records every request so tests can assert what did — and did not — reach the exchange. */
class StubExchange {
  readonly requests: { method: string; path: string; url: string }[] = [];
  orderResponse: unknown = { orderId: 28461173, status: "NEW" };
  orderStatus = 200;
  /** When set, every request fails as if the exchange were unreachable. */
  unreachable = false;

  readonly fetch: typeof fetch = (input, init) => {
    const href = requestUrl(input);
    const url = new URL(href);
    const method = init?.method ?? "GET";
    this.requests.push({ method, path: url.pathname, url: href });

    if (this.unreachable) {
      return Promise.resolve(new Response("", { status: 503 }));
    }

    const body = (payload: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

    switch (url.pathname) {
      case "/api/v3/exchangeInfo":
        return body(EXCHANGE_INFO);
      case "/api/v3/openOrders":
        return body([]);
      case "/api/v3/account":
        return body({ canTrade: true, balances: [{ asset: "USDT", free: "10000", locked: "0" }] });
      case "/api/v3/ticker/price":
        return body({ symbol: "ETHUSDT", price: "2000" });
      case "/api/v3/myTrades":
        // No fills: realised PnL is zero and the loss clauses do not bind. The route
        // must exist regardless — a missing trade history leaves the PnL snapshot
        // stale, and the gate correctly denies rather than guessing.
        return body([]);
      case "/api/v3/order":
        return body(this.orderResponse, this.orderStatus);
      default:
        return body({ code: -1121, msg: "Invalid symbol." }, 400);
    }
  };

  get orderRequests(): typeof this.requests {
    return this.requests.filter((r) => r.path === "/api/v3/order");
  }
}

let dir: string;
let logPath: string;
let exchange: StubExchange;
let clock: FixedClock;
let engine: TradingEngine;
let decisionLog: DecisionLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bonded-engine-"));
  logPath = join(dir, "decisions.jsonl");
  exchange = new StubExchange();
  clock = new FixedClock(NOW);

  const logger = createSilentLogger();
  const client = new BinanceClient({
    baseUrl: "https://testnet.binance.vision",
    apiKey: new Secret("k".repeat(32)),
    secretKey: new Secret("v".repeat(32)),
    timeoutMs: 5_000,
    recvWindowMs: 5_000,
    logger,
    fetchImpl: exchange.fetch,
    // Retry/backoff has its own coverage; disabling it here keeps the suite fast.
    maxRetries: 0,
  });

  const stateProvider = new StateProvider({ client, clock, symbols: SPEC.symbols });
  unwrap(await stateProvider.loadSymbolRules(), "ground symbols");

  decisionLog = unwrap(await DecisionLog.open(logPath), "open log");
  engine = new TradingEngine({
    mandate: unwrap(compileMandate(SPEC), "mandate"),
    client,
    stateProvider,
    decisionLog,
    hmacSecret: new Secret(SECRET),
    clock,
    logger,
    runtimeEnv: "testnet",
    isAuditPathHealthy: () => true,
  });
});

/** Logs opened by tests that build their own engine, closed with the shared one. */
let capLogs: DecisionLog[] = [];

afterEach(async () => {
  await decisionLog.close();
  await Promise.all(capLogs.map((log) => log.close()));
  capLogs = [];
  await rm(dir, { recursive: true, force: true });
});

const ALLOWED: OrderIntent = {
  kind: "LIMIT",
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: decimalUnsafe("0.1"),
  price: decimalUnsafe("2000"),
};

const OVERSIZED: OrderIntent = { ...ALLOWED, quantity: decimalUnsafe("0.5") };

async function records(): Promise<DecisionRecord[]> {
  const text = await readFile(logPath, "utf8");
  return text
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as DecisionRecord);
}

describe("TradingEngine", () => {
  it("places an allowed order and stamps it with a verifiable id", async () => {
    const outcome = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(outcome.status).toBe("PLACED");
    if (outcome.status !== "PLACED") throw new Error("unreachable");

    const mandateHash = engine.mandate.hash;
    expect(verifyClientOrderId(SECRET, mandateHash, outcome.clientOrderId)).toEqual({
      kind: "authentic",
      seq: outcome.seq,
    });

    // The id BONDED minted is the one that actually went to the exchange.
    expect(exchange.orderRequests).toHaveLength(1);
    expect(exchange.orderRequests[0]!.url).toContain(`newClientOrderId=${outcome.clientOrderId}`);
  });

  it("denies an oversized order and never contacts the exchange", async () => {
    const outcome = unwrap(await engine.placeOrder(OVERSIZED), "place");
    expect(outcome.status).toBe("DENIED");
    if (outcome.status !== "DENIED") throw new Error("unreachable");
    expect(outcome.clause).toBe(ClauseId.MAX_NOTIONAL);
    expect(outcome.observed).toBe("1000");
    expect(outcome.limit).toBe("500");

    expect(exchange.orderRequests).toHaveLength(0);
  });

  it("records denials as well as allows", async () => {
    await engine.placeOrder(ALLOWED);
    await engine.placeOrder(OVERSIZED);

    const written = await records();
    expect(written.map((r) => r.outcome)).toEqual(["ALLOW", "DENY"]);
    // The allow record is what reconciliation matches a filled order against; without
    // it a legitimate order would look like a bypass.
    expect(written[0]!.clientOrderId).toBeDefined();
    expect(written[1]!.denial?.clause).toBe(ClauseId.MAX_NOTIONAL);
  });

  it("writes the authorisation before the order reaches the exchange", async () => {
    // The stub asserts ordering from inside the request: by the time the exchange is
    // called, the record must already be on disk.
    let recordsAtOrderTime = -1;
    const inner = exchange.fetch;
    const spy: typeof fetch = async (input, init) => {
      if (requestUrl(input).includes("/api/v3/order")) {
        recordsAtOrderTime = (await records()).length;
      }
      return inner(input, init);
    };
    const client = new BinanceClient({
      baseUrl: "https://testnet.binance.vision",
      apiKey: new Secret("k".repeat(32)),
      secretKey: new Secret("v".repeat(32)),
      timeoutMs: 5_000,
      recvWindowMs: 5_000,
      logger: createSilentLogger(),
      fetchImpl: spy,
      maxRetries: 0,
    });
    const stateProvider = new StateProvider({ client, clock, symbols: SPEC.symbols });
    unwrap(await stateProvider.loadSymbolRules(), "ground");
    const scoped = new TradingEngine({
      mandate: unwrap(compileMandate(SPEC), "mandate"),
      client,
      stateProvider,
      decisionLog,
      hmacSecret: new Secret(SECRET),
      clock,
      logger: createSilentLogger(),
      runtimeEnv: "testnet",
      isAuditPathHealthy: () => true,
    });

    await scoped.placeOrder(ALLOWED);
    expect(recordsAtOrderTime).toBe(1);
  });

  it("keeps the authorisation when the exchange rejects the order", async () => {
    exchange.orderStatus = 400;
    exchange.orderResponse = { code: -2010, msg: "Account has insufficient balance." };

    const outcome = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(outcome.status).toBe("FAILED");
    // Reconciliation reads this as "authorised, never seen at the exchange", which is
    // benign. The dangerous direction — an order with no authorisation — cannot occur.
    expect((await records())[0]!.outcome).toBe("ALLOW");
  });

  it("denies everything once scope is revoked", async () => {
    engine.revokeScope("unauthorised order 28461173 observed on the account");

    const outcome = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(outcome.status).toBe("DENIED");
    if (outcome.status !== "DENIED") throw new Error("unreachable");
    expect(outcome.clause).toBe(ClauseId.SCOPE);
    expect(exchange.orderRequests).toHaveLength(0);
  });

  it("does not consume a log entry for a dry run", async () => {
    await engine.dryRun(OVERSIZED);
    expect(await records()).toHaveLength(0);
  });

  describe("cancellation", () => {
    // The audit's M1: the code claimed "cancellation is still recorded, so the audit
    // trail shows the full lifecycle" and wrote nothing but a stderr line. A log holding
    // a placement and nothing else describes an open order that no longer exists.
    it("appends a CANCEL record to the chained log", async () => {
      const placed = await engine.placeOrder(ALLOWED);
      expect(placed.ok && placed.value.status).toBe("PLACED");
      const clientOrderId =
        placed.ok && placed.value.status === "PLACED" ? placed.value.clientOrderId : "";

      await engine.cancelOrder("ETHUSDT", clientOrderId);

      const written = await records();
      const cancel = written.at(-1);
      expect(cancel?.outcome).toBe("CANCEL");
      expect(cancel?.cancel).toEqual({ symbol: "ETHUSDT", clientOrderId });
      expect(cancel?.intent).toBeUndefined();
    });

    it("keeps the hash chain intact across a cancellation", async () => {
      const placed = await engine.placeOrder(ALLOWED);
      const clientOrderId =
        placed.ok && placed.value.status === "PLACED" ? placed.value.clientOrderId : "";
      await engine.cancelOrder("ETHUSDT", clientOrderId);
      await engine.placeOrder(ALLOWED);

      expect((await verifyChain(logPath)).ok).toBe(true);
    });

    it("records the cancellation before the request reaches the exchange", async () => {
      const placed = await engine.placeOrder(ALLOWED);
      const clientOrderId =
        placed.ok && placed.value.status === "PLACED" ? placed.value.clientOrderId : "";
      exchange.unreachable = true;

      const result = await engine.cancelOrder("ETHUSDT", clientOrderId);

      // The exchange refused, and the attempt is still in the trail. A record of an
      // attempt that failed is accurate; a missing record is not.
      expect(result.ok).toBe(false);
      expect((await records()).at(-1)?.outcome).toBe("CANCEL");
    });

    it("is never refused by the gate, even once scope is revoked", async () => {
      const placed = await engine.placeOrder(ALLOWED);
      const clientOrderId =
        placed.ok && placed.value.status === "PLACED" ? placed.value.clientOrderId : "";
      engine.revokeScope("test");

      await engine.cancelOrder("ETHUSDT", clientOrderId);

      expect((await records()).at(-1)?.outcome).toBe("CANCEL");
      // And an order in the same state is refused, so the asymmetry is deliberate.
      const after = await engine.placeOrder(ALLOWED);
      expect(after.ok && after.value.status).toBe("DENIED");
    });
  });

  describe("the open-order cap under load", () => {
    /**
     * The audit's H2. `maxOpenOrders` is an aggregate cap read from an account snapshot
     * that is cached for ten seconds. Before the fix, every order in a burst saw the
     * same `openOrderCount: 0` and the cap bound only against traffic slow enough not
     * to need it.
     */
    async function engineWithCap(maxOpenOrders: number): Promise<TradingEngine> {
      const log = unwrap(
        await DecisionLog.open(join(dir, `cap-${String(maxOpenOrders)}.jsonl`)),
        "open cap log",
      );
      capLogs.push(log);
      const client = new BinanceClient({
        baseUrl: "https://testnet.binance.vision",
        apiKey: new Secret("k".repeat(32)),
        secretKey: new Secret("v".repeat(32)),
        timeoutMs: 5_000,
        recvWindowMs: 5_000,
        logger: createSilentLogger(),
        fetchImpl: exchange.fetch,
        maxRetries: 0,
      });
      const provider = new StateProvider({ client, clock, symbols: SPEC.symbols });
      unwrap(await provider.loadSymbolRules(), "ground symbols");
      return new TradingEngine({
        mandate: unwrap(compileMandate({ ...SPEC, maxOpenOrders }), "cap mandate"),
        client,
        stateProvider: provider,
        decisionLog: log,
        hmacSecret: new Secret(SECRET),
        clock,
        logger: createSilentLogger(),
        runtimeEnv: "testnet",
        isAuditPathHealthy: () => true,
      });
    }

    it("holds against a burst of concurrent orders", async () => {
      const capped = await engineWithCap(2);
      const before = exchange.orderRequests.length;

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => capped.placeOrder(ALLOWED)),
      );

      const placed = outcomes.filter((o) => o.ok && o.value.status === "PLACED");
      const denied = outcomes.filter(
        (o) => o.ok && o.value.status === "DENIED" && o.value.clause === ClauseId.MAX_OPEN_ORDERS,
      );

      expect(placed).toHaveLength(2);
      expect(denied).toHaveLength(4);
      // The exchange is the real check: only two orders may actually have been sent.
      expect(exchange.orderRequests.length - before).toBe(2);
    });

    it("holds across sequential orders inside one account snapshot", async () => {
      const capped = await engineWithCap(1);
      const first = await capped.placeOrder(ALLOWED);
      // The clock does not move, so the account snapshot is the same one. Before the
      // fix this second order saw openOrderCount: 0 and was allowed.
      const second = await capped.placeOrder(ALLOWED);

      expect(first.ok && first.value.status).toBe("PLACED");
      expect(second.ok && second.value.status).toBe("DENIED");
      expect(second.ok && second.value.status === "DENIED" && second.value.clause).toBe(
        ClauseId.MAX_OPEN_ORDERS,
      );
    });

    it("does not count an order the exchange reports as already filled", async () => {
      // A MARKET order that fills on placement occupies no slot. Counting it would
      // deny legitimate orders for the life of the snapshot.
      exchange.orderResponse = { orderId: 1, status: "FILLED" };
      const capped = await engineWithCap(1);

      expect((await capped.placeOrder(ALLOWED)).ok).toBe(true);
      const second = await capped.placeOrder(ALLOWED);
      expect(second.ok && second.value.status).toBe("PLACED");
    });

    it("counts an order whose status it cannot read", async () => {
      // Unknown counts: over-counting refuses an order the operator may have wanted;
      // under-counting breaches the cap they wrote down.
      exchange.orderResponse = { orderId: 2 };
      const capped = await engineWithCap(1);

      expect((await capped.placeOrder(ALLOWED)).ok).toBe(true);
      const second = await capped.placeOrder(ALLOWED);
      expect(second.ok && second.value.status).toBe("DENIED");
    });
  });

  it("keeps the chain intact across concurrent orders", async () => {
    await Promise.all([
      engine.placeOrder(ALLOWED),
      engine.placeOrder(OVERSIZED),
      engine.placeOrder(ALLOWED),
    ]);

    const verified = unwrap(await verifyChain(logPath), "verify");
    expect(verified.recordCount).toBe(3);

    // Every minted id must verify against the seq of the record that produced it.
    for (const record of await records()) {
      if (record.clientOrderId === undefined) continue;
      expect(verifyClientOrderId(SECRET, engine.mandate.hash, record.clientOrderId)).toEqual({
        kind: "authentic",
        seq: record.seq,
      });
    }
  });

  it("denies when exchange state has gone stale", async () => {
    // Advance past every staleness budget while the exchange stops responding, so the
    // refresh cannot succeed and the gate is left holding a snapshot it cannot vouch for.
    exchange.unreachable = true;
    clock.advance(120_000);

    const outcome = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(outcome.status).toBe("DENIED");
    if (outcome.status !== "DENIED") throw new Error("unreachable");
    expect(outcome.clause).toBe(ClauseId.STATE_FRESHNESS);
  });
});
