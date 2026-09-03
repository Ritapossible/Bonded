/**
 * The gate's verdict, and the record written for it.
 *
 * Every evaluation produces a record — allows as well as denials. An audit trail that
 * only contains refusals cannot be reconciled against the exchange, because there is
 * nothing to match a filled order against. The allow records are the half that makes
 * bypass detection possible.
 */

import type { DecimalString } from "../core/money.js";
import type { OrderIntent } from "./intent.js";

/**
 * Stable clause identifiers. These appear in denial messages returned to the agent, in
 * the decision log, and in certificates — renaming one is a breaking change.
 */
export const ClauseId = {
  ENVIRONMENT: "environment",
  SCOPE: "scope",
  EXPIRY: "expiry",
  SYMBOL_ALLOWLIST: "symbolAllowlist",
  SYMBOL_TRADABLE: "symbolTradable",
  ORDER_TYPE: "orderType",
  SIDE: "side",
  REFERENCE_PRICE: "referencePrice",
  MAX_NOTIONAL: "maxNotionalUsd",
  MIN_NOTIONAL: "minNotional",
  LOT_SIZE: "lotSize",
  PRICE_FILTER: "priceFilter",
  MAX_OPEN_ORDERS: "maxOpenOrders",
  TRADING_WINDOW: "tradingWindowUtc",
  DAILY_LOSS_LIMIT: "dailyLossLimitUsd",
  ACCOUNT_TRADING_DISABLED: "accountTradingDisabled",
  STATE_FRESHNESS: "stateFreshness",
} as const;

export type ClauseId = (typeof ClauseId)[keyof typeof ClauseId];

/** Why an order was refused, in a form both a human and a machine can act on. */
export interface Denial {
  readonly clause: ClauseId;
  /** The rule as a sentence, quoted verbatim into denial messages and certificates. */
  readonly clauseText: string;
  /** What the order actually asked for, as a display string. */
  readonly observed: string;
  /** What the mandate permits. Absent for rules that are not a threshold. */
  readonly limit?: string;
}

export type Verdict =
  { readonly outcome: "ALLOW" } | { readonly outcome: "DENY"; readonly denial: Denial };

export const ALLOW: Verdict = { outcome: "ALLOW" };

export function deny(denial: Denial): Verdict {
  return { outcome: "DENY", denial };
}

/**
 * A single entry in the hash-chained decision log.
 *
 * `prevHash` links each record to the one before it, so BONDED cannot retroactively
 * edit its own history to hide a bad decision without breaking the chain. This is the
 * cheapest available approximation of an attested record — it does not stop a
 * determined operator rewriting the whole file, but it does stop a silent edit.
 */
export interface DecisionRecord {
  readonly seq: number;
  readonly prevHash: string;
  readonly ts: string;
  readonly mandateHash: string;
  readonly intent: OrderIntent;
  /** Notional as evaluated, when it could be determined. */
  readonly notionalUsd?: DecimalString;
  readonly outcome: "ALLOW" | "DENY";
  readonly denial?: Denial;
  /** Set only on ALLOW: the stamped id the exchange order will carry. */
  readonly clientOrderId?: string;
}

/** Genesis link for an empty log. */
export const GENESIS_HASH = "0".repeat(64);

/** Human-readable one-liner for logs and the console feed. */
export function describeVerdict(verdict: Verdict): string {
  if (verdict.outcome === "ALLOW") return "ALLOW";
  const { clause, observed, limit } = verdict.denial;
  return limit === undefined
    ? `DENY ${clause} — observed ${observed}`
    : `DENY ${clause} — observed ${observed}, limit ${limit}`;
}
