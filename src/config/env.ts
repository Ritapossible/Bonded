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
/**
 * A `BONDED_*` variable that is set but means nothing.
 *
 * A misspelled setting is the worst kind of misconfiguration: it is *present*, so the
 * operator believes it took effect, and it is *unread*, so the default silently applies
 * instead. `BONDED_LOOCKBACK_MS=60000` cost a full debugging cycle on a live instance —
 * the operator had configured a sixty-second window, BONDED was running on the
 * twenty-four-hour default, and neither the banner nor the config line said so, because
 * from BONDED's side nothing was wrong.
 *
 * That is precisely the failure this tool exists to refuse elsewhere. A guard that
 * silently ignores what it was told is not a guard.
 *
 * Scoped to the `BONDED_` prefix on purpose. That namespace is entirely ours, so an
 * unrecognised name in it is always a mistake. `BINANCE_*` is shared with the exchange's
 * own CLI and SDKs, which set variables we have never heard of and are right to.
 */
export interface UnrecognisedSetting {
  readonly name: string;
  /** The closest real setting, when one is close enough to be worth naming. */
  readonly suggestion: string | undefined;
}

/** Levenshtein distance, for turning "not a setting" into "did you mean". */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Every `BONDED_*` name the schema actually reads. */
const KNOWN_NAMES: readonly string[] = Object.keys(EnvSchema.shape);
const KNOWN_BONDED_NAMES: readonly string[] = KNOWN_NAMES.filter((name) =>
  name.startsWith("BONDED_"),
);

/**
 * Every `BONDED_*` variable that is set but not read.
 *
 * Reported by the caller rather than thrown here: an unknown setting means the operator's
 * intent was lost, not that the process is unsafe to run, and refusing to boot over a
 * stray variable would be a worse failure than the one it prevents.
 */
export function unrecognisedSettings(
  source: NodeJS.ProcessEnv = process.env,
): UnrecognisedSetting[] {
  const known = new Set(KNOWN_NAMES);
  const found: UnrecognisedSetting[] = [];
  for (const name of Object.keys(source)) {
    if (!name.startsWith("BONDED_") || known.has(name)) continue;
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of KNOWN_BONDED_NAMES) {
      const distance = editDistance(name, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    // Far enough away and a guess is noise, not help.
    found.push({ name, suggestion: bestDistance <= 3 ? best : undefined });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** One banner line per ignored setting, in the same shape as the boot guards. */
export function formatUnrecognisedSetting(setting: UnrecognisedSetting, width: number): string {
  const hint = setting.suggestion === undefined ? "" : ` Did you mean ${setting.suggestion}?`;
  return `  [WARN] ${"settings".padEnd(width)}  ${setting.name} is set but is not a BONDED setting, so it was ignored.${hint}`;
}

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
    // Logged because it decides what a fresh instance inherits. Left out, an operator
    // who sets it and still sees the bond burn at startup has no way to tell whether
    // the value reached the process or their edit never landed.
    pollIntervalMs: config.pollIntervalMs,
    lookbackMs: config.lookbackMs,
    priceSource: config.priceSource,
    mandatePath: config.mandatePath,
    decisionLogPath: config.decisionLogPath,
    logLevel: config.logLevel,
    consolePort: config.consolePort,
    timeoutMs: config.binance.timeoutMs,
    recvWindowMs: config.binance.recvWindowMs,
  };
}
