/**
 * Orders as the *exchange* reports them.
 *
 * This is the second of the two independent accounts reconciliation compares. The
 * first is BONDED's own decision log; this one is Binance's, and it includes orders
 * BONDED never saw — which is precisely the point. A gate is structurally blind to
 * anything that goes around it, so the only way to detect a bypass is to ask the
 * exchange what actually happened and diff.
 *
 * Two wire formats carry the same information and both are normalised here:
 *
 * - `executionReport` — pushed on the user data stream, in real time.
 * - `GET /api/v3/allOrders` — the polling backstop, used when the stream is
 *   unavailable and to close any gap after a reconnect.
 */

import { z } from "zod";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import type { DecimalString } from "../core/money.js";
import { err, ok, type Result } from "../core/result.js";

/** A normalised order observation, independent of which endpoint produced it. */
export interface ObservedOrder {
  readonly symbol: string;
  readonly orderId: number;
  /** May be empty: Binance substitutes its own id when a client does not supply one. */
  readonly clientOrderId: string;
  readonly side: "BUY" | "SELL";
  readonly type: string;
  readonly status: string;
  readonly price: DecimalString;
  readonly origQty: DecimalString;
  readonly executedQty: DecimalString;
  /**
   * Quote-asset value actually transacted, when the source reported it.
   *
   * Carried because a quote-denominated market order has no base quantity to compare:
   * without this, an authorisation to spend 100 USDT matched an order that spent
   * 100,000 and was classified AUTHORISED — the one outcome that does not burn the bond.
   *
   * Optional, and deliberately not defaulted to zero. Zero means "spent nothing", which
   * passes every overspend check there is; an absent field means "not reported", which
   * has to be said out loud rather than silently read as compliance.
   */
  readonly cummulativeQuoteQty?: DecimalString;
  /** How long the order was to remain live. BONDED authorises GTC and nothing else. */
  readonly timeInForce: string;
  /** Exchange-side event time, in epoch milliseconds. */
  readonly observedAtMs: number;
  /** Which account this observation came from — useful in findings and logs. */
  readonly source: "stream" | "poll";
}

const numericString = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "not a plain decimal");

/**
 * `executionReport` payload.
 *
 * Binance uses single-letter keys on the stream. Only the fields reconciliation needs
 * are modelled; unknown keys are ignored so a payload gaining a field does not break
 * the audit path.
 */
const ExecutionReportSchema = z.object({
  e: z.literal("executionReport"),
  E: z.number(),
  s: z.string(),
  c: z.string(),
  S: z.enum(["BUY", "SELL"]),
  o: z.string(),
  q: numericString,
  p: numericString,
  X: z.string(),
  i: z.number(),
  z: numericString,
  /** Present when this report is the result of a cancel/replace; the original id. */
  C: z.string().optional(),
  /** Cumulative quote-asset value transacted. */
  Z: numericString.optional(),
  /** Time in force. */
  f: z.string().optional(),
});

const AllOrdersEntrySchema = z.object({
  symbol: z.string(),
  orderId: z.number(),
  clientOrderId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  type: z.string(),
  status: z.string(),
  price: numericString,
  origQty: numericString,
  executedQty: numericString,
  cummulativeQuoteQty: numericString.optional(),
  timeInForce: z.string().optional(),
  time: z.number().optional(),
  updateTime: z.number().optional(),
});

function malformed(what: string, issues: z.ZodIssue[]): BondedError {
  return bondedError(ErrorCode.EXCHANGE_MALFORMED_RESPONSE, `unexpected ${what} shape`, {
    issues: issues.slice(0, 5).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

/**
 * Normalise an `executionReport` event.
 *
 * A cancel/replace reports the *new* order under `c` and the replaced one under `C`.
 * Reconciliation follows `c`, because that is the order that now exists on the book
 * and therefore the one that needs an authorisation.
 */
export function parseExecutionReport(raw: unknown): Result<ObservedOrder, BondedError> {
  const parsed = ExecutionReportSchema.safeParse(raw);
  if (!parsed.success) return err(malformed("executionReport", parsed.error.issues));
  const event = parsed.data;

  return ok({
    symbol: event.s,
    orderId: event.i,
    clientOrderId: event.c,
    side: event.S,
    type: event.o,
    status: event.X,
    price: event.p as DecimalString,
    origQty: event.q as DecimalString,
    executedQty: event.z as DecimalString,
    ...(event.Z === undefined ? {} : { cummulativeQuoteQty: event.Z as DecimalString }),
    timeInForce: event.f ?? "",
    observedAtMs: event.E,
    source: "stream",
  });
}

/** Normalise a `GET /api/v3/allOrders` array. */
export function parseAllOrders(raw: unknown): Result<ObservedOrder[], BondedError> {
  if (!Array.isArray(raw)) {
    return err(
      bondedError(ErrorCode.EXCHANGE_MALFORMED_RESPONSE, "allOrders did not return an array"),
    );
  }
  const orders: ObservedOrder[] = [];
  for (const entry of raw) {
    const parsed = AllOrdersEntrySchema.safeParse(entry);
    if (!parsed.success) return err(malformed("allOrders entry", parsed.error.issues));
    const order = parsed.data;
    orders.push({
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      type: order.type,
      status: order.status,
      price: order.price as DecimalString,
      origQty: order.origQty as DecimalString,
      executedQty: order.executedQty as DecimalString,
      ...(order.cummulativeQuoteQty === undefined
        ? {}
        : { cummulativeQuoteQty: order.cummulativeQuoteQty as DecimalString }),
      timeInForce: order.timeInForce ?? "",
      observedAtMs: order.updateTime ?? order.time ?? 0,
      source: "poll",
    });
  }
  return ok(orders);
}

/** Stable key for de-duplicating observations arriving from both sources. */
export function observationKey(order: ObservedOrder): string {
  return `${order.symbol}:${String(order.orderId)}`;
}
