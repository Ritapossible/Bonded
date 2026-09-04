/**
 * The demo, as a test.
 *
 * This exercises BONDED's central claim end to end, against a stubbed exchange:
 *
 *   1. An agent places an order through BONDED. Allowed, stamped, recorded.
 *   2. An oversized order is refused, naming the clause.
 *   3. Someone bypasses BONDED entirely and places an order with the raw API key.
 *   4. The reconciler sees it on the exchange with no matching authorisation, raises a
 *      finding, and the bond burns.
 *   5. The agent's next order — one that would otherwise be perfectly legal — is
 *      refused because scope is revoked.
 *
 * *"You can go around it. You can't go around it unnoticed."*
 *
 * If this test breaks, the pitch is no longer true.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog } from "../../src/audit/decision-log.js";
import { BinanceClient } from "../../src/binance/client.js";
import { Secret } from "../../src/config/env.js";
import { FixedClock } from "../../src/core/clock.js";
import { decimalUnsafe } from "../../src/core/money.js";
import { unwrap } from "../../src/core/result.js";
import { ClauseId } from "../../src/domain/decision.js";
import type { OrderIntent } from "../../src/domain/intent.js";
import { compileMandate, type MandateSpec } from "../../src/domain/mandate.js";
import { StateProvider } from "../../src/engine/state-provider.js";
import { TradingEngine } from "../../src/engine/trading-engine.js";
import { createSilentLogger } from "../../src/observability/logger.js";
import { AuthorisationIndex } from "../../src/reconcile/authorisation-index.js";
import { ReconciliationOutcome } from "../../src/reconcile/classify.js";
import { PollingOrderSource } from "../../src/reconcile/order-source.js";
import { Reconciler } from "../../src/reconcile/reconciler.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const HMAC = "s".repeat(64);

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

interface ExchangeOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: "BUY" | "SELL";
  type: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  updateTime: number;
}

/**
 * A stub exchange with an order book that anyone can write to.
 *
 * `placeDirect` models the bypass: an order appearing on the account without ever
 * passing through BONDED, exactly as it would if someone used the raw API key.
 */
class StubExchange {
  readonly orders: ExchangeOrder[] = [];
  #nextOrderId = 28461170;

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const json = (payload: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

    switch (url.pathname) {
      case "/api/v3/exchangeInfo":
        return json({
          symbols: [
            {
              symbol: "ETHUSDT",
              status: "TRADING",
              baseAsset: "ETH",
              quoteAsset: "USDT",
              filters: [
                {
                  filterType: "PRICE_FILTER",
                  minPrice: "0.01",
                  maxPrice: "1000000",
                  tickSize: "0.01",
                },
                { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "9000", stepSize: "0.0001" },
                { filterType: "NOTIONAL", minNotional: "5" },
              ],
            },
          ],
        });
      case "/api/v3/openOrders":
        return json([]);
      case "/api/v3/account":
        return json({ canTrade: true, balances: [{ asset: "USDT", free: "10000", locked: "0" }] });
      case "/api/v3/ticker/price":
        return json({ symbol: "ETHUSDT", price: "2000" });
      case "/api/v3/myTrades":
        // No fills: realised PnL is zero and the loss clauses do not bind. The route
        // must exist regardless — a missing trade history leaves the PnL snapshot
        // stale, and the gate correctly denies rather than guessing.
        return json([]);
      case "/api/v3/allOrders":
        return json(this.orders);
      case "/api/v3/order": {
        if (method !== "POST") return json({ code: -1121, msg: "Invalid" }, 400);
        const params = url.searchParams;
        const order = this.#append({
          clientOrderId: params.get("newClientOrderId") ?? "",
          side: (params.get("side") ?? "BUY") as "BUY" | "SELL",
          type: params.get("type") ?? "LIMIT",
          price: params.get("price") ?? "0",
          origQty: params.get("quantity") ?? "0",
        });
        return json({ orderId: order.orderId, status: "FILLED" });
      }
      default:
        return json({ code: -1121, msg: "Invalid symbol." }, 400);
    }
  };

  #append(
    partial: Pick<ExchangeOrder, "clientOrderId" | "side" | "type" | "price" | "origQty">,
  ): ExchangeOrder {
    const order: ExchangeOrder = {
      symbol: "ETHUSDT",
      orderId: this.#nextOrderId++,
      status: "FILLED",
      executedQty: partial.origQty,
      updateTime: NOW,
      ...partial,
    };
    this.orders.push(order);
    return order;
  }

  /** An order placed with the raw API key, never seen by BONDED. */
  placeDirect(clientOrderId: string, quantity: string): ExchangeOrder {
    return this.#append({
      clientOrderId,
      side: "SELL",
      type: "MARKET",
      price: "0",
      origQty: quantity,
    });
  }
}

