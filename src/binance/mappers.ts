/**
 * Parsing Binance responses into domain types.
 *
 * Everything crossing this boundary is untrusted input, so it is validated rather than
 * cast. A response shape that has drifted must fail loudly here — the alternative is a
 * `undefined` propagating into a limit comparison, where it would silently evaluate to
 * "no breach" and the gate would stop binding without anyone noticing.
 */

import { z } from "zod";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import type { DecimalString } from "../core/money.js";
import { ZERO } from "../core/money.js";
import { err, ok, type Result } from "../core/result.js";
import type { AccountSnapshot, PriceSnapshot, SymbolRules } from "../domain/exchange.js";

/** Binance sends every numeric field as a string; this is the shape we accept. */
const numericString = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "not a plain decimal");

const FilterSchema = z.discriminatedUnion("filterType", [
  z.object({
    filterType: z.literal("PRICE_FILTER"),
    minPrice: numericString,
    maxPrice: numericString,
    tickSize: numericString,
  }),
  z.object({
    filterType: z.literal("LOT_SIZE"),
    minQty: numericString,
    maxQty: numericString,
    stepSize: numericString,
  }),
  z.object({ filterType: z.literal("NOTIONAL"), minNotional: numericString }),
  z.object({ filterType: z.literal("MIN_NOTIONAL"), minNotional: numericString }),
]);

const SymbolSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  // Unknown filter types are passed through and ignored rather than rejected: Binance
  // adds filters over time, and a new one must not break startup.
  filters: z.array(z.union([FilterSchema, z.object({ filterType: z.string() })])),
});

const ExchangeInfoSchema = z.object({ symbols: z.array(SymbolSchema) });

const BalanceSchema = z.object({ asset: z.string(), free: numericString, locked: numericString });

const AccountSchema = z.object({
  canTrade: z.boolean(),
  balances: z.array(BalanceSchema),
});

const TickerSchema = z.object({ symbol: z.string(), price: numericString });
const TickerListSchema = z.union([TickerSchema, z.array(TickerSchema)]);

function malformed(what: string, issues: z.ZodIssue[]): BondedError {
  return bondedError(ErrorCode.EXCHANGE_MALFORMED_RESPONSE, `unexpected ${what} response shape`, {
    issues: issues.slice(0, 5).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

/**
 * Build the symbol rule set the gate enforces.
 *
 * A symbol missing a filter is given the "unconstrained" value (`"0"`), matching how
 * Binance itself disables one — not skipped, because a missing entry would make the
 * gate deny every order for that symbol as ungrounded.
 */
export function parseExchangeInfo(
  raw: unknown,
): Result<Map<string, SymbolRules>, BondedError> {
  const parsed = ExchangeInfoSchema.safeParse(raw);
  if (!parsed.success) return err(malformed("exchangeInfo", parsed.error.issues));

  const rules = new Map<string, SymbolRules>();
  for (const symbol of parsed.data.symbols) {
    let tickSize = ZERO;
    let minPrice = ZERO;
    let maxPrice = ZERO;
    let stepSize = ZERO;
    let minQty = ZERO;
    let maxQty = ZERO;
    let minNotional = ZERO;

    for (const filter of symbol.filters) {
      switch (filter.filterType) {
        case "PRICE_FILTER": {
          const f = filter as z.infer<typeof FilterSchema> & { filterType: "PRICE_FILTER" };
          tickSize = f.tickSize as DecimalString;
          minPrice = f.minPrice as DecimalString;
          maxPrice = f.maxPrice as DecimalString;
          break;
        }
        case "LOT_SIZE": {
          const f = filter as z.infer<typeof FilterSchema> & { filterType: "LOT_SIZE" };
          stepSize = f.stepSize as DecimalString;
          minQty = f.minQty as DecimalString;
          maxQty = f.maxQty as DecimalString;
          break;
        }
        case "NOTIONAL":
        case "MIN_NOTIONAL": {
          const f = filter as { minNotional: string };
          minNotional = f.minNotional as DecimalString;
          break;
        }
        default:
          break;
      }
    }

    rules.set(symbol.symbol, {
      symbol: symbol.symbol,
      status: symbol.status,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
      tickSize,
      minPrice,
      maxPrice,
      stepSize,
      minQty,
      maxQty,
      minNotional,
    });
  }
  return ok(rules);
}

export function parseAccount(
  raw: unknown,
  observedAtMs: number,
  openOrderCount: number,
): Result<AccountSnapshot, BondedError> {
  const parsed = AccountSchema.safeParse(raw);
  if (!parsed.success) return err(malformed("account", parsed.error.issues));

  const balances = new Map<string, DecimalString>();
  for (const balance of parsed.data.balances) {
    // Zero balances are the overwhelming majority of the response and carry no
    // information for any rule, so they are dropped to keep the snapshot small.
    if (balance.free !== "0" && balance.free !== "0.00000000") {
      balances.set(balance.asset, balance.free as DecimalString);
    }
  }

  return ok({
    observedAtMs,
    canTrade: parsed.data.canTrade,
    balances,
    openOrderCount,
  });
}

export function parseTickerPrices(
  raw: unknown,
  observedAtMs: number,
): Result<PriceSnapshot, BondedError> {
  const parsed = TickerListSchema.safeParse(raw);
  if (!parsed.success) return err(malformed("ticker/price", parsed.error.issues));

  const tickers = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const prices = new Map<string, DecimalString>();
  for (const ticker of tickers) {
    prices.set(ticker.symbol, ticker.price as DecimalString);
  }
  return ok({ observedAtMs, prices });
}

/** Open-order count. Used for the `maxOpenOrders` clause. */
export function parseOpenOrderCount(raw: unknown): Result<number, BondedError> {
  if (!Array.isArray(raw)) {
    return err(
      bondedError(ErrorCode.EXCHANGE_MALFORMED_RESPONSE, "openOrders did not return an array"),
    );
  }
  return ok(raw.length);
}
