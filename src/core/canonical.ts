/**
 * Deterministic JSON serialisation and hashing.
 *
 * A mandate hash is only meaningful if two parties that hold the same mandate compute
 * the same digest. That requires a canonical byte representation: fixed key order,
 * no insignificant whitespace, and one unambiguous spelling for every value.
 *
 * This is a deliberately **restricted** profile of RFC 8785 (JCS). Full JCS has to
 * define a serialisation for arbitrary IEEE-754 doubles, which is the part that is
 * both fiddly and easy to get subtly wrong across implementations. BONDED sidesteps
 * it: every numeric value in a mandate is either a safe integer or a decimal *string*
 * (see `money.ts`), so no float ever reaches the serialiser. Anything outside the
 * supported profile is rejected loudly rather than serialised on a guess.
 *
 * Supported: objects, arrays, strings, booleans, null, and safe integers.
 * Rejected: non-integer numbers, non-finite numbers, integers beyond
 * `Number.MAX_SAFE_INTEGER`, `undefined`, functions, symbols, bigints, and strings
 * containing unpaired surrogates.
 */

import { createHash } from "node:crypto";
import { ErrorCode, bondedError, type BondedError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function unsupported(reason: string, path: string): BondedError {
  return bondedError(ErrorCode.CANONICALIZATION_UNSUPPORTED, reason, { path });
}

/** Reject unpaired surrogates, which have no well-defined UTF-8 encoding. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * JCS orders object members by the UTF-16 code units of their keys, which is exactly
 * what JavaScript's default string comparison does. Using `localeCompare` here would
 * be locale-dependent and is a classic source of cross-machine hash drift.
 */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string): Result<string, BondedError> {
  if (value === null) return ok("null");

  switch (typeof value) {
    case "boolean":
      return ok(value ? "true" : "false");

    case "string":
      if (hasLoneSurrogate(value)) {
        return err(unsupported("string contains an unpaired surrogate", path));
      }
      return ok(JSON.stringify(value));

    case "number":
      if (!Number.isFinite(value)) return err(unsupported("number is not finite", path));
      if (!Number.isInteger(value)) {
        return err(
          unsupported("non-integer number: represent fractional values as decimal strings", path),
        );
      }
      if (!Number.isSafeInteger(value)) {
        return err(unsupported("integer exceeds the safe range", path));
      }
      // Safe integers have exactly one decimal spelling, so this is canonical.
      return ok(String(value));

    case "object":
      break;

    default:
      return err(unsupported(`unsupported type: ${typeof value}`, path));
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const [index, element] of value.entries()) {
      const serialized = serialize(element, `${path}[${String(index)}]`);
      if (!serialized.ok) return serialized;
      parts.push(serialized.value);
    }
    return ok(`[${parts.join(",")}]`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareKeys);
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    // An explicit `undefined` is almost always an accidental omission rather than an
    // intentional absence. Dropping it silently would let two different objects hash
    // identically, so it is an error.
    if (child === undefined) {
      return err(unsupported("undefined value: omit the key instead", `${path}.${key}`));
    }
    const serialized = serialize(child, `${path}.${key}`);
    if (!serialized.ok) return serialized;
    parts.push(`${JSON.stringify(key)}:${serialized.value}`);
  }
  return ok(`{${parts.join(",")}}`);
}

/** Canonical JSON text for a supported value. */
export function canonicalize(value: unknown): Result<string, BondedError> {
  return serialize(value, "$");
}

/** Lowercase hex SHA-256 of the canonical form. */
export function canonicalHash(value: unknown): Result<string, BondedError> {
  const canonical = canonicalize(value);
  if (!canonical.ok) return canonical;
  return ok(createHash("sha256").update(canonical.value, "utf8").digest("hex"));
}

/** Hash of arbitrary text — used for the decision log chain, not for structured values. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First 8 hex characters, for human-readable references. Never for security decisions. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
