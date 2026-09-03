/**
 * Stamping authorised orders so a bypass is detectable.
 *
 * Reconciliation compares what BONDED authorised against what the exchange actually
 * executed. Matching them needs an identifier that (a) BONDED controls, and (b) nobody
 * else can mint. A predictable id would let anyone holding the API key place an order
 * wearing BONDED's namespace and disappear into the "authorised" bucket — so the id
 * carries an HMAC over the fields that identify the decision.
 *
 * Format: `bnd_<mandateHash8>_<seq>_<tag>` — at most 34 characters, inside Binance's
 * 36-character `newClientOrderId` limit and its permitted character set.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { shortHash } from "../core/canonical.js";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

const PREFIX = "bnd";
const TAG_LENGTH = 12;
const MAX_LENGTH = 36;

/** Binance's permitted character set for `newClientOrderId`. */
const BINANCE_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,36}$/;

const PARSE_PATTERN = /^bnd_([0-9a-f]{8})_(\d{1,10})_([0-9a-f]{12})$/;

export interface ClientOrderIdParts {
  readonly mandateHashShort: string;
  readonly seq: number;
  readonly tag: string;
}

function computeTag(secret: string, mandateHash: string, seq: number): string {
  return createHmac("sha256", secret)
    .update(`${mandateHash}|${String(seq)}`, "utf8")
    .digest("hex")
    .slice(0, TAG_LENGTH);
}

/**
 * Mint an id for a decision that has been allowed.
 *
 * `seq` is the decision log sequence number, which makes the id a direct pointer back
 * to the record that authorised it.
 */
export function mintClientOrderId(
  secret: string,
  mandateHash: string,
  seq: number,
): Result<string, BondedError> {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return err(
      bondedError(ErrorCode.CLIENT_ORDER_ID_INVALID, "sequence must be a non-negative integer", {
        seq,
      }),
    );
  }
  const id = `${PREFIX}_${shortHash(mandateHash)}_${String(seq)}_${computeTag(secret, mandateHash, seq)}`;
  if (id.length > MAX_LENGTH || !BINANCE_ID_PATTERN.test(id)) {
    return err(
      bondedError(ErrorCode.CLIENT_ORDER_ID_INVALID, "minted id is not acceptable to Binance", {
        length: id.length,
      }),
    );
  }
  return ok(id);
}

/** Whether an id looks like one of BONDED's, without checking authenticity. */
export function isBondedNamespace(clientOrderId: string): boolean {
  return clientOrderId.startsWith(`${PREFIX}_`);
}

export function parseClientOrderId(clientOrderId: string): ClientOrderIdParts | undefined {
  const match = PARSE_PATTERN.exec(clientOrderId);
  if (match === null) return undefined;
  const [, mandateHashShort, seqText, tag] = match as unknown as [string, string, string, string];
  return { mandateHashShort, seq: Number(seqText), tag };
}

/**
 * Verify that an id was minted by this instance for this mandate.
 *
 * Three outcomes, and the reconciler treats them very differently:
 *
 * - `authentic`  — matches an authorisation BONDED issued.
 * - `forged`     — wears BONDED's namespace but the HMAC does not verify. This is
 *                  strictly worse than an unbranded order: someone is imitating the
 *                  authorisation namespace.
 * - `foreign`    — not BONDED's namespace at all. An ordinary bypass.
 */
export type IdVerification =
  | { readonly kind: "authentic"; readonly seq: number }
  | { readonly kind: "forged"; readonly reason: string }
  | { readonly kind: "foreign" };

export function verifyClientOrderId(
  secret: string,
  mandateHash: string,
  clientOrderId: string,
): IdVerification {
  if (!isBondedNamespace(clientOrderId)) return { kind: "foreign" };

  const parts = parseClientOrderId(clientOrderId);
  if (parts === undefined) {
    return { kind: "forged", reason: "malformed BONDED identifier" };
  }
  if (parts.mandateHashShort !== shortHash(mandateHash)) {
    return { kind: "forged", reason: "identifier cites a different mandate" };
  }

  const expected = Buffer.from(computeTag(secret, mandateHash, parts.seq), "utf8");
  const actual = Buffer.from(parts.tag, "utf8");
  // Constant-time comparison: a length-varying or early-exit compare leaks how much of
  // a guessed tag was correct, which is enough to forge one given enough attempts.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { kind: "forged", reason: "authentication tag does not verify" };
  }
  return { kind: "authentic", seq: parts.seq };
}
