import { describe, expect, it } from "vitest";
import { decimalUnsafe, type DecimalString } from "../../src/core/money.js";
import { ClauseId } from "../../src/domain/decision.js";
import type { ExchangeState, SymbolRules } from "../../src/domain/exchange.js";
import type { OrderIntent } from "../../src/domain/intent.js";
import { compileMandate, type Mandate, type MandateSpec } from "../../src/domain/mandate.js";
import { evaluate, type GateInput } from "../../src/gate/gate.js";
import { unwrap } from "../../src/core/result.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const BASE_SPEC: MandateSpec = {
  version: 1,
  env: "testnet",
  symbols: ["BTCUSDT", "ETHUSDT"],
  orderTypes: ["LIMIT", "MARKET"],
  sides: ["BUY", "SELL"],
  maxNotionalUsd: "500",
  maxOpenOrders: 2,
  dailyLossLimitUsd: "50",
  maxDrawdownPct: "5",
  tradingWindowUtc: ["00:00", "23:59"],
  expiresAt: "2026-09-08T23:59:00.000Z",
};

function mandate(overrides: Partial<MandateSpec> = {}): Mandate {
  return unwrap(compileMandate({ ...BASE_SPEC, ...overrides }), "test mandate");
}

const ETH_RULES: SymbolRules = {
  symbol: "ETHUSDT",
  status: "TRADING",
  baseAsset: "ETH",
  quoteAsset: "USDT",
  tickSize: decimalUnsafe("0.01"),
  minPrice: decimalUnsafe("0.01"),
  maxPrice: decimalUnsafe("1000000"),
  stepSize: decimalUnsafe("0.0001"),
  minQty: decimalUnsafe("0.0001"),
  maxQty: decimalUnsafe("9000"),
  minNotional: decimalUnsafe("5"),
};

const BTC_RULES: SymbolRules = { ...ETH_RULES, symbol: "BTCUSDT", baseAsset: "BTC" };

function state(overrides: Partial<ExchangeState> = {}): ExchangeState {
  return {
    account: { observedAtMs: NOW, canTrade: true, balances: new Map(), openOrderCount: 0 },
    prices: { observedAtMs: NOW, prices: new Map([["ETHUSDT", decimalUnsafe("2000")]]) },
    dailyPnl: { observedAtMs: NOW, dayKey: "2026-09-06", realisedUsd: decimalUnsafe("0") },
    symbolRules: new Map([
      ["ETHUSDT", ETH_RULES],
      ["BTCUSDT", BTC_RULES],
    ]),
    ...overrides,
  };
}

const LIMIT_BUY: OrderIntent = {
  kind: "LIMIT",
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: decimalUnsafe("0.1"),
  price: decimalUnsafe("2000"),
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    mandate: mandate(),
    intent: LIMIT_BUY,
    state: state(),
    nowMs: NOW,
    runtimeEnv: "testnet",
    scopeRevoked: false,
    ...overrides,
  };
}

/** Assert a denial and return it, so tests read as one statement. */
function expectDeny(result: ReturnType<typeof evaluate>, clause: ClauseId) {
  expect(result.verdict.outcome).toBe("DENY");
  if (result.verdict.outcome !== "DENY") throw new Error("unreachable");
  expect(result.verdict.denial.clause).toBe(clause);
  return result.verdict.denial;
}

