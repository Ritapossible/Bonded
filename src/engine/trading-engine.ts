/**
 * The imperative shell around the pure gate.
 *
 * Ordering here is the whole safety argument, so it is stated explicitly:
 *
 *   1. Snapshot exchange state.
 *   2. Evaluate the gate (pure).
 *   3. **Durably append the decision record — allow or deny.**
 *   4. Only then, if allowed, send the order.
 *
 * Step 3 must complete before step 4. If the order were sent first and the process
 * died before the record was written, reconciliation would later find an order with no
 * authorisation and report a bypass that never happened. Writing first can produce the
 * opposite — an authorisation for an order that was never placed — which reconciliation
 * handles cleanly as "authorised, never seen at the exchange".
 */

import type { BinanceClient } from "../binance/client.js";
import { mintClientOrderId } from "../audit/client-order-id.js";
import type { DecisionLog } from "../audit/decision-log.js";
import type { Secret } from "../config/env.js";
import type { Clock } from "../core/clock.js";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { DecisionRecord } from "../domain/decision.js";
import type { ExchangeState } from "../domain/exchange.js";
import { describeVerdict, type Verdict } from "../domain/decision.js";
import type { OrderIntent } from "../domain/intent.js";
import { describeIntent } from "../domain/intent.js";
import type { Mandate } from "../domain/mandate.js";
import { evaluate, type GateResult } from "../gate/gate.js";
import type { Logger } from "../observability/logger.js";
import type { StateProvider } from "./state-provider.js";

export interface TradingEngineOptions {
  readonly mandate: Mandate;
  readonly client: BinanceClient;
  readonly stateProvider: StateProvider;
  readonly decisionLog: DecisionLog;
  readonly hmacSecret: Secret;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtimeEnv: "testnet" | "prod";
  /**
   * Whether reconciliation can currently observe the account.
   *
   * Required rather than optional, and a callback rather than a snapshot, because the
   * answer changes while the process runs. "No audit path, no trading" has to be true
   * for the life of the process, not just at boot — a gate that keeps allowing orders
   * it can no longer reconcile has quietly stopped making its central claim.
   */
  readonly isAuditPathHealthy: () => boolean;
  /**
   * Called with every durably written decision record, before the order is sent.
   *
   * The reconciler subscribes here so its authorisation index is populated *before*
   * an `executionReport` for that order can arrive — which is what stops a legitimate
   * order racing into being classified as a bypass. A callback rather than a direct
   * reference because the reconciler calls back into `revokeScope`, and a mutual
   * import would be a cycle.
   */
  readonly onDecision?: (record: DecisionRecord) => void;
}

/** What the agent is told. Denials are an outcome, not an error. */
export type PlaceOrderOutcome =
  | {
      readonly status: "PLACED";
      readonly clientOrderId: string;
      readonly seq: number;
      readonly exchangeResponse: unknown;
    }
  | {
      readonly status: "DENIED";
      readonly seq: number;
      readonly clause: string;
      readonly clauseText: string;
      readonly observed: string;
      readonly limit?: string;
    }
  | {
      readonly status: "FAILED";
      readonly seq: number;
      readonly clientOrderId: string;
      readonly error: { readonly code: string; readonly message: string };
    };

export class TradingEngine {
  readonly #mandate: Mandate;
  readonly #client: BinanceClient;
  readonly #state: StateProvider;
  readonly #log: DecisionLog;
  readonly #hmacSecret: Secret;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #runtimeEnv: "testnet" | "prod";

  readonly #isAuditPathHealthy: () => boolean;
  readonly #onDecision: ((record: DecisionRecord) => void) | undefined;

  #scopeRevoked = false;
  #revocationReason: string | undefined;

