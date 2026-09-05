/**
 * Reconciliation: classifying an observed order against what BONDED authorised.
 *
 * A pure function, for the same reason the gate is one — this is the component whose
 * output burns the bond, so it must be exhaustively testable and produce the same
 * verdict for the same inputs every time.
 *
 * The method is a differential oracle. Two independent accounts of the same reality
 * exist — BONDED's authorisation log and the exchange's order history — and *neither
 * is trusted over the other*. Agreement is unremarkable; disagreement is the finding.
 * No ground truth is required, only that both must agree.
 *
 * There are five outcomes, and the differences between them matter:
 *
 * | Outcome | Meaning |
 * | --- | --- |
 * | `AUTHORISED` | An order BONDED allowed, executed as authorised |
 * | `MISMATCHED` | Authorised, but the order that executed is not the one authorised |
 * | `FOREIGN` | No BONDED identifier at all — a plain bypass |
 * | `FORGED` | Wears BONDED's namespace without a valid tag |
 * | `UNKNOWN_AUTHENTIC` | Tag verifies, but no matching record — a log-integrity problem |
 */

import { verifyClientOrderId } from "../audit/client-order-id.js";
import { compare, greaterThan, type DecimalString } from "../core/money.js";
import { authorisedParameters, type Authorisation } from "./authorisation-index.js";
import type { ObservedOrder } from "./observed-order.js";

export const ReconciliationOutcome = {
  AUTHORISED: "AUTHORISED",
  MISMATCHED: "MISMATCHED",
  FOREIGN: "FOREIGN",
  FORGED: "FORGED",
  UNKNOWN_AUTHENTIC: "UNKNOWN_AUTHENTIC",
} as const;

export type ReconciliationOutcome =
  (typeof ReconciliationOutcome)[keyof typeof ReconciliationOutcome];

/**
 * Severity ordering, most serious first.
 *
 * `FORGED` outranks `FOREIGN` deliberately. An unbranded order is someone using the
 * key directly; a forged one is someone *imitating the authorisation namespace*, which
 * is an attempt to make a bypass look authorised.
 */
const SEVERITY: Record<ReconciliationOutcome, number> = {
  FORGED: 0,
  FOREIGN: 1,
  MISMATCHED: 2,
  UNKNOWN_AUTHENTIC: 3,
  AUTHORISED: 4,
};

export function isFinding(outcome: ReconciliationOutcome): boolean {
  return outcome !== ReconciliationOutcome.AUTHORISED;
}

export function compareSeverity(a: ReconciliationOutcome, b: ReconciliationOutcome): number {
  return SEVERITY[a] - SEVERITY[b];
}

/**
 * A reconciliation finding, carrying everything needed to act on it.
 *
 * The four-part shape is deliberate: a plain explanation, the verbatim evidence, an
 * external reference anyone can check without trusting BONDED, and an explicit list of
 * what could *not* be determined. Most tools ship only the first. The other three are
 * what make a finding safe to act on — and naming the gaps beats smoothing over them.
 */
export interface Finding {
  readonly outcome: ReconciliationOutcome;
  /** One sentence, for a human. */
  readonly explanation: string;
  /** The order exactly as the exchange reported it. */
  readonly evidence: ObservedOrder;
  /** Checkable against Binance independently of BONDED. */
  readonly reference: { readonly symbol: string; readonly orderId: number };
  /** The authorisation this was matched against, when one was found. */
  readonly authorisation?: Authorisation;
  /** What this classification could not establish. Never omitted, never empty-by-default. */
  readonly uncertainty: readonly string[];
}

export interface ClassifyInput {
  readonly order: ObservedOrder;
  readonly hmacSecret: string;
  readonly mandateHash: string;
  /** Authorisation for this order's client id, if the index holds one. */
  readonly authorisation: Authorisation | undefined;
}

/** Market orders report a zero price; only a limit price is meaningful to compare. */
function priceIsComparable(order: ObservedOrder): boolean {
  return order.type === "LIMIT";
}

function equal(a: DecimalString, b: DecimalString): boolean {
  return compare(a, b) === 0;
}

/**
 * Compare an executed order against the parameters that were authorised.
 *
 * Returns the list of fields that disagree. An empty list means the order that
 * executed is the order that was authorised.
 */