describe("gate", () => {
  it("allows an order that satisfies every clause", () => {
    const result = evaluate(input());
    expect(result.verdict.outcome).toBe("ALLOW");
    expect(result.notionalUsd).toBe("200");
  });

  it("denies when the runtime environment does not match the mandate", () => {
    expectDeny(evaluate(input({ runtimeEnv: "prod" })), ClauseId.ENVIRONMENT);
  });

  it("denies everything once scope is revoked", () => {
    expectDeny(evaluate(input({ scopeRevoked: true })), ClauseId.SCOPE);
  });

  it("denies an expired mandate", () => {
    const expired = Date.parse("2026-09-09T00:00:00.000Z");
    expectDeny(evaluate(input({ nowMs: expired })), ClauseId.EXPIRY);
  });

  it("denies a symbol outside the allowlist without disclosing the allowlist", () => {
    const denial = expectDeny(
      evaluate(input({ intent: { ...LIMIT_BUY, symbol: "BTCUSDT" }, mandate: mandate({ symbols: ["ETHUSDT"] }) })),
      ClauseId.SYMBOL_ALLOWLIST,
    );
    expect(denial.limit).toBe("1 allowed symbols");
    expect(denial.limit).not.toContain("ETHUSDT");
  });

  it("denies a symbol that is not currently trading", () => {
    const halted = new Map([["ETHUSDT", { ...ETH_RULES, status: "HALT" }]]);
    expectDeny(evaluate(input({ state: state({ symbolRules: halted }) })), ClauseId.SYMBOL_TRADABLE);
  });

  it("denies an order type the mandate does not permit", () => {
    const marketOnly = mandate({ orderTypes: ["MARKET"] });
    expectDeny(evaluate(input({ mandate: marketOnly })), ClauseId.ORDER_TYPE);
  });

  it("denies a side the mandate does not permit", () => {
    expectDeny(evaluate(input({ mandate: mandate({ sides: ["SELL"] }) })), ClauseId.SIDE);
  });

  it("denies outside the trading window", () => {
    const window = mandate({ tradingWindowUtc: ["09:00", "10:00"] });
    expectDeny(evaluate(input({ mandate: window })), ClauseId.TRADING_WINDOW);
  });

  it("denies when the account cannot trade", () => {
    const blocked = state({
      account: { observedAtMs: NOW, canTrade: false, balances: new Map(), openOrderCount: 0 },
    });
    expectDeny(evaluate(input({ state: blocked })), ClauseId.ACCOUNT_TRADING_DISABLED);
  });

  it("denies when the open order limit is already reached", () => {
    const full = state({
      account: { observedAtMs: NOW, canTrade: true, balances: new Map(), openOrderCount: 2 },
    });
    expectDeny(evaluate(input({ state: full })), ClauseId.MAX_OPEN_ORDERS);
  });

  it("denies a price that is not a multiple of the tick size", () => {
    const intent: OrderIntent = { ...LIMIT_BUY, price: decimalUnsafe("2000.005") };
    const denial = expectDeny(evaluate(input({ intent })), ClauseId.PRICE_FILTER);
    expect(denial.limit).toBe("multiple of 0.01");
  });

  it("denies a quantity that is not a multiple of the step size", () => {
    const intent: OrderIntent = { ...LIMIT_BUY, quantity: decimalUnsafe("0.00005") };
    expectDeny(evaluate(input({ intent })), ClauseId.LOT_SIZE);
  });

  it("denies a notional below the symbol minimum", () => {
    const intent: OrderIntent = { ...LIMIT_BUY, quantity: decimalUnsafe("0.001") };
    const denial = expectDeny(evaluate(input({ intent })), ClauseId.MIN_NOTIONAL);
    expect(denial.observed).toBe("2");
  });

  it("denies a notional above the mandate maximum and reports both values", () => {
    const intent: OrderIntent = { ...LIMIT_BUY, quantity: decimalUnsafe("0.5") };
    const denial = expectDeny(evaluate(input({ intent })), ClauseId.MAX_NOTIONAL);
    expect(denial.observed).toBe("1000");
    expect(denial.limit).toBe("500");
  });

  it("denies once the daily realised loss reaches the limit", () => {
    const losing = state({
      dailyPnl: { observedAtMs: NOW, dayKey: "2026-09-06", realisedUsd: decimalUnsafe("-50") },
    });
    const denial = expectDeny(evaluate(input({ state: losing })), ClauseId.DAILY_LOSS_LIMIT);
    expect(denial.observed).toBe("50");
  });

  it("allows while the daily loss is still below the limit", () => {
    const losing = state({
      dailyPnl: { observedAtMs: NOW, dayKey: "2026-09-06", realisedUsd: decimalUnsafe("-49.99") },
    });
    expect(evaluate(input({ state: losing })).verdict.outcome).toBe("ALLOW");
  });

  describe("market orders", () => {
    it("uses the quote quantity directly as the notional", () => {
      const intent: OrderIntent = {
        kind: "MARKET_QUOTE",
        symbol: "ETHUSDT",
        side: "BUY",
        quoteOrderQty: decimalUnsafe("900"),
      };
      const denial = expectDeny(evaluate(input({ intent })), ClauseId.MAX_NOTIONAL);
      expect(denial.observed).toBe("900");
    });

    it("estimates the notional of a base-sized order from the reference price", () => {
      const intent: OrderIntent = {
        kind: "MARKET_BASE",
        symbol: "ETHUSDT",
        side: "BUY",
        quantity: decimalUnsafe("0.1"),
      };
      const result = evaluate(input({ intent }));
      expect(result.verdict.outcome).toBe("ALLOW");
      expect(result.notionalUsd).toBe("200");
    });

    it("denies a base-sized order when no reference price is available", () => {
      const intent: OrderIntent = {
        kind: "MARKET_BASE",
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: decimalUnsafe("0.1"),
      };
      expectDeny(evaluate(input({ intent })), ClauseId.REFERENCE_PRICE);
    });
  });

  describe("fail-closed behaviour", () => {
    it("denies when the account snapshot is stale", () => {
      const stale = state({
        account: {
          observedAtMs: NOW - 60_000,
          canTrade: true,
          balances: new Map(),
          openOrderCount: 0,
        },
      });
      expectDeny(evaluate(input({ state: stale })), ClauseId.STATE_FRESHNESS);
    });

    it("denies when a snapshot is timestamped in the future", () => {
      const skewed = state({
        account: {
          observedAtMs: NOW + 60_000,
          canTrade: true,
          balances: new Map(),
          openOrderCount: 0,
        },
      });
      expectDeny(evaluate(input({ state: skewed })), ClauseId.STATE_FRESHNESS);
    });

    it("denies a symbol that cannot be resolved in exchangeInfo", () => {
      const empty = state({ symbolRules: new Map<string, SymbolRules>() });
      expectDeny(evaluate(input({ state: empty })), ClauseId.SYMBOL_ALLOWLIST);
    });
  });

  describe("clause precedence", () => {
    it("reports the most fundamental breach when an order violates several clauses", () => {
      // Expired, wrong symbol, and oversized all at once. Expiry is the operator's
      // most useful answer, so it must win.
      const intent: OrderIntent = {
        ...LIMIT_BUY,
        symbol: "BTCUSDT",
        quantity: decimalUnsafe("5"),
      };
      const expired = Date.parse("2026-09-09T00:00:00.000Z");
      expectDeny(
        evaluate(input({ intent, nowMs: expired, mandate: mandate({ symbols: ["ETHUSDT"] }) })),
        ClauseId.EXPIRY,
      );
    });
  });

  it("never throws, whatever the intent", () => {
    const nonsense = {
      kind: "LIMIT",
      symbol: "ETHUSDT",
      side: "BUY",
      quantity: "0" as DecimalString,
      price: "0" as DecimalString,
    } satisfies OrderIntent;
    expect(() => evaluate(input({ intent: nonsense }))).not.toThrow();
  });
});