  constructor(options: TradingEngineOptions) {
    this.#mandate = options.mandate;
    this.#client = options.client;
    this.#state = options.stateProvider;
    this.#log = options.decisionLog;
    this.#hmacSecret = options.hmacSecret;
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: "engine" });
    this.#runtimeEnv = options.runtimeEnv;
    this.#isAuditPathHealthy = options.isAuditPathHealthy;
    this.#onDecision = options.onDecision;
  }

  get mandate(): Mandate {
    return this.#mandate;
  }

  get scopeRevoked(): boolean {
    return this.#scopeRevoked;
  }

  get revocationReason(): string | undefined {
    return this.#revocationReason;
  }

  /**
   * Burn the bond.
   *
   * Called by the reconciler when it finds an order BONDED never authorised. Deliberately
   * one-way within a process lifetime: re-arming requires an operator decision, not an
   * automatic recovery, because the condition that triggered it is unexplained activity
   * on the account.
   */
  revokeScope(reason: string): void {
    if (this.#scopeRevoked) return;
    this.#scopeRevoked = true;
    this.#revocationReason = reason;
    this.#logger.error({ reason }, "trade scope revoked; bond burned");
  }

  /** Current exchange state, refreshed if stale. Read-only view for tools and the console. */
  async snapshot(): Promise<ExchangeState> {
    return this.#state.snapshot();
  }

  /** Evaluate without side effects. Used by the console and by tests. */
  async dryRun(intent: OrderIntent): Promise<GateResult> {
    return evaluate({
      mandate: this.#mandate,
      intent,
      state: await this.#state.snapshot(),
      nowMs: this.#clock.now(),
      runtimeEnv: this.#runtimeEnv,
      scopeRevoked: this.#scopeRevoked,
      auditPathHealthy: this.#isAuditPathHealthy(),
    });
  }

  async placeOrder(intent: OrderIntent): Promise<Result<PlaceOrderOutcome, BondedError>> {
    const state = await this.#state.snapshot();
    const nowMs = this.#clock.now();

    const result = evaluate({
      mandate: this.#mandate,
      intent,
      state,
      nowMs,
      runtimeEnv: this.#runtimeEnv,
      scopeRevoked: this.#scopeRevoked,
      auditPathHealthy: this.#isAuditPathHealthy(),
    });

    const record = await this.#recordDecision(intent, result, nowMs);
    if (!record.ok) {
      // Cannot record, so cannot authorise. Failing closed here is the whole point: an
      // order placed without a durable authorisation is indistinguishable from a bypass.
      this.#logger.error({ error: record.error.toJSON() }, "refusing to trade: audit write failed");
      return record;
    }

    // Publish before the order is sent. Ordering is the whole point.
    if (this.#onDecision !== undefined) {
      try {
        this.#onDecision(record.value);
      } catch (cause: unknown) {
        // A failing subscriber must not stop the trade path, but it does mean the
        // audit index may be incomplete, so it is logged at error level.
        this.#logger.error({ cause }, "decision subscriber threw");
      }
    }

    this.#logger.info(
      {
        seq: record.value.seq,
        intent: describeIntent(intent),
        verdict: describeVerdict(result.verdict),
        notionalUsd: result.notionalUsd,
      },
      "gate decision",
    );

    if (result.verdict.outcome === "DENY") {
      return ok(denialOutcome(record.value.seq, result.verdict));
    }

    const clientOrderId = record.value.clientOrderId;
    if (clientOrderId === undefined) {
      return err(
        bondedError(ErrorCode.CLIENT_ORDER_ID_INVALID, "allowed decision has no client order id", {
          seq: record.value.seq,
        }),
      );
    }

    const placed = await this.#client.placeOrder(toBinanceParams(intent, clientOrderId));
    if (!placed.ok) {
      // The authorisation stands and the order did not take. Reconciliation reads this
      // as "authorised, never seen at the exchange", which is benign — the dangerous
      // direction is an order with no authorisation, and that cannot happen here.
      this.#logger.warn(
        { seq: record.value.seq, clientOrderId, error: placed.error.toJSON() },
        "exchange rejected an authorised order",
      );
      return ok({
        status: "FAILED",
        seq: record.value.seq,
        clientOrderId,
        error: { code: placed.error.code, message: placed.error.message },
      });
    }

    return ok({
      status: "PLACED",
      clientOrderId,
      seq: record.value.seq,
      exchangeResponse: placed.value,
    });
  }

  /**
   * Cancel an order.
   *
   * **Deliberately not gated.** Every mandate clause exists to limit exposure, and
   * cancelling only ever reduces it. A gate that could refuse a cancellation would be
   * able to trap an agent in a position it is not allowed to close — the opposite of
   * what the mandate is for. Cancellation is still recorded, so the audit trail shows
   * the full lifecycle rather than an order that silently disappears.
   */
  async cancelOrder(symbol: string, clientOrderId: string): Promise<Result<unknown, BondedError>> {
    const result = await this.#client.cancelOrder({ symbol, origClientOrderId: clientOrderId });
    this.#logger.info(
      { symbol, clientOrderId, ok: result.ok },
      result.ok ? "order cancelled" : "cancellation refused by the exchange",
    );
    return result;
  }

  /**
   * Write the decision record, minting the client order id inside the append queue so
   * the id and the sequence number cannot disagree.
   */
  async #recordDecision(
    intent: OrderIntent,
    result: GateResult,
    nowMs: number,
  ): Promise<Result<DecisionRecord, BondedError>> {
    const ts = new Date(nowMs).toISOString();
    const mandateHash = this.#mandate.hash;

    return this.#log.appendWith((seq) => {
      const base = {
        ts,
        mandateHash,
        intent,
        outcome: result.verdict.outcome,
        ...(result.notionalUsd === undefined ? {} : { notionalUsd: result.notionalUsd }),
      } as const;

      if (result.verdict.outcome === "DENY") {
        return ok({ ...base, outcome: "DENY" as const, denial: result.verdict.denial });
      }

      const clientOrderId = mintClientOrderId(this.#hmacSecret.expose(), mandateHash, seq);
      if (!clientOrderId.ok) return clientOrderId;
      return ok({ ...base, outcome: "ALLOW" as const, clientOrderId: clientOrderId.value });
    });
  }
}

function denialOutcome(seq: number, verdict: Verdict & { outcome: "DENY" }): PlaceOrderOutcome {
  const { denial } = verdict;
  return {
    status: "DENIED",
    seq,
    clause: denial.clause,
    clauseText: denial.clauseText,
    observed: denial.observed,
    ...(denial.limit === undefined ? {} : { limit: denial.limit }),
  };
}

/** Translate an intent into Binance's `POST /api/v3/order` parameters. */
function toBinanceParams(
  intent: OrderIntent,
  clientOrderId: string,
): Record<string, string | number> {
  const common = {
    symbol: intent.symbol,
    side: intent.side,
    newClientOrderId: clientOrderId,
    newOrderRespType: "RESULT",
  };

  switch (intent.kind) {
    case "LIMIT":
      return {
        ...common,
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: intent.quantity,
        price: intent.price,
      };
    case "MARKET_BASE":
      return { ...common, type: "MARKET", quantity: intent.quantity };
    case "MARKET_QUOTE":
      return { ...common, type: "MARKET", quoteOrderQty: intent.quoteOrderQty };
  }
}
