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
  emit(`  [PASS] symbolGrounding  ${String(grounded.value.size)} symbols resolved from exchangeInfo`);

  const decisionLog = await DecisionLog.open(config.value.decisionLogPath);
  if (!decisionLog.ok) {
    emit(`  [FAIL] decisionLogOpen  ${decisionLog.error.message}`);
    return 1;
  }

  const engine = new TradingEngine({
    mandate,
    client,
    stateProvider,
    decisionLog: decisionLog.value,
    hmacSecret: config.value.hmacSecret,
    clock: systemClock,
    logger,
    runtimeEnv: config.value.binance.env,
  });

  const server = createMcpServer({ engine, logger, version: VERSION });

  // Flush the audit log before exiting. A record that never reached disk is a record
  // reconciliation will later read as a bypass.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await decisionLog.value.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await startMcpServer(server, logger);
  emit(`\nBONDED ready — mandate ${mandate.hash.slice(0, 8)}, ${config.value.binance.env}\n`);
  return 0;
}

try {
  const code = await main();
  if (code !== 0) process.exit(code);
} catch (cause: unknown) {
  process.stderr.write(`fatal: ${describeUnknownError(cause)}\n`);
  process.exit(70); // EX_SOFTWARE
}
