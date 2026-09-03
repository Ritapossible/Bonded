/**
 * What the agent is asking to do.
 *
 * Modelled as a discriminated union rather than one struct with optional fields,
 * because Binance's three spot order shapes have genuinely different notional
 * arithmetic. A single struct with optional `price`, `quantity` and `quoteOrderQty`
 * would force every rule to re-derive which combination it is looking at, and the
 * first rule that gets that wrong fails open.
 */

import type { DecimalString } from "../core/money.js";
import type { OrderSide } from "./mandate.js";

interface IntentBase {
  readonly symbol: string;
  readonly side: OrderSide;
}

/** Limit order: an explicit price and base-asset quantity. Notional is exact. */
export interface LimitIntent extends IntentBase {
  readonly kind: "LIMIT";
  readonly quantity: DecimalString;
  readonly price: DecimalString;
}

/** Market order sized in the base asset. Notional must be estimated from a price. */
export interface MarketBaseIntent extends IntentBase {
  readonly kind: "MARKET_BASE";
  readonly quantity: DecimalString;
}

/** Market order sized in the quote asset. Notional is the quote quantity itself. */
export interface MarketQuoteIntent extends IntentBase {
  readonly kind: "MARKET_QUOTE";
  readonly quoteOrderQty: DecimalString;
}

export type OrderIntent = LimitIntent | MarketBaseIntent | MarketQuoteIntent;

/** The mandate-level order type an intent maps to. */
export function orderTypeOf(intent: OrderIntent): "LIMIT" | "MARKET" {
  return intent.kind === "LIMIT" ? "LIMIT" : "MARKET";
}

/** Short, non-sensitive description for logs and denial messages. */
export function describeIntent(intent: OrderIntent): string {
  switch (intent.kind) {
    case "LIMIT":
      return `${intent.side} ${intent.quantity} ${intent.symbol} @ ${intent.price}`;
    case "MARKET_BASE":
      return `${intent.side} ${intent.quantity} ${intent.symbol} @ market`;
    case "MARKET_QUOTE":
      return `${intent.side} ${intent.quoteOrderQty} quote of ${intent.symbol} @ market`;
  }
}
