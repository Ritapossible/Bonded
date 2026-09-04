#!/usr/bin/env node
/**
 * Places an order on Binance Spot Testnet WITHOUT going through BONDED.
 *
 * This is the demo's whole point, and a test fixture for reconciliation: it proves the
 * claim is "detected", not "prevented". Anyone holding the API key can do this — that is
 * the threat BONDED exists to make visible, so the tool that demonstrates it should be as
 * easy to run as the attack it stands in for.
 *
 * It deliberately shares no code with src/. Reusing BONDED's own client would be a
 * different experiment: the order has to originate outside BONDED to mean anything.
 *
 * Testnet only, with no override flag. A script whose job is to place unauthorised orders
 * has no business anywhere near real funds.
 *
 *   node scripts/bypass-order.mjs BTCUSDT BUY 0.001
 */
import { createHmac } from "node:crypto";

const TESTNET = "https://testnet.binance.vision";

const [symbol = "BTCUSDT", side = "BUY", quantity = "0.001"] = process.argv.slice(2);

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;
const env = process.env.BINANCE_API_ENV;

function fail(message) {
  process.stderr.write(`bypass-order: ${message}\n`);
  process.exit(1);
}

if (!apiKey || !secretKey) fail("BINANCE_API_KEY and BINANCE_SECRET_KEY must be set");
if (env !== "testnet") {
  fail(`refusing to run with BINANCE_API_ENV=${env ?? "unset"}; this script is testnet-only`);
}
if (!["BUY", "SELL"].includes(side.toUpperCase())) fail(`side must be BUY or SELL, got ${side}`);

const query = new URLSearchParams({
  symbol: symbol.toUpperCase(),
  side: side.toUpperCase(),
  type: "MARKET",
  quantity,
  timestamp: String(Date.now()),
  recvWindow: "5000",
}).toString();

const signature = createHmac("sha256", secretKey).update(query).digest("hex");

const response = await fetch(`${TESTNET}/api/v3/order?${query}&signature=${signature}`, {
  method: "POST",
  headers: { "X-MBX-APIKEY": apiKey },
});

const body = await response.json();

if (!response.ok) {
  fail(`exchange rejected the order (HTTP ${response.status}): ${JSON.stringify(body)}`);
}

// The order id is the point: it is checkable on the exchange, independently of BONDED,
// and it is what should appear in the reconciler's finding seconds from now.
process.stdout.write(
  [
    "",
    "  Order placed OUTSIDE BONDED",
    "",
    `    symbol          ${body.symbol}`,
    `    side            ${body.side}`,
    `    orderId         ${body.orderId}`,
    `    clientOrderId   ${body.clientOrderId}`,
    `    status          ${body.status}`,
    "",
    "  BONDED never authorised this. Watch the console.",
    "",
  ].join("\n"),
);
