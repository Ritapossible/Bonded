/**
 * Every limit in a mandate is denominated in one currency.
 *
 * `maxNotionalUsd` and `dailyLossLimitUsd` say so in their names, the drawdown cap is a
 * percentage of a quote-asset balance summed across symbols, and realised PnL adds up
 * quote-asset proceeds from every pair. All three are only meaningful if the quote
 * assets involved are worth roughly the same thing.
 *
 * Nothing used to check that. A mandate allowlisting `BTCUSDT` and `ETHBTC` produced a
 * `quoteBalance` that added dollars to bitcoin, and an `ETHBTC` order of `0.4` BTC —
 * tens of thousands of dollars — carried a notional of `"0.4"` and passed a
 * `maxNotionalUsd` of `"500"` without touching the sides of the gate. The limits did not
 * fail; they silently measured the wrong thing.
 *
 * The rule here is deliberately narrow. Converting between quote assets would need a
 * live cross rate on the gate's hot path, and a limit that depends on a second price
 * feed fails in more ways than it prevents. So BONDED requires the mandate's symbols to
 * be quoted in USD-pegged assets and refuses to start otherwise, which is a smaller
 * promise that is actually true.
 */

import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { SymbolRules } from "./exchange.js";

/**
 * Quote assets treated as interchangeable with one US dollar.
 *
 * Each is a USD-pegged stablecoin listed on Binance Spot. A peg is not a guarantee, and
 * a depeg would make these limits wrong by however far the peg moved — but that error is
 * bounded and rare, where mixing BTC into a USD total is unbounded and routine.
 */
export const USD_QUOTE_ASSETS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "USDP",
  "BUSD",
  "DAI",
]);

export interface QuoteAssetCheck {
  /** The distinct quote assets across the mandate's symbols. */
  readonly quoteAssets: readonly string[];
}

/**
 * Verify that every allowlisted symbol is quoted in a USD-pegged asset.
 *
 * Called once at startup, after symbols are grounded against `exchangeInfo`, so the
 * answer comes from the exchange rather than from parsing the symbol name.
 */
export function checkQuoteAssets(
  symbolRules: ReadonlyMap<string, SymbolRules>,
): Result<QuoteAssetCheck, BondedError> {
  const offenders: { symbol: string; quoteAsset: string }[] = [];
  const quoteAssets = new Set<string>();

  for (const rules of symbolRules.values()) {
    const quoteAsset = rules.quoteAsset.toUpperCase();
    quoteAssets.add(quoteAsset);
    if (!USD_QUOTE_ASSETS.has(quoteAsset)) {
      offenders.push({ symbol: rules.symbol, quoteAsset });
    }
  }

  if (offenders.length > 0) {
    return err(
      bondedError(
        ErrorCode.MANDATE_INVALID,
        "every symbol must be quoted in a USD-pegged asset, because the mandate's limits are denominated in USD",
        {
          offenders,
          permitted: [...USD_QUOTE_ASSETS].sort(),
        },
      ),
    );
  }

  return ok({ quoteAssets: [...quoteAssets].sort() });
}
