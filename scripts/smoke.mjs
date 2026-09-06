#!/usr/bin/env node
/**
 * Proves the MCP surface and the gate, without placing anything.
 *
 * `npm run redteam` is the full demonstration, but it places real orders and burns the
 * bond, so it is not the thing to run first. This is: it starts BONDED, connects over
 * MCP exactly as an agent does, and asks it questions that change nothing.
 *
 * Every call here is read-only or evaluate-only. `check_order` runs the whole gate and
 * returns the verdict *without* placing an order and without consuming an audit-log
 * entry, which is precisely what it exists for. So this can be run repeatedly, before a
 * take, to confirm the agent-facing surface works — the same check an operator wants
 * after changing a mandate.
 *
 *   npm run smoke
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotenv } from "../dist/config/dotenv.js";

loadDotenv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function say(text = "") {
  process.stdout.write(`${text}\n`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "cli.js")],
  // Its own console port, so this never collides with an instance already running.
  env: { ...process.env, BONDED_CONSOLE_PORT: "0" },
  stderr: "pipe",
});

let banner = "";
transport.stderr?.on("data", (chunk) => {
  banner += String(chunk);
});

const client = new Client({ name: "bonded-smoke", version: "0.1.0" });

say("\n  Starting BONDED and connecting over MCP…");
try {
  await client.connect(transport);
} catch (cause) {
  process.stderr.write(`\n${banner}\n`);
  process.stderr.write(
    `smoke: BONDED did not start. Its boot banner is above.\n  (${String(cause)})\n`,
  );
  process.exit(1);
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((block) => block.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { status: "UNPARSEABLE", text };
  }
}

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures++;
  say(`  ${passed ? "ok  " : "FAIL"}  ${label}`);
  if (detail) say(`        ${detail}`);
}

try {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  say("\n  TOOLS");
  check("five tools exposed", names.length === 5, names.join(", "));

  say("\n  MANDATE");
  const summary = await call("get_mandate_summary", {});
  check(
    "summary returns clause names",
    Array.isArray(summary.clauses) && summary.clauses.length > 0,
    `${String(summary.clauses?.length ?? 0)} clauses, mandate ${String(summary.mandateHash ?? "?").slice(0, 8)}`,
  );
  check(
    "and discloses no thresholds",
    JSON.stringify(summary.clauses ?? []).match(/\d{2,}/) === null,
    "the agent cannot read its own limits",
  );

  say("\n  GATE — evaluated, never placed");
  const oversized = await call("check_order", {
    symbol: "ETHUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "50",
    price: "2000",
  });
  check(
    "an order far above the cap is refused",
    oversized.status === "DENIED",
    `${String(oversized.status)}${oversized.clause ? ` ${String(oversized.clause)}` : ""}` +
      `${oversized.observed ? ` — observed ${String(oversized.observed)}, limit ${String(oversized.limit ?? "?")}` : ""}`,
  );

  const foreign = await call("check_order", {
    symbol: "DOGEUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "1",
    price: "0.1",
  });
  check(
    "a symbol outside the mandate is refused",
    foreign.status === "DENIED",
    `${String(foreign.status)}${foreign.clause ? ` ${String(foreign.clause)}` : ""}`,
  );

  const ordinary = await call("check_order", {
    symbol: "ETHUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.01",
    price: "2000",
  });
  check(
    "an ordinary order would be allowed",
    ordinary.status === "WOULD_ALLOW",
    `${String(ordinary.status)}${ordinary.clause ? ` — refused by ${String(ordinary.clause)}` : ""}`,
  );

  say("\n  ACCOUNT");
  const account = await call("get_account", {});
  check(
    "balances readable, with an observation time",
    account.observedAt !== undefined || account.balances !== undefined,
    JSON.stringify(account).slice(0, 120),
  );

  say(
    failures === 0
      ? "\n  All checks passed. Nothing was placed and no audit entry was consumed.\n"
      : `\n  ${String(failures)} CHECK(S) FAILED. Read the rows above.\n`,
  );
  if (failures > 0) process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
