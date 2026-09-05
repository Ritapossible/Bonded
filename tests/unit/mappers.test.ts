/**
 * Every Binance response passes through this module, and it had no tests at all.
 *
 * The stake is specific: these parsers are the boundary between the exchange's wire
 * format and every limit BONDED enforces. A field silently defaulted here becomes a cap
 * measured against the wrong number, and the gate has no way to know.
 */

import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/core/errors.js";
import {
  parseAccount,
  parseExchangeInfo,
  parseOpenOrderCount,
  parseTickerPrices,
  parseTrades,
} from "../../src/binance/mappers.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const ETH = {
  symbol: "ETHUSDT",
  status: "TRADING",
  baseAsset: "ETH",
  quoteAsset: "USDT",
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
    { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "9000", stepSize: "0.0001" },
    { filterType: "NOTIONAL", minNotional: "5" },
  ],
};

describe("parseExchangeInfo", () => {
  it("inherits the exchange's own filters rather than assuming any", () => {
    const parsed = parseExchangeInfo({ symbols: [ETH] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rules = parsed.value.get("ETHUSDT");
    expect(rules).toMatchObject({
      symbol: "ETHUSDT",
      status: "TRADING",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      tickSize: "0.01",
      stepSize: "0.0001",
      minNotional: "5",
    });
  });

  it("rejects a response that is not shaped like exchangeInfo", () => {
    const parsed = parseExchangeInfo({ nope: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(ErrorCode.EXCHANGE_MALFORMED_RESPONSE);
  });

  it("keeps a symbol that is halted, so the gate can refuse it by name", () => {
    // Dropping it would surface as "unlisted symbol", which is a different and more
    // alarming denial than "this pair is not trading right now".
    const parsed = parseExchangeInfo({ symbols: [{ ...ETH, status: "BREAK" }] });
    expect(parsed.ok && parsed.value.get("ETHUSDT")?.status).toBe("BREAK");
  });

  it("survives a symbol carrying filters it does not know about", () => {
    const parsed = parseExchangeInfo({
      symbols: [{ ...ETH, filters: [...ETH.filters, { filterType: "ICEBERG_PARTS", limit: 10 }] }],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("parseAccount", () => {
  const account = {
    canTrade: true,
    balances: [
      { asset: "USDT", free: "10000", locked: "0" },
      { asset: "ETH", free: "1.5", locked: "0.5" },
    ],
  };

  it("reads balances and the trading flag", () => {
    const parsed = parseAccount(account, NOW, 2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.canTrade).toBe(true);
    expect(parsed.value.balances.get("USDT")).toBe("10000");
    expect(parsed.value.openOrderCount).toBe(2);
    expect(parsed.value.observedAtMs).toBe(NOW);
  });

  it("carries canTrade=false through rather than defaulting it to true", () => {
    // The gate refuses on this. A default of true would silently re-enable trading on
    // an account the exchange has restricted.
    const parsed = parseAccount({ ...account, canTrade: false }, NOW, 0);
    expect(parsed.ok && parsed.value.canTrade).toBe(false);
  });

  it("rejects a response with no balances field", () => {
    expect(parseAccount({ canTrade: true }, NOW, 0).ok).toBe(false);
  });
});

describe("parseTickerPrices", () => {
  it("accepts a single ticker object", () => {
    const parsed = parseTickerPrices({ symbol: "ETHUSDT", price: "2000" }, NOW);
    expect(parsed.ok && parsed.value.prices.get("ETHUSDT")).toBe("2000");
  });

  it("accepts an array of tickers", () => {
    const parsed = parseTickerPrices(
      [
        { symbol: "ETHUSDT", price: "2000" },
        { symbol: "BTCUSDT", price: "60000" },
      ],
      NOW,
    );
    expect(parsed.ok && parsed.value.prices.size).toBe(2);
  });

  it("rejects a price that is not a decimal string", () => {
    expect(parseTickerPrices({ symbol: "ETHUSDT", price: 2000 }, NOW).ok).toBe(false);
  });
});

describe("parseTrades", () => {
  const fill = {
    symbol: "ETHUSDT",
    id: 1,
    time: NOW,
    isBuyer: true,
    price: "2000",
    qty: "1",
    quoteQty: "2000",
    commission: "0.1",
    commissionAsset: "USDT",
  };

  it("normalises a fill", () => {
    const parsed = parseTrades([fill]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]).toMatchObject({
      symbol: "ETHUSDT",
      id: 1,
      timeMs: NOW,
      isBuyer: true,
      quantity: "1",
      quoteQuantity: "2000",
      commissionAsset: "USDT",
    });
  });

  it("rejects a non-array", () => {
    expect(parseTrades({ trades: [] }).ok).toBe(false);
  });

  it("accepts an empty history", () => {
    const parsed = parseTrades([]);
    expect(parsed.ok && parsed.value).toEqual([]);
  });
});

describe("parseOpenOrderCount", () => {
  it("counts the array", () => {
    expect(parseOpenOrderCount([{}, {}, {}])).toEqual({ ok: true, value: 3 });
  });

  it("rejects anything that is not an array, rather than counting zero", () => {
    // Zero is the permissive answer for the maxOpenOrders clause, so guessing it from a
    // malformed response would relax a cap on the strength of a parse failure.
    expect(parseOpenOrderCount({ orders: [] }).ok).toBe(false);
    expect(parseOpenOrderCount(null).ok).toBe(false);
  });
});
