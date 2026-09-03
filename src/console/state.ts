/**
 * The console's view model.
 *
 * One deliberate difference from the agent's view: **the console shows thresholds.**
 * `get_mandate_summary` returns clause names only, because an agent that can read its
 * limits can shape its behaviour to sit exactly inside them. The console is the
 * owner's screen — they wrote the mandate, so hiding it from them would be theatre.
 *
 * Nothing here contains a credential. The payload is assembled from the mandate, the
 * engine's bond state, and the reconciler's counters, none of which hold secrets.
 */

import type { Mandate } from "../domain/mandate.js";
import type { TradingEngine } from "../engine/trading-engine.js";
import type { Finding } from "../reconcile/classify.js";
import type { OrderSource } from "../reconcile/order-source.js";
import type { Reconciler } from "../reconcile/reconciler.js";
import type { ActivityEntry, ActivityFeed } from "./activity.js";

export interface ClauseView {
  readonly name: string;
  readonly value: string;
}

export interface ConsoleState {
  readonly env: "testnet" | "prod";
  readonly startedAt: string;
  readonly generatedAt: string;
  readonly mandate: {
    readonly hash: string;
    readonly shortHash: string;
    readonly expiresAt: string;
    readonly clauses: readonly ClauseView[];
  };
  readonly bond: {
    readonly state: "CLEARED" | "BURNED";
    readonly reason?: string;
  };
  readonly reconciliation: {
    readonly observed: number;
    readonly authorised: number;
    readonly findings: number;
    readonly lastObservedAt: string | undefined;
    readonly sources: readonly { readonly name: string; readonly healthy: boolean }[];
  };
  readonly findings: readonly FindingView[];
  readonly activity: readonly ActivityEntry[];
}

export interface FindingView {
  readonly outcome: string;
  readonly explanation: string;
  readonly symbol: string;
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly uncertainty: readonly string[];
}

function clauseViews(mandate: Mandate): ClauseView[] {
  const spec = mandate.spec;
  return [
    { name: "environment", value: spec.env },
    { name: "symbols", value: spec.symbols.join(", ") },
    { name: "orderTypes", value: spec.orderTypes.join(", ") },
    { name: "sides", value: spec.sides.join(", ") },
    { name: "maxNotionalUsd", value: spec.maxNotionalUsd },
    { name: "maxOpenOrders", value: String(spec.maxOpenOrders) },
    { name: "dailyLossLimitUsd", value: spec.dailyLossLimitUsd },
    { name: "maxDrawdownPct", value: `${spec.maxDrawdownPct}%` },
    {
      name: "tradingWindowUtc",
      value: `${spec.tradingWindowUtc[0]}–${spec.tradingWindowUtc[1]} UTC`,
    },
    { name: "expiresAt", value: spec.expiresAt },
  ];
}

function findingView(finding: Finding): FindingView {
  return {
    outcome: finding.outcome,
    explanation: finding.explanation,
    symbol: finding.reference.symbol,
    orderId: finding.reference.orderId,
    clientOrderId: finding.evidence.clientOrderId,
    uncertainty: finding.uncertainty,
  };
}

export interface ConsoleStateSources {
  readonly engine: TradingEngine;
  readonly reconciler: Reconciler;
  readonly feed: ActivityFeed;
  readonly orderSources: readonly OrderSource[];
  readonly env: "testnet" | "prod";
  readonly startedAtMs: number;
}

export function buildConsoleState(sources: ConsoleStateSources): ConsoleState {
  const { engine, reconciler, feed, orderSources, env, startedAtMs } = sources;
  const stats = reconciler.stats;
  const mandate = engine.mandate;
  const revocationReason = engine.revocationReason;

  return {
    env,
    startedAt: new Date(startedAtMs).toISOString(),
    generatedAt: new Date().toISOString(),
    mandate: {
      hash: mandate.hash,
      shortHash: mandate.hash.slice(0, 8),
      expiresAt: mandate.spec.expiresAt,
      clauses: clauseViews(mandate),
    },
    bond: {
      state: engine.scopeRevoked ? "BURNED" : "CLEARED",
      ...(revocationReason === undefined ? {} : { reason: revocationReason }),
    },
    reconciliation: {
      observed: stats.observed,
      authorised: stats.authorised,
      findings: stats.findings,
      lastObservedAt:
        stats.lastObservedAtMs === undefined
          ? undefined
          : new Date(stats.lastObservedAtMs).toISOString(),
      sources: orderSources.map((source) => ({ name: source.name, healthy: source.healthy })),
    },
    findings: reconciler.findings.map(findingView),
    activity: feed.entries,
  };
}
