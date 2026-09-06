#!/usr/bin/env node
/**
 * Entry point.
 *
 * Startup order is deliberate and each step gates the next:
 *
 *   config → logger → mandate → decision log → exchange client → symbol grounding
 *          → boot guards → engine → MCP transport
 *
 * Nothing that can trade exists until the guards have run and passed. A failed guard
 * exits non-zero with the banner already printed, so the operator sees the complete
 * picture in one pass rather than fixing problems one restart at a time.
 */

import { checkQuoteAssets } from "./domain/quote-asset.js";
import { formatVerification, verifyDecisionLog } from "./verify/verify-log.js";
import { isAuditPathAdequate, resolveStartupCoverage } from "./reconcile/audit-path.js";
import { readFile } from "node:fs/promises";
import { DecisionLog } from "./audit/decision-log.js";
import { BinanceClient } from "./binance/client.js";
import { BinanceCliPriceSource } from "./binance/cli-price-source.js";
import { anyGuardFailed, formatGuardBanner, runBootGuards } from "./boot/guards.js";
import { loadDotenv } from "./config/dotenv.js";
import { describeConfig, loadConfig } from "./config/env.js";
import { systemClock } from "./core/clock.js";
import { describeUnknownError } from "./core/errors.js";
import { err, ok, type Result } from "./core/result.js";
import { compileMandate, type Mandate } from "./domain/mandate.js";
import { StateProvider } from "./engine/state-provider.js";
import { TradingEngine } from "./engine/trading-engine.js";
import { createMcpServer, startMcpServer } from "./mcp/server.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { ActivityFeed } from "./console/activity.js";
import { ConsoleServer } from "./console/server.js";
import { AuthorisationIndex } from "./reconcile/authorisation-index.js";
import {
  PollingOrderSource,
  UserDataStreamSource,
  type OrderSource,
} from "./reconcile/order-source.js";
import { Reconciler } from "./reconcile/reconciler.js";

const VERSION = "0.1.0";

/** Write to stderr directly. stdout belongs to the MCP transport. */
function emit(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * Report output for the `verify` subcommand, on stdout.
 *
 * Everything else in this process writes to stderr, because stdout carries the MCP
 * JSON-RPC frames and one stray line there corrupts the transport. `verify` is the
 * exception and is safe: it is a one-shot subcommand that returns an exit code without
 * ever starting the server, so there is no transport to corrupt. It needs stdout
 * because its report is the product — `bonded verify log > report.txt`, or piping it
 * to read the head back out, is the whole point of the command, and on stderr both
 * produce an empty file.
 */
function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function loadMandate(path: string): Promise<Mandate | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const compiled = compileMandate(parsed);
  if (!compiled.ok) {
    emit(`mandate at ${path} is invalid: ${JSON.stringify(compiled.error.details, null, 2)}`);
    return undefined;
  }
  return compiled.value;
}

/**
 * How long to wait for the user data stream before deciding what coverage we have.
 *
 * Long enough for a handshake on a slow link, short enough that a genuinely dead
 * stream does not hold startup open. Exceeding it is not fatal by itself — it hands
 * the decision to the coverage rule below.
 */
