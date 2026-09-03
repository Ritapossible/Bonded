import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isBondedNamespace,
  mintClientOrderId,
  parseClientOrderId,
  verifyClientOrderId,
} from "../../src/audit/client-order-id.js";
import { unwrap } from "../../src/core/result.js";

const SECRET = "a".repeat(64);
const MANDATE = "b3f1".repeat(16); // 64 hex chars

describe("client order id", () => {
  it("fits inside Binance's 36-character limit and character set", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999 }), (seq) => {
        const id = unwrap(mintClientOrderId(SECRET, MANDATE, seq), "mint");
        expect(id.length).toBeLessThanOrEqual(36);
        expect(id).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
      }),
    );
  });

  it("round-trips the sequence number it was minted for", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999 }), (seq) => {
        const id = unwrap(mintClientOrderId(SECRET, MANDATE, seq), "mint");
        expect(parseClientOrderId(id)?.seq).toBe(seq);
      }),
    );
  });

  it("verifies an id it minted", () => {
    const id = unwrap(mintClientOrderId(SECRET, MANDATE, 42), "mint");
    expect(verifyClientOrderId(SECRET, MANDATE, id)).toEqual({ kind: "authentic", seq: 42 });
  });

  it("rejects a negative or non-integer sequence", () => {
    expect(mintClientOrderId(SECRET, MANDATE, -1).ok).toBe(false);
    expect(mintClientOrderId(SECRET, MANDATE, 1.5).ok).toBe(false);
  });

  describe("bypass classification", () => {
    it("treats an unbranded id as foreign", () => {
      // An ordinary order placed outside BONDED — the plain bypass case.
      expect(verifyClientOrderId(SECRET, MANDATE, "x-web-12345")).toEqual({ kind: "foreign" });
      expect(isBondedNamespace("x-web-12345")).toBe(false);
    });

    it("treats a tampered tag as forged, not foreign", () => {
      // Wearing BONDED's namespace without a valid tag is strictly worse than an
      // unbranded order: someone is imitating the authorisation namespace.
      const id = unwrap(mintClientOrderId(SECRET, MANDATE, 7), "mint");
      const tampered = `${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`;
      const result = verifyClientOrderId(SECRET, MANDATE, tampered);
      expect(result.kind).toBe("forged");
    });

    it("treats a malformed BONDED-prefixed id as forged", () => {
      expect(verifyClientOrderId(SECRET, MANDATE, "bnd_nonsense").kind).toBe("forged");
    });

    it("rejects an id minted for a different mandate", () => {
      const other = "c".repeat(64);
      const id = unwrap(mintClientOrderId(SECRET, other, 3), "mint");
      const result = verifyClientOrderId(SECRET, MANDATE, id);
      expect(result.kind).toBe("forged");
      if (result.kind !== "forged") throw new Error("unreachable");
      expect(result.reason).toContain("different mandate");
    });

    it("rejects an id minted with a different secret", () => {
      // The core forgery property: knowing the format is not enough without the key.
      const id = unwrap(mintClientOrderId("z".repeat(64), MANDATE, 3), "mint");
      expect(verifyClientOrderId(SECRET, MANDATE, id).kind).toBe("forged");
    });

    it("cannot be forged from other observed ids", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 0, max: 1000 }),
          (known, target) => {
            fc.pre(known !== target);
            // Take a legitimately observed id and swap in a different sequence number,
            // the most obvious forgery attempt available to an attacker.
            const observed = unwrap(mintClientOrderId(SECRET, MANDATE, known), "mint");
            const parts = parseClientOrderId(observed)!;
            const forged = `bnd_${observed.split("_")[1]!}_${String(target)}_${parts.tag}`;
            expect(verifyClientOrderId(SECRET, MANDATE, forged).kind).toBe("forged");
          },
        ),
      );
    });
  });
});
