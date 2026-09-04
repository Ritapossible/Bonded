/**
 * The pre-trade gate.
 *
 * A pure function of `(mandate, intent, exchange state, now)`. No I/O, no clock reads,
 * no network. That is what makes it exhaustively testable, deterministic under replay,
 * and fast enough to sit on the hot path without anyone being tempted to skip it.
 *
 * **Every clause lives in this file, on purpose.** Spreading a policy across a
 * directory makes it impossible to answer "what does this actually enforce?" without
 * reading everything. A security boundary should be auditable on one screen; the
 * `CLAUSES` array below is the complete enforcement surface, in evaluation order.
 *
 * Two invariants hold throughout:
 *
 * 1. **Fail closed.** Any condition the gate cannot evaluate — a missing symbol rule,
 *    a stale snapshot, an unavailable reference price — is a denial, never a pass.
 *    An outage must not silently convert a bounded mandate into an unbounded one.
 * 2. **Denials name the clause that fired.** A fast, specific refusal lets an agent
 *    correct itself; a generic error makes it retry blindly.
 */

import { utcMinutesOfDay } from "../core/clock.js";
import {
  ZERO,
  compare,
  greaterThan,
  isMultipleOf,
  isNegative,
  lessThan,
  multiply,
  percentOf,
  type DecimalString,
} from "../core/money.js";
import { ALLOW, ClauseId, deny, type Verdict } from "../domain/decision.js";
import {
  STALENESS_BUDGET_MS,
  isStale,
  isTradingEnabled,
  type ExchangeState,
  type SymbolRules,
} from "../domain/exchange.js";
import { orderTypeOf, type OrderIntent } from "../domain/intent.js";
import type { Mandate } from "../domain/mandate.js";

/** Which exchange snapshots a clause reads. Declared so freshness is enforced centrally. */
export type SnapshotName = "account" | "prices" | "dailyPnl";

export interface GateInput {
  readonly mandate: Mandate;
  readonly intent: OrderIntent;
  readonly state: ExchangeState;
  readonly nowMs: number;
  /** The environment BONDED is actually configured against, checked against the mandate. */
  readonly runtimeEnv: "testnet" | "prod";
  /** Set once the reconciler has burned the bond. Denies everything. */
  readonly scopeRevoked: boolean;
  /**
   * Whether at least one order source is currently delivering.
   *
   * "No audit path, no trading" is a stated invariant, and enforcing it only at boot
   * would leave it false for the entire life of the process the moment a feed died.
   * A gate that keeps allowing orders it can no longer reconcile is a gate whose
   * central claim has quietly stopped being true.
   */
  readonly auditPathHealthy: boolean;
  /**
   * Orders this process has placed that may still be open but are not yet reflected in
   * `state.account.openOrderCount`.
   *
   * The account snapshot is up to ten seconds old, and `maxOpenOrders` is an aggregate
   * cap rather than a per-order one. Without this, two orders a second apart both read
   * the same `openOrderCount` and both pass a limit of one — the cap would bind only
   * against traffic slow enough not to need it.
   */
  readonly pendingOpenOrders: number;
}

/** Input plus the values derived once in the prelude, so no clause recomputes them. */
interface GateContext extends GateInput {
  readonly notionalUsd: DecimalString;
  readonly symbolRules: SymbolRules;
}

interface Clause {
  readonly id: ClauseId;
  readonly text: string;
  readonly requires: readonly SnapshotName[];
  readonly evaluate: (ctx: GateContext) => Verdict;
}

export interface GateResult {
  readonly verdict: Verdict;
  /** Present whenever the notional could be determined, including on most denials. */
  readonly notionalUsd?: DecimalString;
}

const SNAPSHOT_BUDGETS: Record<SnapshotName, number> = {
  account: STALENESS_BUDGET_MS.account,
  prices: STALENESS_BUDGET_MS.prices,
  dailyPnl: STALENESS_BUDGET_MS.dailyPnl,
};

function snapshotObservedAt(state: ExchangeState, name: SnapshotName): number {
  switch (name) {
    case "account":
      return state.account.observedAtMs;
    case "prices":
      return state.prices.observedAtMs;
    case "dailyPnl":
      return state.dailyPnl.observedAtMs;
  }
}

