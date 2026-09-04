/**
 * Public API.
 *
 * `package.json` points `exports` here, so this is what an embedder gets when they
 * `import` the package rather than running the CLI. Everything re-exported is something
 * a caller can reasonably build on; the CLI wiring and the console are deliberately not
 * part of it.
 *
 * Keep this list deliberate. Anything exported here is a compatibility promise, and the
 * easiest way to end up maintaining an accidental API is to re-export a whole directory.
 */

// Core values
export {
  parseDecimal,
  parsePositiveDecimal,
  decimalUnsafe,
  compare,
  add,
  subtract,
  multiply,
  divide,
  percentOf,
  isMultipleOf,
  type DecimalString,
} from "./core/money.js";
export { ok, err, isOk, isErr, type Result } from "./core/result.js";
export { BondedError, ErrorCode, isBondedError } from "./core/errors.js";
export { systemClock, FixedClock, type Clock } from "./core/clock.js";
export { canonicalize, canonicalHash } from "./core/canonical.js";

// Domain
export {
  compileMandate,
  mandateSummaryForAgent,
  MandateSchema,
  type Mandate,
  type MandateSpec,
} from "./domain/mandate.js";
export { ClauseId, type Denial, type Verdict, type DecisionRecord } from "./domain/decision.js";
export type { OrderIntent } from "./domain/intent.js";
export type { ExchangeState, SymbolRules, DailyPnl } from "./domain/exchange.js";
export { computeRealisedPnl, type Trade, type RealisedPnl } from "./domain/pnl.js";

// Gate
export { evaluate, CLAUSES, type GateInput, type GateResult } from "./gate/gate.js";

// Audit
export { DecisionLog, verifyChain, type ChainState } from "./audit/decision-log.js";
export {
  mintClientOrderId,
  verifyClientOrderId,
  parseClientOrderId,
  type IdVerification,
} from "./audit/client-order-id.js";

// Reconciliation
export { classify, ReconciliationOutcome, isFinding, type Finding } from "./reconcile/classify.js";
export { Reconciler, type ReconcilerStats } from "./reconcile/reconciler.js";
export { AuthorisationIndex, type Authorisation } from "./reconcile/authorisation-index.js";
export {
  PollingOrderSource,
  UserDataStreamSource,
  type OrderSource,
} from "./reconcile/order-source.js";
export {
  parseExecutionReport,
  parseAllOrders,
  type ObservedOrder,
} from "./reconcile/observed-order.js";

// Engine and exchange access
export { TradingEngine, type PlaceOrderOutcome } from "./engine/trading-engine.js";
export { StateProvider } from "./engine/state-provider.js";
export { BinanceClient, type BinanceClientOptions } from "./binance/client.js";

// Configuration and startup
export { loadConfig, describeConfig, Secret, type Config } from "./config/env.js";
export {
  runBootGuards,
  anyGuardFailed,
  formatGuardBanner,
  type GuardResult,
} from "./boot/guards.js";
export { createLogger, createSilentLogger, type Logger } from "./observability/logger.js";
