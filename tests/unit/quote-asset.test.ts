/**
 * The audit's H5. A mandate allowlisting BTCUSDT and ETHBTC produced a quoteBalance
 * that added dollars to bitcoin, and an ETHBTC order worth tens of thousands of dollars
 * carried a notional of "0.4" against a maxNotionalUsd of "500". The limits did not
 * fail — they measured the wrong thing, silently.
 */

import { describe, expect, it } from "vitest";
import { decimalUnsafe } from "../../src/core/money.js";
import type { SymbolRules } from "../../src/domain/exchange.js";
import { USD_QUOTE_ASSETS, checkQuoteAssets } from "../../src/domain/quote-asset.js";

function rules(symbol: string, baseAsset: string, quoteAsset: string): SymbolRules {
  return {
    symbol,
    status: "TRADING",
    baseAsset,
    quoteAsset,
    tickSize: decimalUnsafe("0.01"),
    minPrice: decimalUnsafe("0.01"),
    maxPrice: decimalUnsafe("1000000"),
    stepSize: decimalUnsafe("0.0001"),
    minQty: decimalUnsafe("0.0001"),
    maxQty: decimalUnsafe("9000"),
    minNotional: decimalUnsafe("5"),
  };
}

function map(...entries: SymbolRules[]): ReadonlyMap<string, SymbolRules> {
  return new Map(entries.map((entry) => [entry.symbol, entry]));
}

describe("checkQuoteAssets", () => {
  it("accepts a single USD-pegged quote asset", () => {
    const result = checkQuoteAssets(map(rules("ETHUSDT", "ETH", "USDT")));
    expect(result.ok && result.value.quoteAssets).toEqual(["USDT"]);
  });

  it("accepts several USD-pegged quote assets, which are worth the same thing", () => {
    const result = checkQuoteAssets(
      map(rules("ETHUSDT", "ETH", "USDT"), rules("BTCUSDC", "BTC", "USDC")),
    );
    expect(result.ok && result.value.quoteAssets).toEqual(["USDC", "USDT"]);
  });

  it("rejects the BTC-quoted pair that made the caps meaningless", () => {
    const result = checkQuoteAssets(
      map(rules("BTCUSDT", "BTC", "USDT"), rules("ETHBTC", "ETH", "BTC")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("USD-pegged");
    expect(result.error.details).toMatchObject({
      offenders: [{ symbol: "ETHBTC", quoteAsset: "BTC" }],
    });
  });

  it("rejects an ETH-quoted pair", () => {
    expect(checkQuoteAssets(map(rules("BNBETH", "BNB", "ETH"))).ok).toBe(false);
  });

  it("names every offender, not just the first", () => {
    const result = checkQuoteAssets(
      map(rules("ETHBTC", "ETH", "BTC"), rules("BNBETH", "BNB", "ETH")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const { offenders } = result.error.details as { offenders: unknown[] };
    expect(offenders).toHaveLength(2);
  });

  it("is case-insensitive about the quote asset", () => {
    expect(checkQuoteAssets(map(rules("ETHUSDT", "ETH", "usdt"))).ok).toBe(true);
  });

  it("accepts an empty rule set rather than inventing a failure", () => {
    expect(checkQuoteAssets(map()).ok).toBe(true);
  });

  it("permits every asset it advertises as permitted", () => {
    for (const asset of USD_QUOTE_ASSETS) {
      expect(checkQuoteAssets(map(rules(`ETH${asset}`, "ETH", asset))).ok).toBe(true);
    }
  });
});
