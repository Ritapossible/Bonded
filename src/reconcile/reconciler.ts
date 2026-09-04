/**
 * The reconciler.
 *
 * This is the part of BONDED that makes a bypass *detectable* rather than merely
 * discouraged. The gate can only see orders that pass through it; anything holding the
 * API key can go around it, and the gate is blind to that by construction. So the
 * reconciler watches the exchange's own account of what happened and treats any order
 * it cannot tie to an authorisation as a finding.
 *
 * Ordering is what makes this sound. The engine writes each authorisation durably
 * *before* the order is sent, so by the time an `executionReport` for that order can
 * arrive, the index already holds it. A legitimate order therefore cannot race into
 * being classified as a bypass — and the opposite direction (an authorisation with no
 * order) is benign.
 *
 * Two honest limits, stated here because they belong in the code as much as the README:
 *
 * 1. **Detection, not prevention.** A bypass order fills before the reconciler sees it.
 *    The guarantee is deterrence plus attribution.
 * 2. **Only as good as its feed.** If the observation source stops, the reconciler goes
 *    blind — so a stalled feed halts trading rather than being treated as "no findings".
 */

import type { Clock } from "../core/clock.js";
import type { DecisionRecord } from "../domain/decision.js";
import type { Logger } from "../observability/logger.js";
import type { AuthorisationIndex } from "./authorisation-index.js";
import { classify, compareSeverity, isFinding } from "./classify.js";
import type { Finding, ReconciliationOutcome } from "./classify.js";
import { observationKey, type ObservedOrder } from "./observed-order.js";

export interface ReconcilerOptions {
  readonly index: AuthorisationIndex;
  readonly hmacSecret: string;
  readonly mandateHash: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Invoked once per finding. In production this burns the bond and revokes scope. */
  readonly onFinding: (finding: Finding) => void;
  /** Maximum orders remembered for de-duplication. Defaults to 10,000. */
  readonly seenCapacity?: number;
}

export interface ReconcilerStats {
  readonly observed: number;
  readonly authorised: number;
  readonly findings: number;
  readonly lastObservedAtMs: number | undefined;
}

export class Reconciler {
  readonly #index: AuthorisationIndex;
  readonly #hmacSecret: string;
  readonly #mandateHash: string;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #onFinding: (finding: Finding) => void;

  /**
   * Orders already classified, keyed by symbol and exchange order id.
   *
   * The stream and the polling backstop deliberately overlap — the poll exists to
   * close gaps the stream may leave — so the same order routinely arrives twice.
   * Without de-duplication a single bypass would be reported repeatedly, which is how
   * an alerting channel becomes noise nobody reads.
   */
  readonly #seen = new Set<string>();
  /**
   * Cap on the de-duplication set.
   *
   * Unbounded, it grows with every order for the life of the process — a slow leak in
   * the one component that must survive longest. Evicting the oldest entries risks
   * re-reporting a very old order, which is a far better failure than exhausting memory
   * and losing the audit path entirely.
   */
  readonly #seenCapacity: number;
  readonly #findings: Finding[] = [];
  #observed = 0;
  #authorised = 0;
  #lastObservedAtMs: number | undefined;

  constructor(options: ReconcilerOptions) {
    this.#index = options.index;
    this.#hmacSecret = options.hmacSecret;
    this.#mandateHash = options.mandateHash;
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: "reconciler" });
    this.#onFinding = options.onFinding;
    this.#seenCapacity = options.seenCapacity ?? 10_000;
  }

  /** Findings so far, most severe first. */
  get findings(): readonly Finding[] {
    return [...this.#findings].sort((a, b) => compareSeverity(a.outcome, b.outcome));
  }

  get stats(): ReconcilerStats {
    return {
      observed: this.#observed,
      authorised: this.#authorised,
      findings: this.#findings.length,
      lastObservedAtMs: this.#lastObservedAtMs,
    };
  }

  /** Index an authorisation as it is written. Called by the engine before the order is sent. */
  authorise(record: DecisionRecord): void {
    this.#index.record(record);
  }

  /**
   * Classify one observed order.
   *
   * Idempotent per order: a repeat observation returns the original classification
   * without re-emitting the finding.
   */
  observe(order: ObservedOrder): Finding | undefined {
    const key = observationKey(order);
    if (this.#seen.has(key)) return undefined;
    this.#seen.add(key);
    if (this.#seen.size > this.#seenCapacity) {
      // Sets iterate in insertion order, so the first key is the oldest.
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }

    this.#observed++;
    this.#lastObservedAtMs = this.#clock.now();

    const finding = classify({
      order,
      hmacSecret: this.#hmacSecret,
      mandateHash: this.#mandateHash,
      authorisation: this.#index.lookup(order.clientOrderId),
    });

    if (!isFinding(finding.outcome)) {
      this.#authorised++;
      this.#logger.debug(
        { symbol: order.symbol, orderId: order.orderId, seq: finding.authorisation?.seq },
        "order reconciled against its authorisation",
      );
      return finding;
    }

    this.#findings.push(finding);
    this.#logger.error(
      {
        outcome: finding.outcome,
        symbol: order.symbol,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        source: order.source,
        uncertainty: finding.uncertainty,
      },
      finding.explanation,
    );

    // Notify outside the bookkeeping above, so a throwing handler cannot leave the
    // reconciler's own state half-updated.
    try {
      this.#onFinding(finding);
    } catch (cause: unknown) {
      this.#logger.error({ cause }, "finding handler threw; the finding still stands");
    }
    return finding;
  }

  /** Classify a batch, preserving order. Used by the polling backstop. */
  observeAll(orders: readonly ObservedOrder[]): Finding[] {
    const results: Finding[] = [];
    for (const order of orders) {
      const finding = this.observe(order);
      if (finding !== undefined) results.push(finding);
    }
    return results;
  }

  /** Whether any finding has been raised. Once true, it stays true. */
  get compromised(): boolean {
    return this.#findings.length > 0;
  }

  /** The most severe outcome seen so far, for the console header. */
  get worstOutcome(): ReconciliationOutcome | undefined {
    return this.findings[0]?.outcome;
  }
}