function denyStale(name: SnapshotName, ageMs: number): Verdict {
  return deny({
    clause: ClauseId.STATE_FRESHNESS,
    clauseText: `Exchange state must be no older than ${String(SNAPSHOT_BUDGETS[name])} ms to evaluate this order.`,
    observed: `${name} snapshot age ${String(ageMs)} ms`,
    limit: `${String(SNAPSHOT_BUDGETS[name])} ms`,
  });
}

/**
 * The complete enforcement surface, in evaluation order.
 *
 * Ordering is deliberate: identity and authority first (they are cheap and absolute),
 * then the shape of the request, then the rules that depend on live exchange state.
 * The first denial wins, so the clause an operator sees is the most fundamental one
 * the order breached rather than an incidental downstream symptom.
 */
export const CLAUSES: readonly Clause[] = [
  {
    id: ClauseId.ENVIRONMENT,
    text: "The mandate's environment must match the environment BONDED is running against.",
    requires: [],
    evaluate: (ctx) =>
      ctx.mandate.spec.env === ctx.runtimeEnv
        ? ALLOW
        : deny({
            clause: ClauseId.ENVIRONMENT,
            clauseText:
              "The mandate's environment must match the environment BONDED is running against.",
            observed: `mandate env ${ctx.mandate.spec.env}, runtime env ${ctx.runtimeEnv}`,
          }),
  },

  {
    id: ClauseId.SCOPE,
    text: "Trade scope must not have been revoked.",
    requires: [],
    evaluate: (ctx) =>
      ctx.scopeRevoked
        ? deny({
            clause: ClauseId.SCOPE,
            clauseText: "Trade scope must not have been revoked.",
            observed: "scope revoked",
          })
        : ALLOW,
  },

  {
    id: ClauseId.AUDIT_PATH,
    text: "Reconciliation must be able to observe the account before an order is placed.",
    requires: [],
    evaluate: (ctx) =>
      ctx.auditPathHealthy
        ? ALLOW
        : deny({
            clause: ClauseId.AUDIT_PATH,
            clauseText:
              "Reconciliation must be able to observe the account before an order is placed.",
            observed: "no order source is delivering",
          }),
  },

  {
    id: ClauseId.EXPIRY,
    text: "The mandate must not have expired.",
    requires: [],
    evaluate: (ctx) =>
      ctx.nowMs < ctx.mandate.expiresAtMs
        ? ALLOW
        : deny({
            clause: ClauseId.EXPIRY,
            clauseText: "The mandate must not have expired.",
            observed: new Date(ctx.nowMs).toISOString(),
            limit: ctx.mandate.spec.expiresAt,
          }),
  },

  {
    id: ClauseId.SYMBOL_ALLOWLIST,
    text: "The symbol must appear in the mandate's allowlist.",
    requires: [],
    evaluate: (ctx) =>
      ctx.mandate.symbols.has(ctx.intent.symbol)
        ? ALLOW
        : deny({
            clause: ClauseId.SYMBOL_ALLOWLIST,
            clauseText: "The symbol must appear in the mandate's allowlist.",
            observed: ctx.intent.symbol,
            // The allowed set is not disclosed: the agent learns by refusal, one
            // clause at a time, and never reads the mandate's contents.
            limit: `${String(ctx.mandate.symbols.size)} allowed symbols`,
          }),
  },

  {
    id: ClauseId.SYMBOL_TRADABLE,
    text: "The symbol must currently be trading on the exchange.",
    requires: [],
    evaluate: (ctx) =>
      isTradingEnabled(ctx.symbolRules)
        ? ALLOW
        : deny({
            clause: ClauseId.SYMBOL_TRADABLE,
            clauseText: "The symbol must currently be trading on the exchange.",
            observed: `${ctx.intent.symbol} status ${ctx.symbolRules.status}`,
            limit: "TRADING",
          }),
  },

  {
    id: ClauseId.ORDER_TYPE,
    text: "The order type must be permitted by the mandate.",
    requires: [],
    evaluate: (ctx) => {
      const type = orderTypeOf(ctx.intent);
      return ctx.mandate.orderTypes.has(type)
        ? ALLOW
        : deny({
            clause: ClauseId.ORDER_TYPE,
            clauseText: "The order type must be permitted by the mandate.",
            observed: type,
            limit: [...ctx.mandate.orderTypes].join(", "),
          });
    },
  },

  {
    id: ClauseId.SIDE,
    text: "The order side must be permitted by the mandate.",
    requires: [],
    evaluate: (ctx) =>
      ctx.mandate.sides.has(ctx.intent.side)
        ? ALLOW
        : deny({
            clause: ClauseId.SIDE,
            clauseText: "The order side must be permitted by the mandate.",
            observed: ctx.intent.side,
            limit: [...ctx.mandate.sides].join(", "),
          }),
  },

  {
    id: ClauseId.TRADING_WINDOW,
    text: "The order must fall inside the mandate's UTC trading window.",
    requires: [],
    evaluate: (ctx) => {
      const minute = utcMinutesOfDay(ctx.nowMs);
      const { windowStartMinute, windowEndMinute } = ctx.mandate;
      return minute >= windowStartMinute && minute <= windowEndMinute
        ? ALLOW
        : deny({
            clause: ClauseId.TRADING_WINDOW,
            clauseText: "The order must fall inside the mandate's UTC trading window.",
            observed: formatMinute(minute),
            limit: `${ctx.mandate.spec.tradingWindowUtc[0]}–${ctx.mandate.spec.tradingWindowUtc[1]} UTC`,
          });
    },
  },

  {
    id: ClauseId.ACCOUNT_TRADING_DISABLED,
    text: "The exchange account must be permitted to trade.",
    requires: ["account"],
    evaluate: (ctx) =>
      ctx.state.account.canTrade
        ? ALLOW
        : deny({
            clause: ClauseId.ACCOUNT_TRADING_DISABLED,
            clauseText: "The exchange account must be permitted to trade.",
            observed: "canTrade=false",
          }),
  },

  {
    id: ClauseId.MAX_OPEN_ORDERS,
    text: "The number of open orders must stay within the mandate's limit.",
    requires: ["account"],
    evaluate: (ctx) => {
      // Observed count plus what this process has placed since that observation. The
      // snapshot alone lags by up to its freshness budget, and an aggregate cap that
      // lags is not a cap.
      const open = ctx.state.account.openOrderCount + ctx.pendingOpenOrders;
      // `>=` because this order would become the next one.
      return open >= ctx.mandate.spec.maxOpenOrders
        ? deny({
            clause: ClauseId.MAX_OPEN_ORDERS,
            clauseText: "The number of open orders must stay within the mandate's limit.",
            observed:
              ctx.pendingOpenOrders === 0
                ? String(open)
                : `${String(open)} (${String(ctx.state.account.openOrderCount)} observed, ${String(ctx.pendingOpenOrders)} in flight)`,
            limit: String(ctx.mandate.spec.maxOpenOrders),
          })
        : ALLOW;
    },
  },

  {
    id: ClauseId.PRICE_FILTER,
    text: "A limit price must respect the symbol's tick size and price bounds.",
    requires: [],
    evaluate: (ctx) => {
      if (ctx.intent.kind !== "LIMIT") return ALLOW;
      const { price } = ctx.intent;
      const rules = ctx.symbolRules;
      if (!isMultipleOf(price, rules.tickSize)) {
        return deny({
          clause: ClauseId.PRICE_FILTER,
          clauseText: "A limit price must respect the symbol's tick size and price bounds.",
          observed: price,
          limit: `multiple of ${rules.tickSize}`,
        });
      }
      if (lessThan(price, rules.minPrice) || outsideMax(price, rules.maxPrice)) {
        return deny({
          clause: ClauseId.PRICE_FILTER,
          clauseText: "A limit price must respect the symbol's tick size and price bounds.",
          observed: price,
          limit: `${rules.minPrice}–${rules.maxPrice}`,
        });
      }
      return ALLOW;
    },
  },

  {
    id: ClauseId.LOT_SIZE,
    text: "The order quantity must respect the symbol's lot size and quantity bounds.",
    requires: [],
    evaluate: (ctx) => {
      // A quote-denominated market order carries no base quantity to check; Binance
      // derives it at execution time and applies the filter itself.
      if (ctx.intent.kind === "MARKET_QUOTE") return ALLOW;
      const { quantity } = ctx.intent;
      const rules = ctx.symbolRules;
      if (!isMultipleOf(quantity, rules.stepSize)) {
        return deny({
          clause: ClauseId.LOT_SIZE,
          clauseText: "The order quantity must respect the symbol's lot size and quantity bounds.",
          observed: quantity,
          limit: `multiple of ${rules.stepSize}`,
        });
      }
      if (lessThan(quantity, rules.minQty) || outsideMax(quantity, rules.maxQty)) {
        return deny({
          clause: ClauseId.LOT_SIZE,
          clauseText: "The order quantity must respect the symbol's lot size and quantity bounds.",
          observed: quantity,
          limit: `${rules.minQty}–${rules.maxQty}`,
        });
      }
      return ALLOW;
    },
  },

  {
    id: ClauseId.MIN_NOTIONAL,
    text: "The order notional must meet the symbol's minimum.",
    requires: [],
    evaluate: (ctx) =>
      lessThan(ctx.notionalUsd, ctx.symbolRules.minNotional)
        ? deny({
            clause: ClauseId.MIN_NOTIONAL,
            clauseText: "The order notional must meet the symbol's minimum.",
            observed: ctx.notionalUsd,
            limit: ctx.symbolRules.minNotional,
          })
        : ALLOW,
  },

  {
    id: ClauseId.MAX_NOTIONAL,
    text: "The order notional must not exceed the mandate's maximum.",
    requires: [],
    evaluate: (ctx) =>
      greaterThan(ctx.notionalUsd, ctx.mandate.maxNotionalUsd)
        ? deny({
            clause: ClauseId.MAX_NOTIONAL,
            clauseText: "The order notional must not exceed the mandate's maximum.",
            observed: ctx.notionalUsd,
            limit: ctx.mandate.maxNotionalUsd,
          })
        : ALLOW,
  },

  {
    id: ClauseId.DAILY_LOSS_LIMIT,
    text: "The realised loss for the current UTC day must not exceed the mandate's limit.",
    requires: ["dailyPnl"],
    evaluate: (ctx) => {
      const realised = ctx.state.dailyPnl.realisedUsd;
      if (!isNegative(realised)) return ALLOW;
      // `realised` is negative here, so its magnitude is the loss so far.
      const loss = multiply(realised, NEGATIVE_ONE);
      return compare(loss, ctx.mandate.dailyLossLimitUsd) >= 0
        ? deny({
            clause: ClauseId.DAILY_LOSS_LIMIT,
            clauseText:
              "The realised loss for the current UTC day must not exceed the mandate's limit.",
            observed: loss,
            limit: ctx.mandate.dailyLossLimitUsd,
          })
        : ALLOW;
    },
  },

  {
    id: ClauseId.MAX_DRAWDOWN,
    text: "The day's realised loss must not exceed the mandate's percentage of quote balance.",
    requires: ["dailyPnl"],
    evaluate: (ctx) => {
      const realised = ctx.state.dailyPnl.realisedUsd;
      if (!isNegative(realised)) return ALLOW;

      // An unobserved balance is not a zero balance. Allowing here would turn a
      // proportional cap into no cap at all, which is precisely the fail-open this
      // component's first invariant forbids.
      if (!ctx.state.dailyPnl.quoteBalanceKnown) {
        return deny({
          clause: ClauseId.MAX_DRAWDOWN,
          clauseText:
            "The day's realised loss must not exceed the mandate's percentage of quote balance.",
          observed: "quote balance could not be observed",
          limit: `${ctx.mandate.spec.maxDrawdownPct}% of balance`,
        });
      }

      const balance = ctx.state.dailyPnl.quoteBalance;
      // A balance genuinely observed as zero leaves nothing to take a percentage of.
      // The absolute `dailyLossLimitUsd` clause still binds.
      if (compare(balance, ZERO) <= 0) return ALLOW;

      const loss = multiply(realised, NEGATIVE_ONE);
      const allowed = percentOf(balance, ctx.mandate.maxDrawdownPct);
      return compare(loss, allowed) >= 0
        ? deny({
            clause: ClauseId.MAX_DRAWDOWN,
            clauseText:
              "The day's realised loss must not exceed the mandate's percentage of quote balance.",
            observed: `${loss} of ${balance}`,
            limit: `${allowed} (${ctx.mandate.spec.maxDrawdownPct}% of balance)`,
          })
        : ALLOW;
    },
  },
];

