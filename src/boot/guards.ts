/**
 * Boot guards.
 *
 * BONDED refuses to start unless the guarantees it advertises are actually in place.
 * The point is that "the bound is real" should be verifiable by reading a startup log,
 * not taken on trust from a README — a claim a reviewer can check beats a claim they
 * have to believe.
 *
 * Every guard reports what it actually verified. Where a check cannot be performed in
 * a given environment, it says so and downgrades to `WARN` rather than reporting a
 * pass. **A guard must never claim a check it did not make.**
 */

import type { BinanceClient } from "../binance/client.js";
import type { Config } from "../config/env.js";
import { verifyChain } from "../audit/decision-log.js";
import { classifyRestHost, classifyStreamHost, knownHosts } from "../config/hosts.js";
import { ErrorCode, describeUnknownError } from "../core/errors.js";
import type { Mandate } from "../domain/mandate.js";

export type GuardStatus = "PASS" | "WARN" | "FAIL";

export interface GuardResult {
  readonly name: string;
  readonly status: GuardStatus;
  /** What was actually verified, in one line, for the startup banner. */
  readonly detail: string;
}

export interface GuardContext {
  readonly config: Config;
  readonly client: BinanceClient;
  readonly mandate: Mandate | undefined;
  readonly nowMs: number;
}

/**
 * Tolerated clock skew, and why it is not one number.
 *
 * Binance's own admission rule is asymmetric:
 *
 *     timestamp < (serverTime + 1000) && (serverTime - timestamp) <= recvWindow
 *
 * So a request may be sent from a clock up to `recvWindow` **behind** the exchange, but
 * no more than **1000 ms ahead** of it — being ahead is rejected on a fixed 1-second
 * allowance that `recvWindow` cannot widen.
 *
 * This guard used a single symmetric `Math.abs(skew) > 2000`, which passed a clock
 * roughly 1.7 seconds ahead and then watched every signed request come back
 * `-1021 Timestamp for this request is outside of the recvWindow`. A guard that passes
 * a configuration the exchange rejects is worse than no guard: it moves the failure to
 * the first order and tells the operator the clock was fine.
 *
 * Both limits sit inside Binance's, because the check happens once at boot and the
 * clock keeps drifting afterwards. Half of the 1000 ms allowance is left as headroom
 * for that drift plus the latency of the request being signed.
 */
const MAX_CLOCK_AHEAD_MS = 500;
const MAX_CLOCK_BEHIND_MS = 2_000;

/**
 * Guard 1 — environment.
 *
 * A misconfiguration that points a testnet-shaped setup at production must fail
 * loudly at boot, not quietly at the first order.
 *
 * Both the REST host and the stream host are resolved against an explicit allowlist
 * (`config/hosts.ts`) and must agree with the declared environment. A declared
 * environment is a label; the hostname is the fact, and only the fact decides whether
 * real money is reachable.
 */
function guardEnvironment(ctx: GuardContext): GuardResult {
  const { env, baseUrl, streamUrl } = ctx.config.binance;
  if (env === "prod" && !ctx.config.allowProd) {
    return {
      name: "environment",
      status: "FAIL",
      detail: "BINANCE_API_ENV=prod requires BONDED_ALLOW_PROD=1 to be set explicitly",
    };
  }

  const rest = classifyRestHost(baseUrl);
  if (!rest.ok) {
    const allowed = knownHosts(env).rest.join(", ");
    return {
      name: "environment",
      status: "FAIL",
      detail: `${rest.reason}. Recognised ${env} hosts: ${allowed}`,
    };
  }
  if (rest.env !== env) {
    return {
      name: "environment",
      status: "FAIL",
      detail: `BINANCE_API_ENV=${env} but ${rest.hostname} is a ${rest.env} host`,
    };
  }

  const stream = classifyStreamHost(streamUrl);
  if (!stream.ok) {
    const allowed = knownHosts(env).stream.join(", ");
    return {
      name: "environment",
      status: "FAIL",
      detail: `${stream.reason}. Recognised ${env} hosts: ${allowed}`,
    };
  }
  if (stream.env !== env) {
    return {
      name: "environment",
      status: "FAIL",
      detail: `BINANCE_API_ENV=${env} but stream host ${stream.hostname} is a ${stream.env} host`,
    };
  }

  return {
    name: "environment",
    status: env === "testnet" ? "PASS" : "WARN",
    detail:
      env === "testnet"
        ? `testnet confirmed: ${rest.hostname} and ${stream.hostname}`
        : `PRODUCTION enabled via BONDED_ALLOW_PROD: ${rest.hostname} and ${stream.hostname}`,
  };
}

/**
 * Guard 2 — withdrawal permission.
 *
 * BONDED does not implement a withdrawal guard; it verifies that the exchange enforces
 * one, which is the stronger position because that guarantee survives BONDED being
 * wrong about everything else.
 *
 * `GET /sapi/v1/account/apiRestrictions` is a mainnet endpoint and is not expected to
 * exist on Spot Testnet. When it cannot be queried this guard reports `WARN` and says
 * exactly what it checked instead — it does not report a pass it did not earn.
 */
