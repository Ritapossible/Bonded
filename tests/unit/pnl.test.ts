/**
 * Realised PnL tests.
 *
 * This figure is what `dailyLossLimitUsd` and `maxDrawdownPct` compare against, so an
 * error here is a limit that binds at the wrong number — worse than one that does not
 * bind at all, because it looks like it is working.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decimalUnsafe, type DecimalString } from "../../src/core/money.js";
import { computeRealisedPnl, type Trade } from "../../src/domain/pnl.js";

const DAY = Date.parse("2026-09-06T12:00:00.000Z");
const YESTERDAY = Date.parse("2026-09-05T12:00:00.000Z");
const QUOTE = new Set(["USDT"]);

let nextId = 1;

function trade(overrides: Partial<Trade> = {}): Trade {
  const quantity = overrides.quantity ?? decimalUnsafe("1");
  const price = overrides.price ?? decimalUnsafe("2000");
  return {
    symbol: "ETHUSDT",
    id: nextId++,
    timeMs: DAY,
    isBuyer: true,
    price,
    quantity,
    quoteQuantity: (Number(price) * Number(quantity)).toString() as DecimalString,
    commission: decimalUnsafe("0"),
    commissionAsset: "USDT",
    ...overrides,
  };
}

describe("computeRealisedPnl", () => {
  it("reports zero with no trades", () => {
    const pnl = computeRealisedPnl([], DAY, QUOTE);
    expect(pnl.realised).toBe("0");
    expect(pnl.tradeCount).toBe(0);
  });

  it("realises nothing on a buy — the position is still open", () => {
    // A buy is not a loss. Treating quote outflow as a loss would fire the limit on
    // the first order of every day.
    const pnl = computeRealisedPnl([trade()], DAY, QUOTE);
    expect(pnl.realised).toBe("0");
  });

  it("realises a profit on a round trip", () => {
    const pnl = computeRealisedPnl(
      [
        trade({ price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ isBuyer: false, price: decimalUnsafe("2100"), quantity: decimalUnsafe("1") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("100");
  });

  it("realises a loss on a round trip", () => {
    const pnl = computeRealisedPnl(
      [
        trade({ price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ isBuyer: false, price: decimalUnsafe("1900"), quantity: decimalUnsafe("1") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("-100");
  });

  it("averages the cost basis across several buys", () => {
    // Buy 1 @ 2000 and 1 @ 3000 -> average 2500. Selling both at 2500 is flat.
    const pnl = computeRealisedPnl(
      [
        trade({ price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ price: decimalUnsafe("3000"), quantity: decimalUnsafe("1") }),
        trade({ isBuyer: false, price: decimalUnsafe("2500"), quantity: decimalUnsafe("2") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("0");
  });

  it("uses yesterday's trades for basis without counting them", () => {
    // The position was opened yesterday; only today's sell realises.
    const pnl = computeRealisedPnl(
      [
        trade({ timeMs: YESTERDAY, price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ isBuyer: false, price: decimalUnsafe("1800"), quantity: decimalUnsafe("1") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("-200");
    expect(pnl.tradeCount).toBe(1);
    expect(pnl.unbasisedQuantity.size).toBe(0);
  });

  it("reports a sell with no known basis instead of guessing", () => {
    // The position predates the window entirely. Inventing a basis would produce a
    // confident wrong number, which is the failure mode this design refuses.
    const pnl = computeRealisedPnl(
      [trade({ isBuyer: false, price: decimalUnsafe("1800"), quantity: decimalUnsafe("2") })],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("0");
    expect(pnl.unbasisedQuantity.get("ETHUSDT")).toBe("2");
  });

  it("splits a partly-basised sell", () => {
    const pnl = computeRealisedPnl(
      [
        trade({ price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ isBuyer: false, price: decimalUnsafe("1900"), quantity: decimalUnsafe("3") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("-100");
    expect(pnl.unbasisedQuantity.get("ETHUSDT")).toBe("2");
  });

  it("subtracts quote-asset commission", () => {
    const pnl = computeRealisedPnl(
      [
        trade({ commission: decimalUnsafe("2"), commissionAsset: "USDT" }),
        trade({
          isBuyer: false,
          price: decimalUnsafe("2000"),
          quantity: decimalUnsafe("1"),
          commission: decimalUnsafe("3"),
          commissionAsset: "USDT",
        }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("-5");
    expect(pnl.commission).toBe("5");
  });

  it("treats base-asset commission as a smaller position", () => {
    // 1 ETH bought with 0.1 ETH fee leaves 0.9 held, so only 0.9 can be sold with basis.
    const pnl = computeRealisedPnl(
      [
        trade({
          price: decimalUnsafe("2000"),
          quantity: decimalUnsafe("1"),
          commission: decimalUnsafe("0.1"),
          commissionAsset: "ETH",
        }),
        trade({ isBuyer: false, price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.unbasisedQuantity.get("ETHUSDT")).toBe("0.1");
  });

  it("keeps symbols independent", () => {
    const pnl = computeRealisedPnl(
      [
        trade({ symbol: "ETHUSDT", price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
        trade({ symbol: "BTCUSDT", price: decimalUnsafe("60000"), quantity: decimalUnsafe("1") }),
        trade({
          symbol: "BTCUSDT",
          isBuyer: false,
          price: decimalUnsafe("59000"),
          quantity: decimalUnsafe("1"),
        }),
      ],
      DAY,
      QUOTE,
    );
    expect(pnl.realised).toBe("-1000");
    expect(pnl.unbasisedQuantity.size).toBe(0);
  });

  it("is independent of the order trades are supplied in", () => {
    // A caller merging several symbols' histories must not be able to corrupt the
    // result by interleaving them wrongly.
    const trades = [
      trade({ price: decimalUnsafe("2000"), quantity: decimalUnsafe("1") }),
      trade({ price: decimalUnsafe("3000"), quantity: decimalUnsafe("1") }),
      trade({ isBuyer: false, price: decimalUnsafe("2400"), quantity: decimalUnsafe("2") }),
    ];
    const forward = computeRealisedPnl(trades, DAY, QUOTE).realised;
    const reversed = computeRealisedPnl([...trades].reverse(), DAY, QUOTE).realised;
    expect(reversed).toBe(forward);
  });

  it("never reports a loss when every sale is above its cost", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 20 }),
        (buyPrice, uplift, quantity) => {
          const pnl = computeRealisedPnl(
            [
              trade({
                price: decimalUnsafe(String(buyPrice)),
                quantity: decimalUnsafe(String(quantity)),
              }),
              trade({
                isBuyer: false,
                price: decimalUnsafe(String(buyPrice + uplift)),
                quantity: decimalUnsafe(String(quantity)),
              }),
            ],
            DAY,
            QUOTE,
          );
          expect(Number(pnl.realised)).toBeGreaterThan(0);
        },
      ),
    );
  });
});
