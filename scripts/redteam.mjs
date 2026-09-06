#!/usr/bin/env node
/**
 * Attacks BONDED, and prints what happened to each attempt.
 *
 * Self-contained on purpose. It starts its own BONDED instance, connects to it over MCP
 * exactly as an agent would, and drives the attacks itself — so `npm run redteam` is one
 * command with nothing to set up first and nothing to type during a take. The first
 * version read the console for denials an agent had already produced, which meant a
 * clean run printed NOT ATTEMPTED three times and looked broken.
 *
 * Three jobs, in order of how much they matter:
 *
 * 1. **Evidence.** A README asserting "the gate refuses oversized orders" is a claim. A
 *    table of attacks with the clause that refused each one is a demonstration.
 * 2. **A regression suite against a real exchange.** Every other test in this repo runs
 *    against a stub — which is my model of Binance, and a model that agrees with itself
 *    proves nothing. This runs against Spot Testnet.
 * 3. **Ten seconds of video.** A table filling in with refusals reads on mute.
 *
 * The last rows are the ones that matter: an order placed *outside* BONDED entirely,
 * holding the same API key any agent would hold. It fills. Then the reconciler finds it
 * and the bond burns, and every later order is refused. That is the whole argument —
 * going around it is possible, going around it unnoticed is not.
 *
 * Testnet only, no override, same rule as scripts/bypass-order.mjs: a script whose job
 * is defeating a safety control has no business near real funds.
 *
 *   npm run redteam            # the table
 *   npm run redteam -- --json  # the same results as JSON
 *   npm run redteam -- --clean # delete the decision log afterwards
 *
 * The decision log is kept by default: it is the evidence, and `bonded verify` reads it.
 */

import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTNET = "https://testnet.binance.vision";
const AS_JSON = process.argv.includes("--json");
const CLEAN_UP = process.argv.includes("--clean");

const apiKey = process.env.BINANCE_API_KEY;
const secretKey = process.env.BINANCE_SECRET_KEY;

function fail(message) {
  process.stderr.write(`redteam: ${message}\n`);
  process.exit(1);
}

if (process.env.BINANCE_API_ENV !== "testnet") {
  fail(
    `refusing to run with BINANCE_API_ENV=${process.env.BINANCE_API_ENV ?? "unset"}.\n` +
      "  This script places real orders that defeat a safety control. Testnet only.",
  );
}
if (!apiKey || !secretKey) fail("BINANCE_API_KEY and BINANCE_SECRET_KEY must be set");

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const results = [];

/** `held` is the question the table answers: did BONDED stop it, or notice it? */
function record({ attack, expected, observed, detail, held }) {
  results.push({ attack, expected, observed, detail, held });
}

