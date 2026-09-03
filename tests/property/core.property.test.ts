/**
 * Property tests for the value layer.
 *
 * These target the invariants the gate silently depends on. A bug in decimal
 * comparison or in canonicalisation would not announce itself — it would show up as a
 * limit that quietly fails to bind, or as two parties computing different mandate
 * hashes for the same rules. Both are the kind of defect that example-based tests
 * miss and generated inputs find.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalize } from "../../src/core/canonical.js";
import {
  compare,
  decimalUnsafe,
  isMultipleOf,
  multiply,
  parseDecimal,
  type DecimalString,
} from "../../src/core/money.js";
import { compileMandate, type MandateSpec } from "../../src/domain/mandate.js";
import { unwrap } from "../../src/core/result.js";

/** Plain decimal literals, including the values that break floating point. */
const decimalArb: fc.Arbitrary<DecimalString> = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, frac]) => `${String(whole)}.${String(frac).padStart(8, "0")}` as DecimalString);

/** JSON values inside the canonicaliser's supported profile. */
const canonicalValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.string(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
    tie("array"),
    tie("object"),
  ),
  array: fc.array(tie("value"), { maxLength: 5 }),
  object: fc.dictionary(fc.string(), tie("value"), { maxKeys: 5 }),
})).value;

describe("decimal arithmetic", () => {
  it("compare is a total order consistent with itself", () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(compare(a, b)).toBe(-compare(b, a) as -1 | 0 | 1);
      }),
    );
  });

  it("compare is transitive", () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, decimalArb, (a, b, c) => {
        const [x, y, z] = [a, b, c].sort((p, q) => compare(p, q)) as [
          DecimalString,
          DecimalString,
          DecimalString,
        ];
        expect(compare(x, y)).toBeLessThanOrEqual(0);
        expect(compare(y, z)).toBeLessThanOrEqual(0);
        expect(compare(x, z)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it("multiplication is commutative", () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(multiply(a, b)).toBe(multiply(b, a));
      }),
    );
  });

  it("every product re-parses as a valid decimal", () => {
    // The gate compares notionals against limits, so a product that cannot round-trip
    // through the parser would be a value the rest of the system cannot reason about.
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(parseDecimal(multiply(a, b), "product").ok).toBe(true);
      }),
    );
  });

  it("an exact multiple of a step is always recognised", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom("0.001", "0.01", "0.1", "1"),
        (multiplier, step) => {
          const value = multiply(decimalUnsafe(String(multiplier)), decimalUnsafe(step));
          expect(isMultipleOf(value, decimalUnsafe(step))).toBe(true);
        },
      ),
    );
  });

  it("rejects values floating point would accept", () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(compare(decimalUnsafe("0.3"), decimalUnsafe("0.30000000000000004"))).toBe(-1);
    // The classic step-size false rejection.
    expect(isMultipleOf(decimalUnsafe("0.3"), decimalUnsafe("0.1"))).toBe(true);
  });
});

describe("canonicalisation", () => {
  it("is deterministic regardless of key insertion order", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { minKeys: 1, maxKeys: 8 }),
        (record) => {
          const shuffled = Object.fromEntries(Object.entries(record).reverse());
          expect(unwrap(canonicalize(shuffled), "shuffled")).toBe(
            unwrap(canonicalize(record), "original"),
          );
        },
      ),
    );
  });

  it("produces output that parses back to an equivalent value", () => {
    fc.assert(
      fc.property(canonicalValueArb, (value) => {
        const canonical = canonicalize(value);
        if (!canonical.ok) return; // outside the supported profile
        expect(JSON.parse(canonical.value)).toEqual(value);
      }),
    );
  });

  it("gives different values different hashes", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        fc.pre(a !== b);
        expect(unwrap(canonicalHash({ v: a }), "a")).not.toBe(unwrap(canonicalHash({ v: b }), "b"));
      }),
    );
  });

  it("refuses non-integer numbers rather than guessing a spelling", () => {
    expect(canonicalize({ v: 0.1 }).ok).toBe(false);
    expect(canonicalize({ v: Number.NaN }).ok).toBe(false);
    expect(canonicalize({ v: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("refuses an explicit undefined rather than dropping the key", () => {
    // Silently dropping it would let two different objects hash identically.
    expect(canonicalize({ a: 1, b: undefined }).ok).toBe(false);
  });
});

describe("mandate hashing", () => {
  const spec: MandateSpec = {
    version: 1,
    env: "testnet",
    symbols: ["ETHUSDT"],
    orderTypes: ["LIMIT"],
    sides: ["BUY"],
    maxNotionalUsd: "500",
    maxOpenOrders: 2,
    dailyLossLimitUsd: "50",
    maxDrawdownPct: "5",
    tradingWindowUtc: ["00:00", "23:59"],
    expiresAt: "2026-09-08T23:59:00.000Z",
  };

  it("is stable across key ordering", () => {
    const reordered = Object.fromEntries(Object.entries(spec).reverse()) as unknown as MandateSpec;
    expect(unwrap(compileMandate(reordered), "reordered").hash).toBe(
      unwrap(compileMandate(spec), "original").hash,
    );
  });

  it("changes whenever any threshold changes", () => {
    const base = unwrap(compileMandate(spec), "base").hash;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (limit) => {
        fc.pre(String(limit) !== spec.maxNotionalUsd);
        const altered = unwrap(
          compileMandate({ ...spec, maxNotionalUsd: String(limit) }),
          "altered",
        ).hash;
        expect(altered).not.toBe(base);
      }),
    );
  });

  it("rejects an unrecognised clause instead of ignoring it", () => {
    // A typo'd clause name must fail loudly: the operator would otherwise believe a
    // limit is in force while nothing enforces it.
    expect(compileMandate({ ...spec, maxNotionalUSD: "10" }).ok).toBe(false);
  });
});
