/**
 * Exchange-derived facts the gate needs.
 *
 * Everything here originates from Binance, never from BONDED's own bookkeeping. The
 * project rule is that state is *derived, never remembered*: if a restart resets the
 * daily loss limit, the limit is theatre. So the gate is handed a snapshot of what the
 * exchange currently says, together with the time it was observed, and it refuses to
 * act on a snapshot that has gone stale.
 */

import type { DecimalString } from "../core/money.js";

/**
 * The subset of a symbol's Binance filters that the gate enforces.
 *
 * These are inherited into the mandate rather than configured: an operator writing
 * "trade ETHUSDT" is implicitly accepting whatever tick and lot constraints Binance
 * publishes for it. Grounding against the live `exchangeInfo` is also what stops a
 * mandate naming an instrument that does not exist.
 */
export interface SymbolRules {
  readonly symbol: string;
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** PRICE_FILTER. `"0"` means unconstrained. */
  readonly tickSize: DecimalString;
  readonly minPrice: DecimalString;
  readonly maxPrice: DecimalString;
  /** LOT_SIZE. `"0"` means unconstrained. */
  readonly stepSize: DecimalString;
  readonly minQty: DecimalString;
  readonly maxQty: DecimalString;
  /** NOTIONAL / MIN_NOTIONAL. */
  readonly minNotional: DecimalString;
}

/** Whether the symbol is currently accepting orders. */
export function isTradingEnabled(rules: SymbolRules): boolean {
  return rules.status === "TRADING";
}

/**
 * A point-in-time view of the account, as reported by Binance.
 *
 * `observedAtMs` is not decoration. Every consumer checks it against a freshness
 * budget, because evaluating a drawdown limit against a stale balance is how a gate
 * silently stops enforcing the rule that matters most.
 */
export interface AccountSnapshot {
  readonly observedAtMs: number;
  readonly canTrade: boolean;
  /** Free balance by asset. Assets with a zero balance may be omitted. */
  readonly balances: ReadonlyMap<string, DecimalString>;
  readonly openOrderCount: number;
}

/** A reference price per symbol, used to estimate the notional of a market order. */
export interface PriceSnapshot {
  readonly observedAtMs: number;
  readonly prices: ReadonlyMap<string, DecimalString>;
}

/**
 * Realised profit and loss for the current UTC day, computed from the exchange's own
 * trade history rather than from a counter BONDED increments.
 */
export interface DailyPnl {
  readonly observedAtMs: number;
  /** UTC `YYYY-MM-DD` the figure covers. */
  readonly dayKey: string;
  /** Negative means a loss. Quote-asset units. See `domain/pnl.ts` for the definition. */
  readonly realisedUsd: DecimalString;
  /**
   * Quote-asset balance the drawdown limit is measured against.
   *
   * `maxDrawdownPct` is a proportional cap: it binds when the day's realised loss reaches
   * this percentage of the account's quote-asset holdings. It sits alongside the absolute
   * `dailyLossLimitUsd`, and whichever is tighter fires first.
   */
  readonly quoteBalance: DecimalString;
  /**
   * True when some of the day's sells had no known cost basis, so `realisedUsd`
   * understates activity. The gate still enforces on the figure it has — under-reporting
   * a loss must not become a reason to stop enforcing — but the caller can surface it.
   */
  readonly incomplete: boolean;
}

/** Everything the gate may read about the world. Assembled by the shell, never fetched by a rule. */
export interface ExchangeState {
  readonly account: AccountSnapshot;
  readonly prices: PriceSnapshot;
  readonly dailyPnl: DailyPnl;
  readonly symbolRules: ReadonlyMap<string, SymbolRules>;
}

/**
 * How old a snapshot may be before the gate treats it as unusable.
 *
 * Deliberately tight. The failure mode this defends against is an exchange outage
 * quietly converting a bounded mandate into an unbounded one, so BONDED denies rather
 * than trusting a snapshot it can no longer vouch for.
 */
export const STALENESS_BUDGET_MS = {
  account: 10_000,
  prices: 5_000,
  dailyPnl: 30_000,
} as const;

export function ageMs(observedAtMs: number, nowMs: number): number {
  return nowMs - observedAtMs;
}

export function isStale(observedAtMs: number, nowMs: number, budgetMs: number): boolean {
  const age = ageMs(observedAtMs, nowMs);
  // A snapshot from the future indicates clock skew between BONDED and the exchange.
  // That is not a condition to reason through — treat it as unusable.
  return age < 0 || age > budgetMs;
}
