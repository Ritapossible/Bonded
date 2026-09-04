/**
 * Realised profit and loss, computed from the exchange's own trade history.
 *
 * The `dailyLossLimitUsd` and `maxDrawdownPct` clauses are only meaningful if the number
 * they compare against is defined precisely. An undefined risk metric is worse than no
 * metric: it produces a figure the operator trusts and cannot reason about. So the
 * definition is stated here and enforced by this module alone.
 *
 * **Definition.** Realised PnL is computed with an **average cost basis per symbol**,
 * walking trades in chronological order:
 *
 * - A **buy** increases the position and moves the average cost.
 * - A **sell** realises `(price − averageCost) × quantity` and reduces the position.
 * - **Commission** paid in the quote asset is subtracted from realised PnL. Commission
 *   paid in the base asset reduces the quantity acquired, which is the same thing
 *   expressed in the other unit.
 * - Only trades that occurred **today, UTC** contribute to the daily figure. Earlier
 *   trades are replayed solely to establish the cost basis.
 *
 * **What it deliberately does not do.** A position opened before the lookback window has
 * no known basis here. Selling it realises an unknown amount, so that quantity is
 * excluded from the figure and reported as `unbasisedQuantity` instead of being guessed
 * at. A wrong number presented confidently is the failure mode this design refuses.
 */

import { utcDayKey } from "../core/clock.js";
import {
  ZERO,
  add,
  compare,
  divide,
  greaterThan,
  multiply,
  subtract,
  type DecimalString,
} from "../core/money.js";

/** One fill, as Binance reports it. */
export interface Trade {
  readonly symbol: string;
  readonly id: number;
  readonly timeMs: number;
  readonly isBuyer: boolean;
  readonly price: DecimalString;
  readonly quantity: DecimalString;
  readonly quoteQuantity: DecimalString;
  readonly commission: DecimalString;
  readonly commissionAsset: string;
}

export interface RealisedPnl {
  /** UTC `YYYY-MM-DD` the figure covers. */
  readonly dayKey: string;
  /** Negative means a loss. Quote-asset units. */
  readonly realised: DecimalString;
  /** Commission paid today, in quote-asset units. Already included in `realised`. */
  readonly commission: DecimalString;
  /** Trades that contributed to the figure. */
  readonly tradeCount: number;
  /**
   * Base-asset quantity sold today with no known cost basis, by symbol.
   *
   * Non-empty means the figure understates activity: those sells realised something, and
   * this module declines to guess what. Surfaced so the caller can say so rather than
   * present an incomplete number as complete.
   */
  readonly unbasisedQuantity: ReadonlyMap<string, DecimalString>;
}

interface Position {
  quantity: DecimalString;
  /** Average cost per unit, in quote-asset units. */
  averageCost: DecimalString;
}

/**
 * Compute realised PnL for the UTC day containing `nowMs`.
 *
 * `trades` may span a longer window; anything before today establishes cost basis
 * without contributing to the figure. Order does not matter — trades are sorted here, so
 * a caller merging several symbols' histories cannot corrupt the result by interleaving
 * them wrongly.
 */
export function computeRealisedPnl(
  trades: readonly Trade[],
  nowMs: number,
  quoteAssets: ReadonlySet<string>,
): RealisedPnl {
  const dayKey = utcDayKey(nowMs);
  const positions = new Map<string, Position>();
  const unbasised = new Map<string, DecimalString>();

  let realised = ZERO;
  let commission = ZERO;
  let tradeCount = 0;

  // Sort by time, then by trade id: two fills can share a millisecond, and applying
  // them out of order would move the average cost incorrectly.
  const ordered = [...trades].sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);

  for (const trade of ordered) {
    const today = utcDayKey(trade.timeMs) === dayKey;
    const position = positions.get(trade.symbol) ?? { quantity: ZERO, averageCost: ZERO };

    if (trade.isBuyer) {
      // Commission charged in the base asset means fewer units actually acquired.
      const acquired = quoteAssets.has(trade.commissionAsset)
        ? trade.quantity
        : subtract(trade.quantity, trade.commission);

      const newQuantity = add(position.quantity, acquired);
      if (compare(newQuantity, ZERO) > 0) {
        const existingCost = multiply(position.quantity, position.averageCost);
        const addedCost = trade.quoteQuantity;
        position.averageCost = divide(add(existingCost, addedCost), newQuantity);
      }
      position.quantity = newQuantity;
    } else {
      const basised = min(trade.quantity, position.quantity);
      const unknown = subtract(trade.quantity, basised);

      if (today && greaterThan(basised, ZERO)) {
        const proceeds = multiply(basised, trade.price);
        const cost = multiply(basised, position.averageCost);
        realised = add(realised, subtract(proceeds, cost));
      }
      if (today && greaterThan(unknown, ZERO)) {
        unbasised.set(trade.symbol, add(unbasised.get(trade.symbol) ?? ZERO, unknown));
      }
      position.quantity = subtract(position.quantity, basised);
    }

    // Quote-asset commission is a direct cost; base-asset commission is already handled
    // above by reducing the acquired quantity.
    if (today && quoteAssets.has(trade.commissionAsset)) {
      realised = subtract(realised, trade.commission);
      commission = add(commission, trade.commission);
    }

    positions.set(trade.symbol, position);
    if (today) tradeCount++;
  }

  return {
    dayKey,
    realised,
    commission,
    tradeCount,
    unbasisedQuantity: unbasised,
  };
}

function min(a: DecimalString, b: DecimalString): DecimalString {
  return compare(a, b) <= 0 ? a : b;
}
