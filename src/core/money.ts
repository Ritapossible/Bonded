/**
 * Exact decimal arithmetic.
 *
 * Every monetary and quantity value in BONDED is a decimal *string*, never a JS
 * number. `0.1 + 0.2 !== 0.3` is not an acceptable failure mode in a component whose
 * job is deciding whether an order breaches a limit, and Binance itself returns
 * quantities and prices as strings for the same reason.
 *
 * This module is the only place `decimal.js` is imported. Everything above it works
 * with `DecimalString`, so a float can never reach a comparison by accident.
 */

import { Decimal } from "decimal.js";
import { ErrorCode, bondedError, type BondedError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

// 40 significant digits comfortably covers 8-decimal crypto quantities multiplied by
// prices. ROUND_DOWN because every rounding BONDED performs is a limit check, and a
// limit check must never round in the permissive direction.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN, toExpNeg: -30, toExpPos: 40 });

/**
 * A string known to parse as a finite decimal. The brand exists so that an arbitrary
 * `string` cannot be passed where a validated numeric value is required.
 */
export type DecimalString = string & { readonly __brand: "DecimalString" };

/** Matches a plain decimal literal. Exponent notation is rejected deliberately: it is
 * never produced by the Binance API and accepting it widens the parser for no gain. */
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseDecimal(input: string, field: string): Result<DecimalString, BondedError> {
  if (!DECIMAL_PATTERN.test(input)) {
    return err(
      bondedError(ErrorCode.DECIMAL_INVALID, `${field} is not a plain decimal value`, {
        field,
        value: input,
      }),
    );
  }
  // Defence in depth: the pattern should already guarantee this.
  if (!new Decimal(input).isFinite()) {
    return err(
      bondedError(ErrorCode.DECIMAL_INVALID, `${field} is not finite`, { field, value: input }),
    );
  }
  return ok(input as DecimalString);
}

/** Parse, requiring a value strictly greater than zero. */
export function parsePositiveDecimal(
  input: string,
  field: string,
): Result<DecimalString, BondedError> {
  const parsed = parseDecimal(input, field);
  if (!parsed.ok) return parsed;
  if (new Decimal(parsed.value).lte(0)) {
    return err(
      bondedError(ErrorCode.DECIMAL_INVALID, `${field} must be greater than zero`, {
        field,
        value: input,
      }),
    );
  }
  return parsed;
}

/** Assert at a trusted boundary — tests and literals only. Throws on bad input. */
export function decimalUnsafe(input: string): DecimalString {
  const parsed = parseDecimal(input, "literal");
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function d(value: DecimalString): Decimal {
  return new Decimal(value);
}

/** Normalised string form: no exponent, no trailing zeros, `-0` collapsed to `0`. */
function format(value: Decimal): DecimalString {
  return (value.isZero() ? "0" : value.toFixed()) as DecimalString;
}

export function multiply(a: DecimalString, b: DecimalString): DecimalString {
  return format(d(a).times(d(b)));
}

export function add(a: DecimalString, b: DecimalString): DecimalString {
  return format(d(a).plus(d(b)));
}

export function subtract(a: DecimalString, b: DecimalString): DecimalString {
  return format(d(a).minus(d(b)));
}

export function absolute(a: DecimalString): DecimalString {
  return format(d(a).abs());
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compare(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return d(a).comparedTo(d(b)) as -1 | 0 | 1;
}

export function greaterThan(a: DecimalString, b: DecimalString): boolean {
  return compare(a, b) > 0;
}

export function lessThan(a: DecimalString, b: DecimalString): boolean {
  return compare(a, b) < 0;
}

export function isZero(a: DecimalString): boolean {
  return d(a).isZero();
}

export function isNegative(a: DecimalString): boolean {
  return d(a).isNegative() && !d(a).isZero();
}

/**
 * Whether `value` is an exact integer multiple of `step`.
 *
 * This implements Binance's `LOT_SIZE` / `PRICE_FILTER` semantics, where a quantity
 * must land exactly on a `stepSize` boundary. Modulo on decimals is exact here because
 * decimal.js works in base 10 — the same check in floating point produces false
 * rejections on values like 0.1 that have no exact binary representation.
 *
 * A `step` of zero means "unconstrained", matching how Binance disables a filter.
 */
export function isMultipleOf(value: DecimalString, step: DecimalString): boolean {
  const stepDecimal = d(step);
  if (stepDecimal.isZero()) return true;
  return d(value).modulo(stepDecimal).isZero();
}

/**
 * Exact division, rounding **down** to 18 decimal places.
 *
 * Division is the one operation here that cannot always be exact — 1/3 has no finite
 * decimal form — so it is the one operation that needs a documented rounding rule.
 * `ROUND_DOWN` is chosen because every quotient in BONDED feeds a cost basis, and
 * understating a cost basis understates a profit rather than a loss. A limit check must
 * never round in the permissive direction.
 *
 * Dividing by zero returns zero rather than producing `Infinity`, which would silently
 * defeat every downstream comparison.
 */
export function divide(numerator: DecimalString, denominator: DecimalString): DecimalString {
  const divisor = d(denominator);
  if (divisor.isZero()) return ZERO;
  return format(d(numerator).dividedBy(divisor).toDecimalPlaces(18, Decimal.ROUND_DOWN));
}

/** Percentage of a base value: `percentOf("200", "5")` is `"10"`. */
export function percentOf(base: DecimalString, percent: DecimalString): DecimalString {
  return format(d(base).times(d(percent)).dividedBy(100));
}

export const ZERO = "0" as DecimalString;
