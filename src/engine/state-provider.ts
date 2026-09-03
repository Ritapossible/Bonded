/**
 * Assembling the exchange state the gate reads.
 *
 * The project rule is that state is *derived, never remembered*: drawdown and exposure
 * come from what Binance currently reports, not from a counter BONDED increments. A
 * restart must therefore reproduce identical gate decisions.
 *
 * Caching here is a rate-limit concession, not a source of truth. Every cached value
 * carries the instant it was observed, and the gate independently refuses anything it
 * considers stale — so a cache that goes cold causes denials, never silent passes.
 */

import type { BinanceClient } from "../binance/client.js";
import {
  parseAccount,
  parseExchangeInfo,
  parseOpenOrderCount,
  parseTickerPrices,
} from "../binance/mappers.js";
import type { Clock } from "../core/clock.js";
import { utcDayKey } from "../core/clock.js";
import type { BondedError } from "../core/errors.js";
import { ZERO } from "../core/money.js";
import { ok, type Result } from "../core/result.js";
import type { ExchangeState, SymbolRules } from "../domain/exchange.js";
import { STALENESS_BUDGET_MS } from "../domain/exchange.js";

/**
 * Refresh slightly ahead of the gate's staleness budget, so a snapshot is renewed
 * before it expires rather than after an order has already been denied for it.
 */
const REFRESH_MARGIN_MS = 1_000;

interface Cached<T> {
  readonly value: T;
  readonly observedAtMs: number;
}

export interface StateProviderOptions {
  readonly client: BinanceClient;
  readonly clock: Clock;
  /** Symbols to keep priced. Taken from the mandate's allowlist. */
  readonly symbols: readonly string[];
}

export class StateProvider {
  readonly #client: BinanceClient;
  readonly #clock: Clock;
  readonly #symbols: readonly string[];

  #symbolRules: Map<string, SymbolRules> = new Map();
  #account:
    | Cached<{ canTrade: boolean; balances: ReadonlyMap<string, string>; openOrderCount: number }>
    | undefined;
  #prices: Cached<ReadonlyMap<string, string>> | undefined;
  /** In-flight refreshes, so concurrent orders share one round trip. */
  #inFlight = new Map<string, Promise<unknown>>();

  constructor(options: StateProviderOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#symbols = options.symbols;
  }

  get symbolRules(): ReadonlyMap<string, SymbolRules> {
    return this.#symbolRules;
  }

  /**
   * Load symbol rules from `exchangeInfo`.
   *
   * Called once at startup and refreshable on demand. This is the grounding step: a
   * mandate naming a symbol absent from the result fails to compile rather than
   * failing at the first order.
   */
  async loadSymbolRules(): Promise<Result<ReadonlyMap<string, SymbolRules>, BondedError>> {
    const raw = await this.#client.exchangeInfo(this.#symbols);
    if (!raw.ok) return raw;
    const parsed = parseExchangeInfo(raw.value);
    if (!parsed.ok) return parsed;
    this.#symbolRules = parsed.value;
    return ok(this.#symbolRules);
  }

  /** Deduplicate concurrent refreshes of the same resource. */
  async #once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const task = run().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, task);
    return task;
  }

  #isFresh(observedAtMs: number, budgetMs: number): boolean {
    const age = this.#clock.now() - observedAtMs;
    return age >= 0 && age <= budgetMs - REFRESH_MARGIN_MS;
  }

  async #refreshAccount(): Promise<Result<void, BondedError>> {
    return this.#once("account", async () => {
      // Order matters: count open orders first, so the count cannot be newer than the
      // balance snapshot it is reported alongside.
      const openOrders = await this.#client.openOrders();
      if (!openOrders.ok) return openOrders;
      const count = parseOpenOrderCount(openOrders.value);
      if (!count.ok) return count;

      const raw = await this.#client.account();
      if (!raw.ok) return raw;
      const observedAtMs = this.#clock.now();
      const parsed = parseAccount(raw.value, observedAtMs, count.value);
      if (!parsed.ok) return parsed;

      this.#account = {
        observedAtMs,
        value: {
          canTrade: parsed.value.canTrade,
          balances: parsed.value.balances,
          openOrderCount: parsed.value.openOrderCount,
        },
      };
      return ok(undefined);
    });
  }

  async #refreshPrices(): Promise<Result<void, BondedError>> {
    return this.#once("prices", async () => {
      if (this.#symbols.length === 0) {
        this.#prices = { observedAtMs: this.#clock.now(), value: new Map() };
        return ok(undefined);
      }
      const raw = await this.#client.tickerPrice(this.#symbols);
      if (!raw.ok) return raw;
      const observedAtMs = this.#clock.now();
      const parsed = parseTickerPrices(raw.value, observedAtMs);
      if (!parsed.ok) return parsed;
      this.#prices = { observedAtMs, value: parsed.value.prices };
      return ok(undefined);
    });
  }

  /**
   * Produce a state snapshot for a gate evaluation, refreshing whatever has aged out.
   *
   * A refresh failure is *not* propagated as an error: the stale snapshot is returned
   * as-is, and the gate denies on freshness. That keeps a single failure mode — an
   * order refused with a clause naming the stale snapshot — rather than two different
   * error paths, one of which might be handled less carefully than the other.
   */
  async snapshot(): Promise<ExchangeState> {
    const tasks: Promise<unknown>[] = [];
    if (
      this.#account === undefined ||
      !this.#isFresh(this.#account.observedAtMs, STALENESS_BUDGET_MS.account)
    ) {
      tasks.push(this.#refreshAccount());
    }
    if (
      this.#prices === undefined ||
      !this.#isFresh(this.#prices.observedAtMs, STALENESS_BUDGET_MS.prices)
    ) {
      tasks.push(this.#refreshPrices());
    }
    await Promise.all(tasks);

    const now = this.#clock.now();
    // A never-observed snapshot is represented as infinitely old rather than as
    // "now", so the gate treats it as stale instead of trusting an empty default.
    const account = this.#account;
    const prices = this.#prices;

    return {
      account: {
        observedAtMs: account?.observedAtMs ?? Number.NEGATIVE_INFINITY,
        canTrade: account?.value.canTrade ?? false,
        balances: (account?.value.balances ?? new Map()) as ReadonlyMap<string, never>,
        openOrderCount: account?.value.openOrderCount ?? Number.MAX_SAFE_INTEGER,
      },
      prices: {
        observedAtMs: prices?.observedAtMs ?? Number.NEGATIVE_INFINITY,
        prices: (prices?.value ?? new Map()) as ReadonlyMap<string, never>,
      },
      dailyPnl: {
        // Day 3 replaces this with a figure derived from myTrades. Until then it is
        // reported as observed-now and zero, and the clause simply does not bind.
        observedAtMs: now,
        dayKey: utcDayKey(now),
        realisedUsd: ZERO,
      },
      symbolRules: this.#symbolRules,
    };
  }
}
