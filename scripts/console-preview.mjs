#!/usr/bin/env node
/**
 * Console UI preview — SYNTHETIC DATA, NOT A DEMO OF THE SYSTEM.
 *
 * Renders the owner console with a hand-written state so the page can be checked, and
 * the video framed, without Binance credentials or a live exchange. Nothing here
 * exercises the gate, the audit log or the reconciler; it only feeds the view model.
 *
 * The real demo is `tests/integration/bypass-detection.test.ts`, which drives the
 * actual components end to end. Do not confuse the two.
 *
 *   npm run build && node scripts/console-preview.mjs
 */

import { ActivityFeed } from "../dist/console/activity.js";
import { ConsoleServer } from "../dist/console/server.js";
import { compileMandate } from "../dist/domain/mandate.js";
import { createSilentLogger } from "../dist/observability/logger.js";

const PORT = Number(process.env["PORT"] ?? 7455);

const mandate = compileMandate({
  version: 1,
  env: "testnet",
  symbols: ["BTCUSDT", "ETHUSDT"],
  orderTypes: ["LIMIT", "MARKET"],
  sides: ["BUY", "SELL"],
  maxNotionalUsd: "500",
  maxOpenOrders: 3,
  dailyLossLimitUsd: "50",
  maxDrawdownPct: "5",
  tradingWindowUtc: ["00:00", "23:59"],
  expiresAt: "2026-09-08T23:59:00.000Z",
}).value;

const now = Date.now();
const feed = new ActivityFeed();

feed.recordDecision({
  seq: 0,
  prevHash: "0".repeat(64),
  ts: new Date(now).toISOString(),
  mandateHash: mandate.hash,
  intent: { kind: "LIMIT", symbol: "ETHUSDT", side: "BUY", quantity: "0.1", price: "2000" },
  outcome: "ALLOW",
  clientOrderId: `bnd_${mandate.hash.slice(0, 8)}_0_a1b2c3d4e5f6`,
});

feed.recordDecision({
  seq: 1,
  prevHash: "1".repeat(64),
  ts: new Date(now + 4_000).toISOString(),
  mandateHash: mandate.hash,
  intent: { kind: "MARKET_QUOTE", symbol: "ETHUSDT", side: "BUY", quoteOrderQty: "900" },
  outcome: "DENY",
  denial: {
    clause: "maxNotionalUsd",
    clauseText: "Order notional must not exceed the mandate's maximum.",
    observed: "900",
    limit: "500",
  },
});

const finding = {
  outcome: "FOREIGN",
  explanation: "an order executed on this account that BONDED never authorised",
  evidence: {
    symbol: "ETHUSDT",
    orderId: 28461173,
    clientOrderId: "web_manual_1",
    side: "SELL",
    type: "MARKET",
    status: "FILLED",
    price: "0",
    origQty: "5",
    executedQty: "5",
    observedAtMs: now + 9_000,
    source: "stream",
  },
  reference: { symbol: "ETHUSDT", orderId: 28461173 },
  uncertainty: [
    "detection is after the fact; this order reached the exchange before BONDED observed it",
  ],
};
feed.recordFinding(finding);

const server = new ConsoleServer({
  port: PORT,
  logger: createSilentLogger(),
  engine: {
    mandate,
    scopeRevoked: true,
    revocationReason: `FOREIGN: ${finding.explanation} (ETHUSDT order 28461173)`,
  },
  reconciler: {
    stats: { observed: 4, authorised: 3, findings: 1, lastObservedAtMs: now + 9_000 },
    findings: [finding],
  },
  feed,
  orderSources: [
    { name: "stream", healthy: true },
    { name: "poll", healthy: true },
  ],
  env: "testnet",
  startedAtMs: now - 600_000,
});

if (await server.start()) {
  process.stderr.write(`console preview (synthetic data) → http://127.0.0.1:${PORT}\n`);
  process.on("SIGINT", () => void server.stop().then(() => process.exit(0)));
} else {
  process.stderr.write(`could not bind port ${PORT}\n`);
  process.exit(1);
}