const NEGATIVE_ONE = "-1" as DecimalString;

/** A max of `"0"` means the filter is disabled, matching Binance's convention. */
function outsideMax(value: DecimalString, max: DecimalString): boolean {
  if (compare(max, ZERO) === 0) return false;
  return greaterThan(value, max);
}

function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} UTC`;
}

/**
 * Derive the order's notional in quote-asset units.
 *
 * Exact for limit and quote-denominated market orders. For a base-denominated market
 * order there is no exact answer before execution, so a live reference price is used —
 * and if one is not available, or is stale, the order is denied rather than estimated.
 */
function deriveNotional(
  input: GateInput,
): { ok: true; value: DecimalString } | { ok: false; verdict: Verdict } {
  const { intent, state, nowMs } = input;

  if (intent.kind === "LIMIT") {
    return { ok: true, value: multiply(intent.price, intent.quantity) };
  }
  if (intent.kind === "MARKET_QUOTE") {
    return { ok: true, value: intent.quoteOrderQty };
  }

  if (isStale(state.prices.observedAtMs, nowMs, SNAPSHOT_BUDGETS.prices)) {
    return {
      ok: false,
      verdict: denyStale("prices", nowMs - state.prices.observedAtMs),
    };
  }
  const price = state.prices.prices.get(intent.symbol);
  if (price === undefined) {
    return {
      ok: false,
      verdict: deny({
        clause: ClauseId.REFERENCE_PRICE,
        clauseText:
          "A market order sized in the base asset requires a live reference price to bound its notional.",
        observed: `no reference price for ${intent.symbol}`,
      }),
    };
  }
  return { ok: true, value: multiply(price, intent.quantity) };
}

/**
 * Evaluate an order intent against a mandate.
 *
 * Returns the first denial encountered, or ALLOW if every clause passes. Never throws:
 * a thrown exception inside a gate is indistinguishable from "no rule fired", which is
 * exactly the failure mode this component exists to prevent.
 */
export function evaluate(input: GateInput): GateResult {
  const symbolRules = input.state.symbolRules.get(input.intent.symbol);
  if (symbolRules === undefined) {
    // Ungrounded symbol. The mandate compiler resolves every allowlisted symbol against
    // live exchangeInfo, so reaching here means either an unlisted symbol or a stale
    // rule set — both are denials, never assumptions.
    return {
      verdict: deny({
        clause: ClauseId.SYMBOL_ALLOWLIST,
        clauseText: "The symbol must be listed on the exchange and resolvable in exchangeInfo.",
        observed: input.intent.symbol,
      }),
    };
  }

  const notional = deriveNotional(input);
  if (!notional.ok) {
    return { verdict: notional.verdict };
  }

  const ctx: GateContext = { ...input, notionalUsd: notional.value, symbolRules };

  for (const clause of CLAUSES) {
    for (const snapshot of clause.requires) {
      const observedAt = snapshotObservedAt(ctx.state, snapshot);
      if (isStale(observedAt, ctx.nowMs, SNAPSHOT_BUDGETS[snapshot])) {
        return {
          verdict: denyStale(snapshot, ctx.nowMs - observedAt),
          notionalUsd: notional.value,
        };
      }
    }
    const verdict = clause.evaluate(ctx);
    if (verdict.outcome === "DENY") {
      return { verdict, notionalUsd: notional.value };
    }
  }

  return { verdict: ALLOW, notionalUsd: notional.value };
}
