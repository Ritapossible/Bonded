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

import { readFile } from "node:fs/promises";
import { DecisionLog } from "./audit/decision-log.js";
import { BinanceClient } from "./binance/client.js";
import { anyGuardFailed, formatGuardBanner, runBootGuards } from "./boot/guards.js";
import { describeConfig, loadConfig } from "./config/env.js";
import { systemClock } from "./core/clock.js";
import { describeUnknownError } from "./core/errors.js";
import { compileMandate, type Mandate } from "./domain/mandate.js";
import { StateProvider } from "./engine/state-provider.js";
import { TradingEngine } from "./engine/trading-engine.js";
import { createMcpServer, startMcpServer } from "./mcp/server.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { ActivityFeed } from "./console/activity.js";
import { ConsoleServer } from "./console/server.js";
import { AuthorisationIndex } from "./reconcile/authorisation-index.js";
import { PollingOrderSource, UserDataStreamSource } from "./reconcile/order-source.js";
import { Reconciler } from "./reconcile/reconciler.js";

const VERSION = "0.1.0";

/** Write to stderr directly. stdout belongs to the MCP transport. */
function emit(text: string): void {
  process.stderr.write(`${text}\n`);
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

async function main(): Promise<number> {
  const config = loadConfig();
  if (!config.ok) {
    emit(`configuration error: ${config.error.message}`);
    emit(JSON.stringify(config.error.details, null, 2));
    return 78; // EX_CONFIG
  }

  const logger: Logger = createLogger({ level: config.value.logLevel });
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

  const stateProvider = new StateProvider({
    client,
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
  emit(
    `  [PASS] symbolGrounding  ${String(grounded.value.size)} symbols resolved from exchangeInfo`,
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

  const engine = new TradingEngine({
    mandate,
    client,
    stateProvider,
    decisionLog: decisionLog.value,
    hmacSecret: config.value.hmacSecret,
    clock: systemClock,
    logger,
    runtimeEnv: config.value.binance.env,
    onDecision: (record) => {
      reconciler.authorise(record);
      feed.recordDecision(record);
    },
  });
  wiring.engine = engine;

  // The polling backstop is a hard startup dependency: no audit path, no trading. Its
  // first pass runs synchronously here, so a failure surfaces as a refusal to start
  // rather than as silent blindness later.
  const poller = new PollingOrderSource({
    client,
    clock: systemClock,
    logger,
    symbols: mandate.spec.symbols,
    intervalMs: config.value.pollIntervalMs,
  });
  await poller.start((orders) => {
    reconciler.observeAll(orders);
  });
  if (!poller.healthy) {
    emit("  [FAIL] auditPath           could not read order history; refusing to trade blind");
    return 1;
  }
  emit(
    `  [PASS] auditPath           order history reconciled every ${String(config.value.pollIntervalMs)} ms`,
  );

  // The stream is what makes detection near-instant. It is best-effort at startup —
  // the poller already guarantees an audit path — but its absence is stated, never
  // silently tolerated.
  const stream = new UserDataStreamSource({
    client,
    clock: systemClock,
    logger,
    streamBaseUrl: config.value.binance.streamUrl,
  });
  await stream.start((orders) => {
    reconciler.observeAll(orders);
  });
  emit(`  [INFO] userDataStream      connecting to ${config.value.binance.streamUrl}`);

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
          orderSources: [stream, poller],
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
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await consoleServer?.stop();
    await stream.stop();
    await poller.stop();
    await decisionLog.value.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await startMcpServer(server, logger);
  emit(
    `\nBONDED ready — mandate ${mandate.hash.slice(0, 8)}, ${config.value.binance.env}, ` +
      `${String(index.size)} authorisations indexed\n`,
  );
  return 0;
}

try {
  const code = await main();
  if (code !== 0) process.exit(code);
} catch (cause: unknown) {
  process.stderr.write(`fatal: ${describeUnknownError(cause)}\n`);
  process.exit(70); // EX_SOFTWARE
}