function parameterMismatches(order: ObservedOrder, authorisation: Authorisation): string[] {
  const expected = authorisedParameters(authorisation.intent);
  const mismatches: string[] = [];

  if (expected.unrecognisedIntent === true) {
    // A record written by a different version of BONDED. This build cannot say what was
    // authorised, so it does not claim the order matches it.
    return ["intent: the authorising record uses a shape this version does not recognise"];
  }

  if (order.symbol !== expected.symbol) {
    mismatches.push(`symbol: authorised ${expected.symbol}, executed ${order.symbol}`);
  }
  if (order.side !== expected.side) {
    mismatches.push(`side: authorised ${expected.side}, executed ${order.side}`);
  }
  if (order.type !== expected.type) {
    mismatches.push(`type: authorised ${expected.type}, executed ${order.type}`);
  }
  if (expected.quantity !== undefined && !equal(order.origQty, expected.quantity)) {
    mismatches.push(`quantity: authorised ${expected.quantity}, executed ${order.origQty}`);
  }
  if (
    expected.price !== undefined &&
    priceIsComparable(order) &&
    !equal(order.price, expected.price)
  ) {
    mismatches.push(`price: authorised ${expected.price}, executed ${order.price}`);
  }
  // A quote-denominated market order has no base quantity to check, so without this the
  // only things bound were symbol, side and type: an authorisation to spend 100 USDT
  // matched an order that spent 100,000. Binance may spend slightly less than asked when
  // it cannot buy a whole lot, so overspend is the mismatch — underspend is normal.
  if (
    expected.quoteOrderQty !== undefined &&
    order.cummulativeQuoteQty !== undefined &&
    greaterThan(order.cummulativeQuoteQty, expected.quoteOrderQty)
  ) {
    mismatches.push(
      `quoteOrderQty: authorised ${expected.quoteOrderQty}, executed ${order.cummulativeQuoteQty}`,
    );
  }
  // BONDED sends GTC and only GTC. An order that executed IOC or FOK is not the order
  // that was authorised, however well the other fields line up. Blank means the source
  // did not report it, which is not evidence of a change.
  if (order.type === "LIMIT" && order.timeInForce !== "" && order.timeInForce !== "GTC") {
    mismatches.push(`timeInForce: authorised GTC, executed ${order.timeInForce}`);
  }
  return mismatches;
}

/** Uncertainties that apply to every observation from a given source. */
function baseUncertainty(order: ObservedOrder): string[] {
  const notes: string[] = [];
  if (order.source === "poll") {
    notes.push(
      "observed by polling, so the interval between placement and detection is not bounded",
    );
  }
  if (order.observedAtMs === 0) {
    notes.push("the exchange did not report an event time for this order");
  }
  return notes;
}

/**
 * Classify one observed order.
 *
 * Never throws. A classifier that can throw is a classifier that can silently stop
 * classifying, which would turn the bond into decoration.
 */
export function classify(input: ClassifyInput): Finding {
  const { order, hmacSecret, mandateHash, authorisation } = input;
  const reference = { symbol: order.symbol, orderId: order.orderId };
  const uncertainty = baseUncertainty(order);

  const verification = verifyClientOrderId(hmacSecret, mandateHash, order.clientOrderId);

  if (verification.kind === "foreign") {
    return {
      outcome: ReconciliationOutcome.FOREIGN,
      explanation:
        order.clientOrderId === ""
          ? "an order executed on this account that BONDED never authorised, and which carries no client order id"
          : "an order executed on this account that BONDED never authorised",
      evidence: order,
      reference,
      uncertainty: [
        ...uncertainty,
        // Stated plainly: reconciliation attributes, it does not prevent.
        "detection is after the fact; this order reached the exchange before BONDED observed it",
      ],
    };
  }

  if (verification.kind === "forged") {
    return {
      outcome: ReconciliationOutcome.FORGED,
      explanation: `an order executed wearing BONDED's identifier namespace but its authentication tag does not verify (${verification.reason})`,
      evidence: order,
      reference,
      uncertainty: [
        ...uncertainty,
        "a forged identifier implies the namespace format is known to whoever placed this order",
      ],
    };
  }

  if (authorisation === undefined) {
    return {
      outcome: ReconciliationOutcome.UNKNOWN_AUTHENTIC,
      explanation:
        "an order carries a valid BONDED authentication tag, but no matching record exists in the decision log",
      evidence: order,
      reference,
      uncertainty: [
        ...uncertainty,
        "this indicates either a truncated decision log or a second instance sharing the HMAC secret; both need investigating",
      ],
    };
  }

  // A size that could not be read is not a size that matched. Saying so is the whole
  // point of carrying uncertainty alongside the verdict.
  const expected = authorisedParameters(authorisation.intent);
  if (expected.quoteOrderQty !== undefined && order.cummulativeQuoteQty === undefined) {
    uncertainty.push(
      "the source did not report a quote-asset amount, so the size of this order was not checked against the authorisation",
    );
  }

  const mismatches = parameterMismatches(order, authorisation);
  if (mismatches.length > 0) {
    return {
      outcome: ReconciliationOutcome.MISMATCHED,
      explanation: `an authorised order executed with parameters that differ from those authorised — ${mismatches.join("; ")}`,
      evidence: order,
      reference,
      authorisation,
      uncertainty,
    };
  }

  return {
    outcome: ReconciliationOutcome.AUTHORISED,
    explanation: `order matches authorisation seq ${String(authorisation.seq)}`,
    evidence: order,
    reference,
    authorisation,
    uncertainty,
  };
}
