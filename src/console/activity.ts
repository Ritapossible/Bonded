/**
 * The activity feed behind the console.
 *
 * A bounded, in-memory ring of recent decisions and findings, plus a subscription so
 * the console can push updates rather than poll.
 *
 * Deliberately *not* the audit trail. The decision log on disk is the authoritative
 * record; this is a display buffer that drops old entries, and nothing may ever depend
 * on it for correctness. Keeping that distinction explicit is what stops a display
 * concern quietly becoming a safety-critical one.
 */

import type { DecisionRecord } from "../domain/decision.js";
import { describeIntent } from "../domain/intent.js";
import type { DecisionOutcome } from "../domain/decision.js";
import type { Finding } from "../reconcile/classify.js";

/** One line describing what a record did, whichever kind of record it is. */
function summarise(record: DecisionRecord): string {
  if (record.intent !== undefined) return describeIntent(record.intent);
  if (record.cancel !== undefined) {
    return `CANCEL ${record.cancel.symbol} ${record.cancel.clientOrderId}`;
  }
  return "unknown";
}

export interface DecisionEntry {
  readonly kind: "decision";
  readonly at: string;
  readonly seq: number;
  readonly outcome: DecisionOutcome;
  readonly summary: string;
  readonly clause?: string;
  readonly observed?: string;
  readonly limit?: string;
  readonly clientOrderId?: string;
}

export interface FindingEntry {
  readonly kind: "finding";
  readonly at: string;
  readonly outcome: string;
  readonly summary: string;
  readonly symbol: string;
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly uncertainty: readonly string[];
}

export type ActivityEntry = DecisionEntry | FindingEntry;

export type ActivityListener = (entry: ActivityEntry) => void;

const DEFAULT_CAPACITY = 200;

export class ActivityFeed {
  readonly #capacity: number;
  readonly #entries: ActivityEntry[] = [];
  readonly #listeners = new Set<ActivityListener>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = capacity;
  }

  /** Newest first, which is the order the console renders. */
  get entries(): readonly ActivityEntry[] {
    return [...this.#entries].reverse();
  }

  recordDecision(record: DecisionRecord): void {
    this.#push({
      kind: "decision",
      at: record.ts,
      seq: record.seq,
      outcome: record.outcome,
      summary: summarise(record),
      ...(record.denial === undefined
        ? {}
        : {
            clause: record.denial.clause,
            observed: record.denial.observed,
            ...(record.denial.limit === undefined ? {} : { limit: record.denial.limit }),
          }),
      ...(record.clientOrderId === undefined ? {} : { clientOrderId: record.clientOrderId }),
    });
  }

  recordFinding(finding: Finding): void {
    this.#push({
      kind: "finding",
      at: new Date(finding.evidence.observedAtMs).toISOString(),
      outcome: finding.outcome,
      summary: finding.explanation,
      symbol: finding.reference.symbol,
      orderId: finding.reference.orderId,
      clientOrderId: finding.evidence.clientOrderId,
      uncertainty: finding.uncertainty,
    });
  }

  #push(entry: ActivityEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.shift();

    for (const listener of this.#listeners) {
      // One misbehaving subscriber must not stop the others receiving the entry, and
      // must certainly not propagate into the trade path that produced it.
      try {
        listener(entry);
      } catch {
        // Display concern; deliberately swallowed.
      }
    }
  }

  subscribe(listener: ActivityListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }
}