async function guardWithdrawalPermission(ctx: GuardContext): Promise<GuardResult> {
  if (ctx.config.binance.env === "testnet") {
    return {
      name: "withdrawalPermission",
      status: "WARN",
      detail:
        "not verified: apiRestrictions is unavailable on Spot Testnet. Asserted BINANCE_API_ENV=testnet instead",
    };
  }

  const restrictions = await ctx.client.apiRestrictions();
  if (!restrictions.ok) {
    return {
      name: "withdrawalPermission",
      status: "FAIL",
      detail: `could not read key restrictions: ${restrictions.error.message}`,
    };
  }
  if (restrictions.value.enableWithdrawals) {
    return {
      name: "withdrawalPermission",
      status: "FAIL",
      detail: "the API key has withdrawals enabled; disable it in the Binance API management page",
    };
  }
  return {
    name: "withdrawalPermission",
    status: "PASS",
    detail: "verified via apiRestrictions: enableWithdrawals=false",
  };
}

/** Guard 3 — a mandate must be loaded and unexpired. No mandate means no authority. */
function guardMandate(ctx: GuardContext): GuardResult {
  if (ctx.mandate === undefined) {
    return {
      name: "mandate",
      status: "FAIL",
      detail: `no mandate loaded from ${ctx.config.mandatePath}`,
    };
  }
  if (ctx.nowMs >= ctx.mandate.expiresAtMs) {
    return {
      name: "mandate",
      status: "FAIL",
      detail: `mandate expired at ${ctx.mandate.spec.expiresAt}`,
    };
  }
  return {
    name: "mandate",
    status: "PASS",
    detail: `mandate ${ctx.mandate.hash.slice(0, 8)} valid until ${ctx.mandate.spec.expiresAt}`,
  };
}

/** Guard 4 — the decision log's hash chain must verify from genesis. */
async function guardDecisionLog(ctx: GuardContext): Promise<GuardResult> {
  const verified = await verifyChain(ctx.config.decisionLogPath);
  if (!verified.ok) {
    // A missing file is a legitimate first run, not a broken chain.
    if (verified.error.code === ErrorCode.DECISION_LOG_MISSING) {
      return {
        name: "decisionLog",
        status: "PASS",
        detail: "no existing log; starting at genesis",
      };
    }
    return { name: "decisionLog", status: "FAIL", detail: verified.error.message };
  }
  return {
    name: "decisionLog",
    status: "PASS",
    detail: `chain verified over ${String(verified.value.recordCount)} records, head ${verified.value.headHash.slice(0, 8)}`,
  };
}

/**
 * Guard 5 — clock skew.
 *
 * Binance rejects signed requests whose timestamp falls outside `recvWindow`. Catching
 * skew here turns an intermittent, confusing `-1021` at trade time into one clear line
 * at startup.
 */
async function guardClockSkew(ctx: GuardContext): Promise<GuardResult> {
  const before = Date.now();
  const time = await ctx.client.serverTime();
  if (!time.ok) {
    return {
      name: "clockSkew",
      status: "FAIL",
      detail: `could not reach the exchange: ${time.error.message}`,
    };
  }
  const after = Date.now();
  // Compare against the midpoint of the request so round-trip latency is not counted
  // as skew.
  const localMidpoint = before + (after - before) / 2;
  const skew = Math.round(time.value.serverTime - localMidpoint);

  // A response the client accepted but that carries no usable timestamp yields NaN, and
  // `Math.abs(NaN) > limit` is false — so the guard reported PASS on a check it had not
  // performed. In a boot guard that is the one outcome that must be unreachable.
  if (!Number.isFinite(skew)) {
    return {
      name: "clockSkew",
      status: "FAIL",
      detail: "the exchange did not return a usable server time",
    };
  }

  // skew = serverTime - localTime, so a NEGATIVE skew means the local clock is ahead.
  if (skew < -MAX_CLOCK_AHEAD_MS) {
    return {
      name: "clockSkew",
      status: "FAIL",
      detail:
        `local clock is ${String(-skew)} ms AHEAD of the exchange (limit ${String(MAX_CLOCK_AHEAD_MS)} ms). ` +
        "Binance rejects any signed request timestamped more than 1000 ms ahead of its " +
        "own clock, and recvWindow does not widen that. Sync the system clock.",
    };
  }
  if (skew > MAX_CLOCK_BEHIND_MS) {
    return {
      name: "clockSkew",
      status: "FAIL",
      detail:
        `local clock is ${String(skew)} ms BEHIND the exchange (limit ${String(MAX_CLOCK_BEHIND_MS)} ms). ` +
        "Sync the system clock.",
    };
  }
  return {
    name: "clockSkew",
    status: "PASS",
    detail: `clock within ${String(skew)} ms of exchange (${skew < 0 ? "ahead" : "behind"})`,
  };
}

/**
 * Run every guard.
 *
 * All guards run even after one fails, so the operator sees the complete picture in a
 * single pass rather than fixing problems one restart at a time.
 */
export async function runBootGuards(ctx: GuardContext): Promise<GuardResult[]> {
  const results: GuardResult[] = [guardEnvironment(ctx), guardMandate(ctx)];

  for (const guard of [guardWithdrawalPermission, guardDecisionLog, guardClockSkew]) {
    try {
      results.push(await guard(ctx));
    } catch (cause: unknown) {
      results.push({
        name: guard.name,
        status: "FAIL",
        detail: `guard threw: ${describeUnknownError(cause)}`,
      });
    }
  }
  return results;
}

export function anyGuardFailed(results: readonly GuardResult[]): boolean {
  return results.some((result) => result.status === "FAIL");
}

/** The startup banner. Written to stderr so it never touches the MCP stdio channel. */
export function formatGuardBanner(results: readonly GuardResult[]): string {
  const symbol: Record<GuardStatus, string> = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `  [${symbol[r.status]}] ${r.name.padEnd(width)}  ${r.detail}`);
  return ["BONDED boot guards", ...lines].join("\n");
}