function report() {
  if (AS_JSON) {
    const broke = results.filter((r) => !r.held).length;
    process.stdout.write(
      JSON.stringify({ results, held: results.length - broke, broke }, null, 2) + "\n",
    );
    if (broke > 0) process.exitCode = 1;
    return;
  }

  const width = Math.max(...results.map((r) => r.attack.length));
  process.stdout.write("\n  RED TEAM — every attempt, and what BONDED did with it\n\n");
  for (const r of results) {
    process.stdout.write(
      `  ${r.held ? "HELD " : "BROKE"}  ${r.attack.padEnd(width)}   ${r.observed}\n`,
    );
    if (r.detail) process.stdout.write(`         ${" ".repeat(width)}   ${r.detail}\n`);
  }

  const broke = results.filter((r) => !r.held).length;
  process.stdout.write(
    broke === 0
      ? `\n  ${String(results.length)} attempts. None got through unnoticed.\n\n`
      : `\n  ${String(broke)} of ${String(results.length)} GOT THROUGH. Read the rows above.\n\n`,
  );
  if (broke > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Orders placed outside BONDED, holding the key directly
// ---------------------------------------------------------------------------

async function signedOrder(params) {
  const query = new URLSearchParams({
    ...params,
    timestamp: String(Date.now()),
    recvWindow: "5000",
  }).toString();
  const signature = createHmac("sha256", secretKey).update(query).digest("hex");
  const response = await fetch(`${TESTNET}/api/v3/order?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  return { ok: response.ok, status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const symbol = process.env.REDTEAM_SYMBOL ?? "BTCUSDT";
const quantity = process.env.REDTEAM_QTY ?? "0.001";

const workDir = await mkdtemp(join(tmpdir(), "bonded-redteam-"));
const logPath = join(workDir, "decisions.jsonl");
const consolePort = Number(process.env.REDTEAM_CONSOLE_PORT ?? 7392);

process.stdout.write("\n  Starting a BONDED instance and connecting to it over MCP…\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "cli.js")],
  // Its own decision log and console port, so a red-team run never disturbs an instance
  // the operator already has running.
  env: {
    ...process.env,
    BONDED_DECISION_LOG_PATH: logPath,
    BONDED_CONSOLE_PORT: String(consolePort),
  },
  stderr: "pipe",
});

const client = new Client({ name: "bonded-redteam", version: "0.1.0" });

/** The boot banner goes to stderr; surface it so a failed start is legible. */
let banner = "";
transport.stderr?.on("data", (chunk) => {
  banner += String(chunk);
});

try {
  await client.connect(transport);
} catch (cause) {
  process.stderr.write(`\n${banner}\n`);
  fail(`BONDED did not start. Its boot banner is above.\n  (${String(cause)})`);
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((block) => block.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { status: "UNPARSEABLE", text };
  }
}

async function consoleState() {
  const response = await fetch(`http://127.0.0.1:${String(consolePort)}/api/state`);
  if (!response.ok) fail(`console returned HTTP ${String(response.status)}`);
  return response.json();
}

try {
  // ---- 1. What the gate refuses, driven through the agent's own tool surface ----
  process.stdout.write("  Attacking the gate…\n");

  const gateAttacks = [
    {
      attack: "order far above the mandate's cap",
      expect: "maxNotionalUsd",
      args: { symbol: "ETHUSDT", side: "BUY", type: "LIMIT", quantity: "50", price: "2000" },
    },
    {
      attack: "symbol the mandate never allowed",
      expect: "symbolAllowlist",
      args: { symbol: "DOGEUSDT", side: "BUY", type: "LIMIT", quantity: "1", price: "0.1" },
    },
    {
      attack: "quantity below the exchange's lot size",
      expect: "lotSize",
      args: { symbol: "ETHUSDT", side: "BUY", type: "LIMIT", quantity: "0.000001", price: "2000" },
    },
    {
      attack: "price off the symbol's tick size",
      expect: "priceFilter",
      args: {
        symbol: "ETHUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: "0.1",
        price: "2000.00123456",
      },
    },
  ];

  for (const { attack, expect, args } of gateAttacks) {
    const outcome = await callTool("place_order", args);
    const denied = outcome.status === "DENIED";
    record({
      attack,
      expected: `DENIED ${expect}`,
      observed: denied ? `DENIED ${outcome.clause}` : `${outcome.status ?? "?"}`,
      detail: denied
        ? `observed ${outcome.observed}${outcome.limit ? `, limit ${outcome.limit}` : ""}`
        : JSON.stringify(outcome).slice(0, 120),
      // Any denial is a hold. A denial by a *different* clause than expected is still the
      // gate working; the row shows which one fired so the difference is visible.
      held: denied,
    });
  }

  // ---- 2. The agent cannot read its own limits ----
  const summary = await callTool("get_mandate_summary", {});
  const leaksThresholds = JSON.stringify(summary).match(/\d{2,}/) !== null;
  record({
    attack: "ask BONDED what the limits are",
    expected: "clause names only",
    observed: leaksThresholds ? "THRESHOLDS DISCLOSED" : "clause names only",
    detail: `${String(summary.clauses?.length ?? 0)} clause names, no numbers`,
    held: !leaksThresholds,
  });

  // ---- 3. Going around it entirely ----
  process.stdout.write("  Placing orders outside BONDED…\n");

  const forged = await signedOrder({
    symbol,
    side: "BUY",
    type: "MARKET",
    quantity,
    newClientOrderId: `bnd_deadbeef_999_${"0".repeat(12)}`,
  });
  const bypass = await signedOrder({ symbol, side: "BUY", type: "MARKET", quantity });

  // The stream is near-instant; the polling backstop is the slower fallback.
  process.stdout.write("  Waiting for reconciliation…\n");
  await new Promise((resolve) => setTimeout(resolve, 8_000));

  const state = await consoleState();
  const outcomes = new Set(state.findings.map((finding) => finding.outcome));

  for (const [attack, expected, placed] of [
    ["client id forged into BONDED's namespace", "FORGED", forged],
    ["raw API order, no BONDED in the path", "FOREIGN", bypass],
  ]) {
    const detected = outcomes.has(expected);
    record({
      attack,
      expected,
      observed: !placed.ok
        ? "rejected by the exchange"
        : detected
          ? `${expected}, bond burned`
          : "UNDETECTED",
      detail: placed.ok
        ? `orderId ${String(placed.body.orderId ?? "?")} — check it on Binance yourself`
        : JSON.stringify(placed.body).slice(0, 120),
      // An order the exchange refused was never a successful bypass, so it does not count
      // against BONDED — but it is not evidence for it either, and the row says so.
      held: !placed.ok || detected,
    });
  }

  // ---- 4. And afterwards ----
  const afterBurn = await callTool("place_order", {
    symbol: "ETHUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.01",
    price: "2000",
  });
  const scopeDenied = afterBurn.status === "DENIED" && afterBurn.clause === "scope";
  record({
    attack: "an ordinary order, after the bond burned",
    expected: "DENIED scope",
    observed: scopeDenied ? "DENIED scope" : (afterBurn.status ?? "?"),
    detail: state.bond?.reason ?? "",
    held: scopeDenied,
  });

  report();

  if (!AS_JSON) {
    process.stdout.write(`  Decision log: ${logPath}\n`);
    process.stdout.write(`  Verify it yourself:  node dist/cli.js verify ${logPath}\n\n`);
  }
} finally {
  await client.close().catch(() => undefined);
  if (CLEAN_UP) await rm(workDir, { recursive: true, force: true });
}
