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
  /**
   * How far back the first poll reaches, to catch orders placed while BONDED was down.
   *
   * Twenty-four hours is right for an operator restarting a real instance. It is wrong
   * for a fresh instance with an empty decision log: it inherits a day of history it has
   * no records for, and every legitimately-authorised order in that window classifies as
   * UNKNOWN_AUTHENTIC — a valid tag with no matching record — which burns the bond
   * before the instance has done anything. The red team hit exactly that.
   */
  BONDED_LOOKBACK_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60 * 1_000)
    .default(24 * 60 * 60 * 1_000),
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
  BONDED_WATCH_SYMBOLS: z
    .string()
    .default("")
    .refine(
      (value) =>
        value
          .split(",")
          .map((symbol) => symbol.trim())
          .filter((symbol) => symbol !== "")
          .every((symbol) => /^[A-Za-z0-9]{2,20}$/.test(symbol)),
      "must be a comma-separated list of Binance symbols",
    ),
  /**
   * Where reference prices come from.
   *
   * `rest` is BONDED's own signed client. `binance-cli` shells out to Binance's official
   * Agent OS tooling, which speaks the same environment variables and supports testnet.
   * REST is the default because it has the fewest moving parts; the CLI is the Agent OS
   * path, and a source that spawns a process can fail in ways a fetch cannot.
   */
  BONDED_PRICE_SOURCE: z.enum(["rest", "binance-cli"]).default("rest"),
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
  /** Where reference prices come from: BONDED's REST client, or Binance's own CLI. */
  readonly priceSource: "rest" | "binance-cli";
  readonly hmacSecret: Secret;
  readonly mandatePath: string;
  readonly decisionLogPath: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly pollIntervalMs: number;
  /** How far back the first poll reaches. */
  readonly lookbackMs: number;
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
    priceSource: env.BONDED_PRICE_SOURCE,
    hmacSecret: new Secret(env.BONDED_HMAC_SECRET),
    mandatePath: env.BONDED_MANDATE_PATH,
    decisionLogPath: env.BONDED_DECISION_LOG_PATH,
    logLevel: env.BONDED_LOG_LEVEL,
    pollIntervalMs: env.BONDED_POLL_INTERVAL_MS,
    lookbackMs: env.BONDED_LOOKBACK_MS,
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
    priceSource: config.priceSource,
    mandatePath: config.mandatePath,
    decisionLogPath: config.decisionLogPath,
    logLevel: config.logLevel,
    consolePort: config.consolePort,
    timeoutMs: config.binance.timeoutMs,
    recvWindowMs: config.binance.recvWindowMs,
  };
}