const STREAM_CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<number> {
  // Before config, because `.env` is where the documented setup puts the keys. Values
  // already in the environment win, so this can only ever fill in blanks.
  const dotenv = loadDotenv();

  const config = loadConfig();
  if (!config.ok) {
    emit(`configuration error: ${config.error.message}`);
    emit(JSON.stringify(config.error.details, null, 2));
    return 78; // EX_CONFIG
  }

  const logger: Logger = createLogger({ level: config.value.logLevel });
  if (dotenv.path !== undefined) {
    // Names only. The values are the reason this file exists.
    logger.info(
      { path: dotenv.path, applied: dotenv.applied, alreadySet: dotenv.skipped },
      "loaded environment file",
    );
  }
  logger.info({ config: describeConfig(config.value), version: VERSION }, "bonded starting");

  const mandate = await loadMandate(config.value.mandatePath);

  const client = new BinanceClient({
    baseUrl: config.value.binance.baseUrl,
    apiKey: config.value.binance.apiKey,
    secretKey: config.value.binance.secretKey,
    timeoutMs: config.value.binance.timeoutMs,
    recvWindowMs: config.value.binance.recvWindowMs,
    logger,
  });

  const guards = await runBootGuards({
    config: config.value,
    client,
    mandate,
    nowMs: systemClock.now(),
  });
  emit(formatGuardBanner(guards));

  if (anyGuardFailed(guards) || mandate === undefined) {
    logger.error("boot guards failed; refusing to start");
    return 1;
  }

  // Reference prices can come from Binance's own Agent OS CLI instead of BONDED's
  // REST client. Opt-in, because a source that spawns a process has failure modes a
  // fetch does not; the banner below names whichever is live so it is never a guess.
  const priceSource =
    config.value.priceSource === "binance-cli" ? new BinanceCliPriceSource() : client;
  logger.info({ priceSource: priceSource.name }, "reference price source");

  const stateProvider = new StateProvider({
    client,
    priceSource,
    clock: systemClock,
    symbols: mandate.spec.symbols,
  });

  // Ground the mandate's symbols against live exchangeInfo before anything can trade.
  // Without this the gate would deny every order as unresolvable, which is safe but
  // useless — and the failure belongs at startup where it is legible.
  const grounded = await stateProvider.loadSymbolRules();
  if (!grounded.ok) {
    emit(`  [FAIL] symbolGrounding  ${grounded.error.message}`);
    logger.error({ error: grounded.error.toJSON() }, "could not ground mandate symbols");
    return 1;
  }
  const missing = mandate.spec.symbols.filter((symbol) => !grounded.value.has(symbol));
  if (missing.length > 0) {
    emit(`  [FAIL] symbolGrounding  not listed on the exchange: ${missing.join(", ")}`);
    return 1;
  }
  // The mandate's limits are denominated in USD. Summing a BTC-quoted notional into a
  // USD cap does not fail loudly; it silently measures the wrong thing.
  const quoteAssets = checkQuoteAssets(grounded.value);
  if (!quoteAssets.ok) {
    emit(`  [FAIL] quoteAsset       ${quoteAssets.error.message}`);
    logger.error({ error: quoteAssets.error.toJSON() }, "mandate mixes quote assets");
    return 1;
  }
  emit(
    `  [PASS] symbolGrounding  ${String(grounded.value.size)} symbols resolved from exchangeInfo, quoted in ${quoteAssets.value.quoteAssets.join(", ")}`,
  );

  const decisionLog = await DecisionLog.open(config.value.decisionLogPath);
  if (!decisionLog.ok) {
    emit(`  [FAIL] decisionLogOpen  ${decisionLog.error.message}`);
    return 1;
  }

  // Rebuild the authorisation index from the log, so orders placed before a restart
  // are not mistaken for bypasses.
  const index = new AuthorisationIndex();
  const replayed = await index.loadFromLog(config.value.decisionLogPath);
  if (!replayed.ok) {
    emit(`  [FAIL] authorisationIndex  ${replayed.error.message}`);
    return 1;
  }
  emit(`  [PASS] authorisationIndex  ${String(replayed.value)} prior authorisations replayed`);

  // The engine and the reconciler refer to each other — the engine publishes each
  // authorisation, the reconciler revokes scope on a finding. A late-bound holder
  // rather than a mutual import, which would be a dependency cycle.
  const wiring: { engine?: TradingEngine } = {};
  const feed = new ActivityFeed();

  const reconciler = new Reconciler({
    index,
    hmacSecret: config.value.hmacSecret.expose(),
    mandateHash: mandate.hash,
    clock: systemClock,
    logger,
    onFinding: (finding) => {
      feed.recordFinding(finding);
      wiring.engine?.revokeScope(
        `${finding.outcome}: ${finding.explanation} (${finding.reference.symbol} order ${String(finding.reference.orderId)})`,
      );
    },
  });

  // Declared before the engine so the health callback can close over it, and populated
  // once the sources exist. The engine only ever reads it at evaluation time.
  const sources: OrderSource[] = [];

  const engine = new TradingEngine({
    mandate,
    client,
    stateProvider,
    decisionLog: decisionLog.value,
    hmacSecret: config.value.hmacSecret,
    clock: systemClock,
    logger,
    runtimeEnv: config.value.binance.env,
    // Not "any source is alive" — that treated the symbol-scoped poller as equivalent
    // to the account-wide stream, and it is not. See `reconcile/audit-path.ts`.
    isAuditPathHealthy: () =>
      isAuditPathAdequate({ sources, allowPartialCoverage: config.value.allowPartialAudit }),
    onDecision: (record) => {
      reconciler.authorise(record);
      feed.recordDecision(record);
    },
  });
  wiring.engine = engine;

  // The polling backstop is a hard startup dependency: no audit path, no trading. Its
  // first pass runs synchronously here, so a failure surfaces as a refusal to start
  // rather than as silent blindness later.
  const pollSymbols = [...new Set([...mandate.spec.symbols, ...config.value.watchSymbols])];
  const poller = new PollingOrderSource({
    client,
    clock: systemClock,
    logger,
    // The mandate's symbols plus anything the operator named. `allOrders` needs a
    // symbol, so every pair not listed here is outside the poller's reach.
    symbols: pollSymbols,
    intervalMs: config.value.pollIntervalMs,
  });
  sources.push(poller);
  await poller.start((orders) => {
    reconciler.observeAll(orders);
  });
  if (!poller.healthy) {
    emit("  [FAIL] auditPath           could not read order history; refusing to trade blind");
    return 1;
  }
  emit(
    `  [PASS] auditPath           ${String(pollSymbols.length)} symbols polled every ${String(config.value.pollIntervalMs)} ms`,
  );

  // The stream is the only account-wide source, so it is what makes the detection claim
  // hold for symbols the mandate never named. Without it, coverage is symbol-scoped and
  // trading stops unless the operator has explicitly accepted that.
  const stream = new UserDataStreamSource({
    client,
    clock: systemClock,
    logger,
    streamBaseUrl: config.value.binance.streamUrl,
  });
  sources.push(stream);
  await stream.start((orders) => {
    reconciler.observeAll(orders);
  });

  // A websocket handshake completes on a later turn of the event loop, so sampling
  // coverage the instant `start()` returned reported the stream dead every time and
  // refused to boot on a correct configuration. Wait for the answer.
  const startup = await resolveStartupCoverage({
    sources,
    allowPartialCoverage: config.value.allowPartialAudit,
    connectTimeoutMs: STREAM_CONNECT_TIMEOUT_MS,
  });
  for (const reason of startup.unavailable) {
    emit(`  [WARN] userDataStream      ${reason}`);
  }
  if (startup.unavailable.length === 0 && startup.waitingFor.length > 0) {
    emit(
      `  [WARN] userDataStream      ${startup.waitingFor.join(", ")} not delivering after ${String(STREAM_CONNECT_TIMEOUT_MS)} ms; still retrying`,
    );
  }

  const coverageStatus = startup.adequate
    ? startup.coverage === "full"
      ? "PASS"
      : "WARN"
    : "FAIL";
  emit(`  [${coverageStatus}] auditCoverage       ${startup.detail}`);
  if (!startup.adequate) {
    emit("         The user data stream is the only account-wide source. Without it an order on a");
    emit("         symbol outside the mandate cannot be seen. Set BONDED_ALLOW_PARTIAL_AUDIT=1 to");
    emit("         accept that and trade anyway.");
    return 1;
  }

  // The console is a display, not a safety component: if it cannot bind, BONDED says
  // so and keeps trading. A broken screen must never take the gate down with it.
  const consoleServer =
    config.value.consolePort === 0
      ? undefined
      : new ConsoleServer({
          port: config.value.consolePort,
          logger,
          engine,
          reconciler,
          feed,
          orderSources: sources,
          env: config.value.binance.env,
          startedAtMs: systemClock.now(),
        });

  if (consoleServer !== undefined) {
    const bound = await consoleServer.start();
    emit(
      bound
        ? `  [PASS] console             http://127.0.0.1:${String(config.value.consolePort)}`
        : `  [WARN] console             port ${String(config.value.consolePort)} unavailable; continuing without it`,
    );
  }

  const server = createMcpServer({ engine, logger, version: VERSION });

  // Flush the audit log before exiting. A record that never reached disk is a record
  // reconciliation will later read as a bypass.
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    // A second signal while the first shutdown is in flight must not start a parallel
    // teardown that closes the log twice.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "shutting down");
    try {
      await consoleServer?.stop();
      await stream.stop();
      await poller.stop();
      await decisionLog.value.close();
    } catch (cause: unknown) {
      logger.error({ error: describeUnknownError(cause) }, "error during shutdown");
      process.exit(1);
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

  // An unexpected throw anywhere leaves the process in a state whose invariants are no
  // longer known. Continuing to trade from there is the worst option available, so
  // BONDED records what happened, flushes the audit log, and stops.
  process.on("uncaughtException", (error: Error) => {
    logger.fatal({ error: describeUnknownError(error), stack: error.stack }, "uncaught exception");
    void shutdown("uncaughtException", 70);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.fatal({ error: describeUnknownError(reason) }, "unhandled rejection");
    void shutdown("unhandledRejection", 70);
  });

  await startMcpServer(server, logger);
  emit(
    `\nBONDED ready — mandate ${mandate.hash.slice(0, 8)}, ${config.value.binance.env}, ` +
      `${String(index.size)} authorisations indexed\n`,
  );
  return 0;
}

/**
 * `bonded verify <log> [--secret <hex>] [--head <hex>]`
 *
 * A subcommand rather than a separate binary so that the thing which verifies a log
 * ships with the thing that wrote it, at the same version.
 *
 * `--head` is the one that makes the result mean something to a stranger: pin the log
 * against a head hash published before the fact and a tail edit or an appended record
 * fails, which a chain walk on its own cannot catch.
 */
async function verifyCommand(argv: readonly string[]): Promise<number> {
  const path = argv[0];
  if (path === undefined || path.startsWith("-")) {
    emit("usage: bonded verify <decision-log.jsonl> [--secret <hmac-secret>] [--head <hex>]");
    // Usage goes to stderr: it is a diagnostic, not the report.
    return 78; // EX_CONFIG
  }

  /** Reads `--flag value`, distinguishing "absent" from "given without a value". */
  function flag(name: string): Result<string | undefined, string> {
    const at = argv.indexOf(name);
    if (at === -1) return ok(undefined);
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("-")) return err(`${name} needs a value`);
    return ok(value);
  }

  const secret = flag("--secret");
  if (!secret.ok) {
    emit(secret.error);
    return 78;
  }
  const head = flag("--head");
  if (!head.ok) {
    emit(head.error);
    return 78;
  }

  const result = await verifyDecisionLog(path, {
    ...(secret.value === undefined ? {} : { hmacSecret: secret.value }),
    ...(head.value === undefined ? {} : { expectedHead: head.value }),
  });
  if (!result.ok) {
    say(`\nBONDED decision log — ${path}\n`);
    say(`  NOT VERIFIED: ${result.error.message}`);
    say(`  ${JSON.stringify(result.error.details)}\n`);
    return 1;
  }

  say(formatVerification(path, result.value));
  // A log citing more than one mandate is not corrupt, but it is not a clean bill of
  // health either, and the exit code should not say it is.
  return result.value.mandateHashes.length > 1 ? 1 : 0;
}

try {
  const [subcommand, ...rest] = process.argv.slice(2);
  const code = subcommand === "verify" ? await verifyCommand(rest) : await main();
  if (code !== 0) process.exit(code);
} catch (cause: unknown) {
  process.stderr.write(`fatal: ${describeUnknownError(cause)}\n`);
  process.exit(70); // EX_SOFTWARE
}
