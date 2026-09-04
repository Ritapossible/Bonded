/**
 * Configuration, validated once at startup.
 *
 * Two rules govern this module:
 *
 * 1. **Fail at boot, not at the first order.** Every value is validated before
 *    anything else starts. A missing HMAC secret discovered on the first trade is a
 *    production incident; discovered at startup it is a one-line error message.
 * 2. **Secrets never leave here as plain strings.** Credentials are wrapped in
 *    `Secret`, which has no useful `toString`, so an accidental interpolation into a
 *    log line or an error message yields `[redacted]` rather than an API key.
 */

import { z } from "zod";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

/**
 * A value that must never be printed.
 *
 * `toString`, `toJSON` and the Node inspect hook all return a placeholder, so the
 * common accidents — template interpolation, `JSON.stringify` of a config object,
 * `console.log` of the whole struct — cannot leak the contents. Reading it requires
 * calling `expose()`, which is greppable in review.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

const EnvSchema = z.object({
  BINANCE_API_KEY: z.string().min(16, "looks too short to be a Binance API key"),
  BINANCE_SECRET_KEY: z.string().min(16, "looks too short to be a Binance secret key"),
  BINANCE_API_ENV: z.enum(["testnet", "prod"]).default("testnet"),
  BINANCE_SPOT_BASE_PATH: z.string().url().default("https://testnet.binance.vision"),
  BINANCE_STREAM_BASE_PATH: z
    .string()
    .startsWith("wss://")
    .default("wss://stream.testnet.binance.vision/ws"),
  BONDED_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  BONDED_ALLOW_PROD: z.enum(["0", "1"]).default("0"),
  /**
   * Permit trading when only symbol-scoped observation is live.
   *
   * Off by default. With the user data stream down, an order on a symbol outside the
   * mandate cannot be observed at all, so the detection claim no longer holds for it.
   */
  BONDED_ALLOW_PARTIAL_AUDIT: z.enum(["0", "1"]).default("0"),
  /**
   * Extra symbols the polling backstop watches, beyond the mandate's own.
   *
   * The poll can only ask about symbols it is given. Naming the pairs an account
   * actually holds narrows the blind spot the REST API forces on it.
   */
  BONDED_WATCH_SYMBOLS: z.string().default(""),
  BONDED_HMAC_SECRET: z
    .string()
    .min(32, "must be at least 32 characters; generate with `openssl rand -hex 32`"),
  BONDED_MANDATE_PATH: z.string().min(1).default("./data/mandate.json"),
  BONDED_DECISION_LOG_PATH: z.string().min(1).default("./data/decisions.jsonl"),
  BONDED_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Owner console port. 0 disables it. Always bound to loopback. */
  BONDED_CONSOLE_PORT: z.coerce.number().int().min(0).max(65_535).default(7391),
  BONDED_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  BONDED_RECV_WINDOW_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
});

export interface Config {
  readonly binance: {
    readonly apiKey: Secret;
    readonly secretKey: Secret;
    readonly env: "testnet" | "prod";
    readonly baseUrl: string;
    readonly streamUrl: string;
    readonly timeoutMs: number;
    readonly recvWindowMs: number;
  };
  readonly allowProd: boolean;
  /** Whether trading may continue on symbol-scoped observation alone. */
  readonly allowPartialAudit: boolean;
  /** Extra symbols the polling backstop watches, beyond the mandate's own. */
  readonly watchSymbols: readonly string[];
  readonly hmacSecret: Secret;
  readonly mandatePath: string;
  readonly decisionLogPath: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly pollIntervalMs: number;
  readonly consolePort: number;
}

/**
 * Validate the process environment.
 *
 * Takes the environment as a parameter rather than reading `process.env` directly so
 * that configuration is testable without mutating global state.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Result<Config, BondedError> {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    return err(
      bondedError(ErrorCode.CONFIG_INVALID, "environment configuration is invalid", {
        // Only field names and messages — never the offending values, which are secrets.
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      }),
    );
  }
  const env = parsed.data;

  return ok({
    binance: {
      apiKey: new Secret(env.BINANCE_API_KEY),
      secretKey: new Secret(env.BINANCE_SECRET_KEY),
      env: env.BINANCE_API_ENV,
      baseUrl: env.BINANCE_SPOT_BASE_PATH.replace(/\/+$/, ""),
      streamUrl: env.BINANCE_STREAM_BASE_PATH.replace(/\/+$/, ""),
      timeoutMs: env.BONDED_HTTP_TIMEOUT_MS,
      recvWindowMs: env.BONDED_RECV_WINDOW_MS,
    },
    allowProd: env.BONDED_ALLOW_PROD === "1",
    allowPartialAudit: env.BONDED_ALLOW_PARTIAL_AUDIT === "1",
    watchSymbols: env.BONDED_WATCH_SYMBOLS.split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => symbol !== ""),
    hmacSecret: new Secret(env.BONDED_HMAC_SECRET),
    mandatePath: env.BONDED_MANDATE_PATH,
    decisionLogPath: env.BONDED_DECISION_LOG_PATH,
    logLevel: env.BONDED_LOG_LEVEL,
    pollIntervalMs: env.BONDED_POLL_INTERVAL_MS,
    consolePort: env.BONDED_CONSOLE_PORT,
  });
}

/** Loggable view of the configuration. Contains no credentials by construction. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    binanceEnv: config.binance.env,
    baseUrl: config.binance.baseUrl,
    streamUrl: config.binance.streamUrl,
    allowProd: config.allowProd,
    allowPartialAudit: config.allowPartialAudit,
    watchSymbols: config.watchSymbols,
    mandatePath: config.mandatePath,
    decisionLogPath: config.decisionLogPath,
    logLevel: config.logLevel,
    consolePort: config.consolePort,
    timeoutMs: config.binance.timeoutMs,
    recvWindowMs: config.binance.recvWindowMs,
  };
}
