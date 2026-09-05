/**
 * Whether reconciliation can currently see enough of the account to keep trading.
 *
 * BONDED's claim is that an order it never authorised is *detected*. That claim is only
 * as wide as what the observation sources can see, so this is where the claim and the
 * plumbing are reconciled in one place.
 *
 * The subtlety the first implementation missed: a healthy source is not the same as an
 * adequate one. `GET /api/v3/allOrders` requires a symbol, so the polling backstop only
 * ever sees the symbols it was handed. An attacker holding the API key does not have to
 * defeat anything clever — they trade a symbol the mandate never mentioned, and a
 * poller-only audit path never looks there. The user data stream is account-wide and is
 * the only source that closes that gap.
 *
 * So full coverage requires a healthy account-wide source. Running without one is
 * allowed, because the stream is the flakier of the two and halting on every websocket
 * hiccup would be its own kind of failure — but it is an explicit operator decision,
 * stated at boot and visible on the console, never a silent default.
 */

import type { OrderSource } from "./order-source.js";

export type AuditCoverage =
  /** An account-wide source is live. Any order on the account is observable. */
  | "full"
  /** Only symbol-scoped sources are live. Orders on other symbols are invisible. */
  | "partial"
  /** Nothing is delivering. */
  | "none";

export interface AuditPathOptions {
  readonly sources: readonly OrderSource[];
  /**
   * Whether trading may continue on symbol-scoped coverage alone.
   *
   * Defaults to false: without an account-wide source the detection claim does not hold
   * for symbols outside the mandate, and "no audit path, no trading" is the rule.
   */
  readonly allowPartialCoverage: boolean;
}

/** What the live sources can currently see, independent of whether that is enough. */
export function currentCoverage(sources: readonly OrderSource[]): AuditCoverage {
  const healthy = sources.filter((source) => source.healthy);
  if (healthy.length === 0) return "none";
  return healthy.some((source) => source.coverage === "account") ? "full" : "partial";
}

/**
 * The gate's `auditPathHealthy` input.
 *
 * `partial` counts as healthy only when the operator has explicitly accepted it.
 */
export function isAuditPathAdequate(options: AuditPathOptions): boolean {
  const coverage = currentCoverage(options.sources);
  if (coverage === "full") return true;
  if (coverage === "partial") return options.allowPartialCoverage;
  return false;
}

/** A line an operator can read without knowing the internals. */
export function describeCoverage(coverage: AuditCoverage, allowPartial: boolean): string {
  switch (coverage) {
    case "full":
      return "account-wide: every order on the account is observable";
    case "partial":
      return allowPartial
        ? "DEGRADED: mandate symbols only. Orders on other symbols are not observable"
        : "DEGRADED: mandate symbols only, and partial coverage is not permitted";
    case "none":
      return "no source is delivering";
  }
}

export interface StartupCoverage {
  readonly coverage: AuditCoverage;
  /** Whether trading may begin. */
  readonly adequate: boolean;
  /** One line for the boot banner. */
  readonly detail: string;
  /** Sources still not delivering when the wait gave up. */
  readonly waitingFor: readonly string[];
}

/**
 * Decide what coverage exists once every source has had a chance to connect.
 *
 * This lives here rather than in `cli.ts` because the first version of it lived in
 * `cli.ts` and was wrong: it sampled coverage the instant `start()` returned, before
 * any websocket handshake could complete, so the stream read as dead every time and
 * BONDED refused to boot on a correct configuration. `cli.ts` has no tests; this does.
 * The rule and the shell are separated so the rule can be exercised.
 */
export async function resolveStartupCoverage(options: {
  readonly sources: readonly OrderSource[];
  readonly allowPartialCoverage: boolean;
  readonly connectTimeoutMs: number;
}): Promise<StartupCoverage> {
  const { sources, allowPartialCoverage, connectTimeoutMs } = options;

  // In parallel: one slow source must not consume another's budget.
  await Promise.all(sources.map((source) => source.waitUntilHealthy(connectTimeoutMs)));

  const coverage = currentCoverage(sources);
  return {
    coverage,
    adequate: isAuditPathAdequate({ sources, allowPartialCoverage }),
    detail: describeCoverage(coverage, allowPartialCoverage),
    waitingFor: sources.filter((source) => !source.healthy).map((source) => source.name),
  };
}
