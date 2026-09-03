/**
 * What BONDED authorised, indexed for lookup by client order id.
 *
 * This is the first of the two accounts reconciliation compares. It is built from the
 * decision log — the same hash-chained file the boot guard verifies — so an index
 * entry is backed by a durable, tamper-evident record rather than by process memory.
 *
 * Population happens twice, and both matter:
 *
 * 1. **At startup**, by replaying the log, so a restart does not turn every order
 *    placed before it into an apparent bypass.
 * 2. **On each append**, before the order is sent. Because the engine writes the
 *    record durably *first*, the index is always populated before an `executionReport`
 *    for that order can arrive — so a legitimate order can never race into being
 *    classified as unauthorised.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ErrorCode, bondedError, describeUnknownError, type BondedError } from "../core/errors.js";
import type { DecimalString } from "../core/money.js";
import { ok, err, type Result } from "../core/result.js";
import type { DecisionRecord } from "../domain/decision.js";
import type { OrderIntent } from "../domain/intent.js";

/** The authorisation an executed order must match. */
export interface Authorisation {
  readonly seq: number;
  readonly clientOrderId: string;
  readonly mandateHash: string;
  readonly ts: string;
  readonly intent: OrderIntent;
}

export class AuthorisationIndex {
  readonly #byClientOrderId = new Map<string, Authorisation>();

  get size(): number {
    return this.#byClientOrderId.size;
  }

  /** Index a decision. Denials carry no client order id and are ignored. */
  record(record: DecisionRecord): void {
    if (record.outcome !== "ALLOW") return;
    if (record.clientOrderId === undefined) return;
    this.#byClientOrderId.set(record.clientOrderId, {
      seq: record.seq,
      clientOrderId: record.clientOrderId,
      mandateHash: record.mandateHash,
      ts: record.ts,
      intent: record.intent,
    });
  }

  lookup(clientOrderId: string): Authorisation | undefined {
    return this.#byClientOrderId.get(clientOrderId);
  }

  /**
   * Rebuild from the decision log.
   *
   * Deliberately tolerant of a missing file — a first run has authorised nothing — but
   * *not* of a corrupt one. Chain verification is the boot guard's job; this replay
   * assumes it has already passed and only reads the records.
   */
  async loadFromLog(path: string): Promise<Result<number, BondedError>> {
    try {
      await stat(path);
    } catch {
      return ok(0);
    }

    let loaded = 0;
    let lineNumber = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of reader) {
        lineNumber++;
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause: unknown) {
          return err(
            bondedError(
              ErrorCode.DECISION_LOG_CORRUPT,
              "decision log line is not valid JSON",
              { path, lineNumber },
              cause,
            ),
          );
        }
        const before = this.#byClientOrderId.size;
        this.record(parsed as DecisionRecord);
        if (this.#byClientOrderId.size > before) loaded++;
      }
    } catch (cause: unknown) {
      return err(
        bondedError(
          ErrorCode.DECISION_LOG_IO,
          `failed replaying decision log: ${describeUnknownError(cause)}`,
          { path, lineNumber },
          cause,
        ),
      );
    } finally {
      reader.close();
      stream.close();
    }

    return ok(loaded);
  }
}

/**
 * The order parameters an authorisation covers.
 *
 * Reconciliation checks that an executed order matches what was actually authorised,
 * not merely that *something* was authorised. Without this, altering an order's size
 * between authorisation and placement would pass unnoticed — the id would still
 * verify, but the mandate would not have bound the order that executed.
 */
export interface AuthorisedParameters {
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly type: "LIMIT" | "MARKET";
  /** Absent for a quote-denominated market order, which carries no base quantity. */
  readonly quantity?: DecimalString;
  readonly price?: DecimalString;
}

export function authorisedParameters(intent: OrderIntent): AuthorisedParameters {
  switch (intent.kind) {
    case "LIMIT":
      return {
        symbol: intent.symbol,
        side: intent.side,
        type: "LIMIT",
        quantity: intent.quantity,
        price: intent.price,
      };
    case "MARKET_BASE":
      return {
        symbol: intent.symbol,
        side: intent.side,
        type: "MARKET",
        quantity: intent.quantity,
      };
    case "MARKET_QUOTE":
      return { symbol: intent.symbol, side: intent.side, type: "MARKET" };
  }
}