describe("bypass detection, end to end", () => {
  let dir: string;
  let exchange: StubExchange;
  let engine: TradingEngine;
  let reconciler: Reconciler;
  let poller: PollingOrderSource;
  let decisionLog: DecisionLog;

  const ALLOWED: OrderIntent = {
    kind: "LIMIT",
    symbol: "ETHUSDT",
    side: "BUY",
    quantity: decimalUnsafe("0.1"),
    price: decimalUnsafe("2000"),
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bonded-e2e-"));
    exchange = new StubExchange();
    const clock = new FixedClock(NOW);
    const logger = createSilentLogger();

    const client = new BinanceClient({
      baseUrl: "https://testnet.binance.vision",
      apiKey: new Secret("k".repeat(32)),
      secretKey: new Secret("v".repeat(32)),
      timeoutMs: 5_000,
      recvWindowMs: 5_000,
      logger,
      fetchImpl: exchange.fetch,
      maxRetries: 0,
    });

    const stateProvider = new StateProvider({ client, clock, symbols: SPEC.symbols });
    unwrap(await stateProvider.loadSymbolRules(), "ground");

    decisionLog = unwrap(await DecisionLog.open(join(dir, "decisions.jsonl")), "open");
    const mandate = unwrap(compileMandate(SPEC), "mandate");
    const index = new AuthorisationIndex();
    const wiring: { engine?: TradingEngine } = {};

    reconciler = new Reconciler({
      index,
      hmacSecret: HMAC,
      mandateHash: mandate.hash,
      clock,
      logger,
      onFinding: (finding) => {
        wiring.engine?.revokeScope(`${finding.outcome}: ${finding.explanation}`);
      },
    });

    engine = new TradingEngine({
      mandate,
      client,
      stateProvider,
      decisionLog,
      hmacSecret: new Secret(HMAC),
      clock,
      logger,
      runtimeEnv: "testnet",
      isAuditPathHealthy: () => true,
      onDecision: (record) => {
        reconciler.authorise(record);
      },
    });
    wiring.engine = engine;

    poller = new PollingOrderSource({ client, clock, logger, symbols: SPEC.symbols });
  });

  afterEach(async () => {
    await poller.stop();
    await decisionLog.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** One reconciliation pass over whatever the exchange currently holds. */
  async function reconcile(): Promise<void> {
    await poller.poll((orders) => {
      reconciler.observeAll(orders);
    });
  }

  it("runs the full sequence: allow, refuse, bypass, detect, revoke", async () => {
    // 1 — an authorised order goes through.
    const first = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(first.status).toBe("PLACED");

    // 2 — an oversized order is refused, naming the clause.
    const refused = unwrap(
      await engine.placeOrder({ ...ALLOWED, quantity: decimalUnsafe("0.5") }),
      "place",
    );
    expect(refused.status).toBe("DENIED");
    if (refused.status !== "DENIED") throw new Error("unreachable");
    expect(refused.clause).toBe(ClauseId.MAX_NOTIONAL);

    // The authorised order reconciles cleanly; nothing is flagged.
    await reconcile();
    expect(reconciler.compromised).toBe(false);
    expect(engine.scopeRevoked).toBe(false);

    // 3 — the bypass. Someone uses the raw API key; BONDED never sees this order.
    const bypass = exchange.placeDirect("web_manual_1", "5");
    expect(engine.scopeRevoked).toBe(false); // not yet observed

    // 4 — the next reconciliation pass finds it.
    await reconcile();

    expect(reconciler.compromised).toBe(true);
    expect(reconciler.worstOutcome).toBe(ReconciliationOutcome.FOREIGN);

    const finding = reconciler.findings[0]!;
    expect(finding.reference.orderId).toBe(bypass.orderId);
    // The finding is checkable against Binance without trusting BONDED.
    expect(finding.evidence.clientOrderId).toBe("web_manual_1");

    // 5 — the bond is burned and scope revoked.
    expect(engine.scopeRevoked).toBe(true);
    expect(engine.revocationReason).toContain("FOREIGN");

    // An order that would have been perfectly legal is now refused.
    const afterRevocation = unwrap(await engine.placeOrder(ALLOWED), "place");
    expect(afterRevocation.status).toBe("DENIED");
    if (afterRevocation.status !== "DENIED") throw new Error("unreachable");
    expect(afterRevocation.clause).toBe(ClauseId.SCOPE);
  });

  it("does not flag an order it authorised, however many times it is polled", async () => {
    await engine.placeOrder(ALLOWED);
    await reconcile();
    await reconcile();
    await reconcile();

    expect(reconciler.compromised).toBe(false);
    expect(reconciler.stats.authorised).toBe(1);
    // De-duplicated: three passes, one observation.
    expect(reconciler.stats.observed).toBe(1);
  });

  it("catches an order forged into BONDED's namespace", async () => {
    await engine.placeOrder(ALLOWED);
    await reconcile();

    // Knowing the id format is not enough without the HMAC secret.
    exchange.placeDirect("bnd_deadbeef_9_000000000000", "5");
    await reconcile();

    expect(reconciler.worstOutcome).toBe(ReconciliationOutcome.FORGED);
    expect(engine.scopeRevoked).toBe(true);
  });

  it("catches an order placed while BONDED was not running", async () => {
    // The poller's first pass reaches back over recent history, so an order placed
    // during a restart window is not missed just because nothing was watching.
    exchange.placeDirect("web_while_down", "3");

    await poller.start((orders) => {
      reconciler.observeAll(orders);
    });

    expect(reconciler.compromised).toBe(true);
    expect(engine.scopeRevoked).toBe(true);
  });
});
