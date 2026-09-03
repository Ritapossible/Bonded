/**
 * The MCP surface — the only thing the agent can reach.
 *
 * The agent holds no Binance credential. Its entire capability is the tool set below,
 * which means the bound is structural rather than advisory: there is no "please don't"
 * to ignore, only tools that refuse.
 *
 * Two deliberate choices:
 *
 * - **A denial is a successful tool call, not an error.** Returning an MCP error for a
 *   refused order invites retry loops and hides the reason in a transport-level
 *   failure. A structured `DENIED` result naming the clause lets the agent correct
 *   itself on the next attempt.
 * - **`get_mandate_summary` returns clause names, never thresholds.** The agent learns
 *   the rules by being refused, one clause at a time. If it could read the limits it
 *   could shape its behaviour to sit exactly inside them, which is the behaviour the
 *   mandate exists to make visible.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeUnknownError } from "../core/errors.js";
import { parsePositiveDecimal } from "../core/money.js";
import type { OrderIntent } from "../domain/intent.js";
import { mandateSummaryForAgent } from "../domain/mandate.js";
import type { TradingEngine } from "../engine/trading-engine.js";
import type { Logger } from "../observability/logger.js";

export interface McpServerOptions {
  readonly engine: TradingEngine;
  readonly logger: Logger;
  readonly version: string;
}

/** One JSON payload per tool result — agents parse these far more reliably than prose. */
function jsonResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

const orderShape = {
  symbol: z.string().describe("Trading pair, e.g. ETHUSDT"),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["LIMIT", "MARKET"]),
  quantity: z
    .string()
    .optional()
    .describe("Base-asset quantity as a decimal string. Required for LIMIT."),
  price: z.string().optional().describe("Limit price as a decimal string. Required for LIMIT."),
  quoteOrderQty: z
    .string()
    .optional()
    .describe("Quote-asset amount for a MARKET order, as a decimal string."),
};

type OrderArgs = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  quantity?: string | undefined;
  price?: string | undefined;
  quoteOrderQty?: string | undefined;
};

/**
 * Turn loosely-typed tool arguments into a validated intent.
 *
 * The three legal shapes are enforced here rather than in the gate, so that a
 * malformed request is answered with a usage error instead of consuming a decision-log
 * sequence number.
 */
function toIntent(args: OrderArgs): { ok: true; intent: OrderIntent } | { ok: false; message: string } {
  const symbol = args.symbol.toUpperCase();

  if (args.type === "LIMIT") {
    if (args.quantity === undefined || args.price === undefined) {
      return { ok: false, message: "a LIMIT order requires both quantity and price" };
    }
    const quantity = parsePositiveDecimal(args.quantity, "quantity");
    if (!quantity.ok) return { ok: false, message: quantity.error.message };
    const price = parsePositiveDecimal(args.price, "price");
    if (!price.ok) return { ok: false, message: price.error.message };
    return {
      ok: true,
      intent: { kind: "LIMIT", symbol, side: args.side, quantity: quantity.value, price: price.value },
    };
  }

  if (args.quoteOrderQty !== undefined) {
    if (args.quantity !== undefined) {
      return { ok: false, message: "provide either quantity or quoteOrderQty, not both" };
    }
    const quote = parsePositiveDecimal(args.quoteOrderQty, "quoteOrderQty");
    if (!quote.ok) return { ok: false, message: quote.error.message };
    return {
      ok: true,
      intent: { kind: "MARKET_QUOTE", symbol, side: args.side, quoteOrderQty: quote.value },
    };
  }

  if (args.quantity === undefined) {
    return { ok: false, message: "a MARKET order requires either quantity or quoteOrderQty" };
  }
  const quantity = parsePositiveDecimal(args.quantity, "quantity");
  if (!quantity.ok) return { ok: false, message: quantity.error.message };
  return { ok: true, intent: { kind: "MARKET_BASE", symbol, side: args.side, quantity: quantity.value } };
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const { engine, logger, version } = options;
  const server = new McpServer({ name: "bonded", version });

  server.registerTool(
    "place_order",
    {
      title: "Place a spot order",
      description:
        "Submit a spot order for evaluation against the active mandate. Returns PLACED with a " +
        "client order id, or DENIED with the exact mandate clause that refused it. A denial is " +
        "a normal outcome: read the clause and adjust, do not retry the same order.",
      inputSchema: orderShape,
    },
    async (args: OrderArgs) => {
      const intent = toIntent(args);
      if (!intent.ok) {
        return errorResult({ status: "INVALID_REQUEST", message: intent.message });
      }
      const outcome = await engine.placeOrder(intent.intent);
      if (!outcome.ok) {
        logger.error({ error: outcome.error.toJSON() }, "place_order failed");
        return errorResult({ status: "ERROR", ...outcome.error.toJSON() });
      }
      return jsonResult(outcome.value);
    },
  );

  server.registerTool(
    "check_order",
    {
      title: "Check an order against the mandate without placing it",
      description:
        "Evaluate an order and return the verdict without contacting the exchange and without " +
        "consuming a decision-log entry. Use this to test whether an order would be permitted.",
      inputSchema: orderShape,
    },
    async (args: OrderArgs) => {
      const intent = toIntent(args);
      if (!intent.ok) {
        return errorResult({ status: "INVALID_REQUEST", message: intent.message });
      }
      const result = await engine.dryRun(intent.intent);
      return jsonResult(
        result.verdict.outcome === "ALLOW"
          ? { status: "WOULD_ALLOW", notionalUsd: result.notionalUsd }
          : { status: "WOULD_DENY", notionalUsd: result.notionalUsd, ...result.verdict.denial },
      );
    },
  );

  server.registerTool(
    "get_mandate_summary",
    {
      title: "List the mandate's clauses",
      description:
        "Return the mandate hash, expiry, and the names of the clauses in force. Thresholds are " +
        "deliberately not disclosed — a refused order reports the clause and the limit it breached.",
      inputSchema: {},
    },
    () => {
      const summary = mandateSummaryForAgent(engine.mandate);
      return jsonResult({
        ...summary,
        scopeRevoked: engine.scopeRevoked,
        ...(engine.revocationReason === undefined
          ? {}
          : { revocationReason: engine.revocationReason }),
      });
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Read account state",
      description:
        "Return balances and open-order count as most recently observed from the exchange, with " +
        "the observation timestamp so staleness is visible.",
      inputSchema: {},
    },
    async () => {
      const snapshot = await engine.snapshot();
      return jsonResult({
        observedAt: new Date(snapshot.account.observedAtMs).toISOString(),
        canTrade: snapshot.account.canTrade,
        openOrderCount: snapshot.account.openOrderCount,
        balances: Object.fromEntries(snapshot.account.balances),
      });
    },
  );

  return server;
}

/** Connect over stdio. Logging is on stderr, so the protocol channel stays clean. */
export async function startMcpServer(server: McpServer, logger: Logger): Promise<void> {
  try {
    await server.connect(new StdioServerTransport());
    logger.info("MCP server connected over stdio");
  } catch (cause: unknown) {
    logger.error({ error: describeUnknownError(cause) }, "failed to start MCP server");
    throw cause;
  }
}
