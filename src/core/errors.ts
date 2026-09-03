/**
 * Error taxonomy.
 *
 * Every domain error carries a stable machine-readable `code`. Codes appear in the
 * decision log and in MCP tool responses, so they are part of BONDED's contract with
 * both the agent and any later audit — treat renaming one as a breaking change.
 */

export const ErrorCode = {
  // Configuration and startup
  CONFIG_INVALID: "CONFIG_INVALID",
  BOOT_GUARD_FAILED: "BOOT_GUARD_FAILED",

  // Mandate
  MANDATE_INVALID: "MANDATE_INVALID",
  MANDATE_NOT_LOADED: "MANDATE_NOT_LOADED",
  MANDATE_EXPIRED: "MANDATE_EXPIRED",
  MANDATE_UNKNOWN_SYMBOL: "MANDATE_UNKNOWN_SYMBOL",

  // Values
  DECIMAL_INVALID: "DECIMAL_INVALID",
  CANONICALIZATION_UNSUPPORTED: "CANONICALIZATION_UNSUPPORTED",

  // Audit
  DECISION_LOG_CORRUPT: "DECISION_LOG_CORRUPT",
  DECISION_LOG_MISSING: "DECISION_LOG_MISSING",
  DECISION_LOG_IO: "DECISION_LOG_IO",
  CLIENT_ORDER_ID_INVALID: "CLIENT_ORDER_ID_INVALID",

  // Exchange
  EXCHANGE_HTTP: "EXCHANGE_HTTP",
  EXCHANGE_REJECTED: "EXCHANGE_REJECTED",
  EXCHANGE_UNREACHABLE: "EXCHANGE_UNREACHABLE",
  EXCHANGE_MALFORMED_RESPONSE: "EXCHANGE_MALFORMED_RESPONSE",

  // State
  STATE_STALE: "STATE_STALE",

  // Authority
  SCOPE_REVOKED: "SCOPE_REVOKED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface BondedErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  /** Structured, non-sensitive context. Never put credentials in here. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class BondedError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: BondedErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BondedError";
    this.code = options.code;
    this.details = options.details ?? {};
  }

  /** Shape written to logs and returned to the agent. Deliberately excludes the stack. */
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function bondedError(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): BondedError {
  return new BondedError({
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Narrow an `unknown` from a catch block. Anything that is not a `BondedError` is,
 * by definition, unexpected — callers should log it and fail closed rather than
 * attempt to interpret it.
 */
export function isBondedError(e: unknown): e is BondedError {
  return e instanceof BondedError;
}

/** Render any thrown value as a loggable string without leaking a stack into output. */
export function describeUnknownError(e: unknown): string {
  if (isBondedError(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return `non-error thrown: ${typeof e}`;
}
