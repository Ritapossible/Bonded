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
  /** Maximum findings retained. Defaults to 1,000. */
  readonly findingsCapacity?: number;
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
  /**
   * Findings so far, capped.
   *
   * The de-duplication set was bounded and this was not, which had it backwards: the
   * unbounded growth happens in exactly the scenario this component exists for, an
   * attacker looping orders on a compromised account. The first findings are the ones
   * that matter — the bond burns on the first — so the cap drops the newest rather than
   * the oldest, and the count of what was dropped is reported rather than hidden.
   */
  readonly #findings: Finding[] = [];
  readonly #findingsCapacity: number;
  #findingsDropped = 0;
  /** Sorted view, rebuilt only when a finding is added. */
  #sortedFindings: readonly Finding[] = [];
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
    this.#findingsCapacity = options.findingsCapacity ?? 1_000;
  }

  /**
   * Findings so far, most severe first.
   *
   * Memoised. This is read on every console render, and re-sorting a growing array each
   * time made the cost of watching a compromised account grow with the compromise.
   */
  get findings(): readonly Finding[] {
    return this.#sortedFindings;
  }

  /** Findings discarded because the cap was reached. Zero in every normal run. */
  get findingsDropped(): number {
    return this.#findingsDropped;
  }

  get stats(): ReconcilerStats {
    return {
      observed: this.#observed,
      authorised: this.#authorised,
      findings: this.#findings.length + this.#findingsDropped,
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

    // Classify *before* marking the order seen. Marking first meant that anything
    // going wrong during classification suppressed that order permanently: the poller
    // would re-deliver it, this method would return early, and a bypass would sit
    // unreported for the life of the process.
    const finding = classify({
      order,
      hmacSecret: this.#hmacSecret,
      mandateHash: this.#mandateHash,
      authorisation: this.#index.lookup(order.clientOrderId),
    });

    this.#seen.add(key);
    if (this.#seen.size > this.#seenCapacity) {
      // Sets iterate in insertion order, so the first key is the oldest.
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }

    this.#observed++;
    this.#lastObservedAtMs = this.#clock.now();

    if (!isFinding(finding.outcome)) {
      this.#authorised++;
      this.#logger.debug(
        { symbol: order.symbol, orderId: order.orderId, seq: finding.authorisation?.seq },
        "order reconciled against its authorisation",
      );
      return finding;
    }

    if (this.#findings.length < this.#findingsCapacity) {
      this.#findings.push(finding);
      this.#sortedFindings = [...this.#findings].sort((a, b) =>
        compareSeverity(a.outcome, b.outcome),
      );
    } else {
      this.#findingsDropped++;
    }
    this.#logger.error(
      {
        outcome: finding.outcome,
        symbol: order.symbol,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        source: order.source,
        // When the exchange says this order happened. A finding's age is the first
        // thing you need when deciding whether a burn is live activity or replayed
        // history, and it used to be the one field the line did not carry.
        observedAtMs: order.observedAtMs,
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
      // Isolated per order. This runs inside a poll timer and a websocket handler,
      // where an escaping exception becomes an unhandled rejection and takes the
      // process down — losing the rest of the batch, which is where the bypass this
      // component exists to find may well be.
      try {
        const finding = this.observe(order);
        if (finding !== undefined) results.push(finding);
      } catch (cause: unknown) {
        this.#logger.error(
          { cause, symbol: order.symbol, orderId: order.orderId },
          "could not classify an observed order; continuing with the rest of the batch",
        );
      }
    }
    return results;
  }

  /** Whether any finding has been raised. Once true, it stays true. */
  get compromised(): boolean {
    return this.#findings.length > 0 || this.#findingsDropped > 0;
  }

  /** The most severe outcome seen so far, for the console header. */
  get worstOutcome(): ReconciliationOutcome | undefined {
    return this.findings[0]?.outcome;
  }
}
