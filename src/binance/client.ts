/**
 * Binance Spot REST client.
 *
 * Scoped to exactly what BONDED needs: exchange metadata, account state, order
 * placement and cancellation, and order history for reconciliation. Deliberately not a
 * general-purpose SDK — a smaller surface is a smaller thing to get wrong, and every
 * endpoint here is one the gate or the reconciler depends on.
 *
 * Production concerns handled here rather than left to callers:
 *
 * - **Signing.** HMAC-SHA256 over the exact query string that is sent, with
 *   `timestamp` and `recvWindow`, per Binance's `TRADE`/`USER_DATA` security type.
 * - **Timeouts.** Every request carries an `AbortSignal`. A hung socket must not
 *   become a hung gate.
 * - **Retries.** Only on transport failures and 5xx, and only for idempotent reads.
 *   **Order placement is never retried automatically** — a timeout does not tell you
 *   whether the order reached the matching engine, and a blind retry is how a bounded
 *   mandate produces two positions.
 * - **Rate limits.** 429 and 418 honour `Retry-After`, and used-weight headers are
 *   surfaced so the caller can back off before being banned.
 */

import { createHmac } from "node:crypto";
import { systemClock, type Clock } from "../core/clock.js";
import type { Secret } from "../config/env.js";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { Logger } from "../observability/logger.js";

export type QueryValue = string | number | boolean;
export type Query = Readonly<Record<string, QueryValue | undefined>>;

export interface BinanceClientOptions {
  readonly baseUrl: string;
  readonly apiKey: Secret;
  readonly secretKey: Secret;
  readonly timeoutMs: number;
  readonly recvWindowMs: number;
  /** Injected so a signed request's timestamp is testable and consistent with the rest. */
  readonly clock?: Clock;
  readonly logger: Logger;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  /**
   * Injected so tests do not have to spend real seconds proving that backoff happens.
   * Defaults to a real timer.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Binance's own error envelope. */
interface BinanceErrorBody {
  readonly code: number;
  readonly msg: string;
}

interface RequestOptions {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Query;
  /**
   * PUBLIC — no credential. API_KEY — the key header only, no signature (Binance's
   * `USER_STREAM` type). SIGNED — key header plus an HMAC over the query string.
   */
  readonly security: "PUBLIC" | "API_KEY" | "SIGNED";
  /**
   * Whether an interrupted attempt may be retried. False for anything that creates or
   * cancels an order: the safe response to an ambiguous write is to surface it.
   */
  readonly retryable: boolean;
}

const RETRYABLE_STATUS = new Set([408, 429, 418, 500, 502, 503, 504]);

export class BinanceClient {
  readonly #baseUrl: string;
  readonly #apiKey: Secret;
  readonly #secretKey: Secret;
  readonly #timeoutMs: number;
  readonly #recvWindowMs: number;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** A wait the exchange asked for, consumed by the next attempt. */
  #nextAttemptDelayMs: number | undefined;

  /** Most recent used-weight reading, for backoff decisions and the console. */
  #usedWeight = 0;

  constructor(options: BinanceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#secretKey = options.secretKey;
    this.#timeoutMs = options.timeoutMs;
    this.#recvWindowMs = options.recvWindowMs;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger.child({ component: "binance-client" });
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? delay;
  }

  get usedWeight(): number {
    return this.#usedWeight;
  }

  /**
   * Build the query string.
   *
   * Order is preserved exactly as assembled, because the signature is computed over
   * this literal string and Binance re-verifies it against the bytes it receives.
   * Re-encoding or re-ordering between signing and sending is the classic cause of
   * `-1022 Signature for this request is not valid`.
   */
  #buildQuery(query: Query, signed: boolean): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.append(key, String(value));
    }
    if (signed) {
      params.append("recvWindow", String(this.#recvWindowMs));
      params.append("timestamp", String(this.#clock.now()));
    }
    const queryString = params.toString();
    if (!signed) return queryString;

    const signature = createHmac("sha256", this.#secretKey.expose())
      .update(queryString, "utf8")
      .digest("hex");
    return `${queryString}&signature=${signature}`;
  }

  async #request<T>(options: RequestOptions): Promise<Result<T, BondedError>> {
    let lastError: BondedError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        const honoured = this.#nextAttemptDelayMs;
        this.#nextAttemptDelayMs = undefined;
        await this.#sleep(honoured ?? backoffMs(attempt));
      }

      const attemptResult = await this.#attempt<T>(options);
      if (attemptResult.ok) return attemptResult;

      lastError = attemptResult.error;

      const retryable =
        options.retryable && isRetryableError(attemptResult.error) && attempt < this.#maxRetries;
      if (!retryable) return attemptResult;

      // Binance says how long to wait; ignoring it and retrying on our own schedule is
      // how three rapid re-violations turn a 429 into a 418 IP ban — which takes the
      // audit path down, which halts trading. Its own backoff wins over ours.
      const retryAfterMs = retryAfterFrom(attemptResult.error);
      if (retryAfterMs !== undefined) {
        if (retryAfterMs > MAX_RETRY_AFTER_MS) {
          // Longer than we are willing to hold a request open. Surface it rather than
          // sleeping for minutes inside a call the gate is waiting on.
          this.#logger.warn(
            { path: options.path, retryAfterMs },
            "exchange asked for a longer wait than the retry budget; not retrying",
          );
          return attemptResult;
        }
        this.#nextAttemptDelayMs = retryAfterMs;
      }

      this.#logger.warn(
        {
          path: options.path,
          attempt: attempt + 1,
          code: attemptResult.error.code,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
        "retrying Binance request",
      );
    }

    return err(
      lastError ??
        bondedError(ErrorCode.EXCHANGE_UNREACHABLE, "request failed with no recorded error"),
    );
  }

  async #attempt<T>(options: RequestOptions): Promise<Result<T, BondedError>> {
    const signed = options.security === "SIGNED";
    const queryString = this.#buildQuery(options.query ?? {}, signed);
    const url = `${this.#baseUrl}${options.path}${queryString === "" ? "" : `?${queryString}`}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (signed || options.security === "API_KEY") {
      headers["X-MBX-APIKEY"] = this.#apiKey.expose();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method,
        headers,
        signal: controller.signal,
      });
    } catch (cause: unknown) {
      const aborted = controller.signal.aborted;
      return err(
        bondedError(
          ErrorCode.EXCHANGE_UNREACHABLE,
          aborted ? "request timed out" : "request failed at the transport layer",
          { path: options.path, timeoutMs: this.#timeoutMs },
          cause,
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    this.#recordRateLimitHeaders(response);

    const text = await response.text();

    if (!response.ok) {
      return err(this.#toError(response, text, options.path));
    }

    try {
      return ok(JSON.parse(text) as T);
    } catch (cause: unknown) {
      return err(
        bondedError(
          ErrorCode.EXCHANGE_MALFORMED_RESPONSE,
          "Binance returned a body that is not valid JSON",
          { path: options.path, status: response.status },
          cause,
        ),
      );
    }
  }

  #recordRateLimitHeaders(response: Response): void {
    for (const [name, value] of response.headers) {
      if (name.toLowerCase().startsWith("x-mbx-used-weight")) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) this.#usedWeight = parsed;
      }
    }
  }

  #toError(response: Response, body: string, path: string): BondedError {
    let binanceCode: number | undefined;
    let binanceMessage: string | undefined;
    try {
      const parsed = JSON.parse(body) as Partial<BinanceErrorBody>;
      if (typeof parsed.code === "number") binanceCode = parsed.code;
      if (typeof parsed.msg === "string") binanceMessage = parsed.msg;
    } catch {
      // Non-JSON error body — gateway pages and the like. The status still tells us
      // what we need, so this is not itself a failure.
    }

    const retryAfter = response.headers.get("retry-after");
    const details: Record<string, unknown> = {
      path,
      status: response.status,
      ...(binanceCode === undefined ? {} : { binanceCode }),
      ...(binanceMessage === undefined ? {} : { binanceMessage }),
      ...(retryAfter === null ? {} : { retryAfter }),
    };

    // 4xx other than rate limiting means Binance understood and refused: a bad
    // signature, an unknown symbol, insufficient balance. Retrying cannot help.
    const code =
      response.status === 429 || response.status === 418 || response.status >= 500
        ? ErrorCode.EXCHANGE_HTTP
        : ErrorCode.EXCHANGE_REJECTED;

    return bondedError(
      code,
      binanceMessage ?? `Binance returned HTTP ${String(response.status)}`,
      details,
    );
  }

  // ---- Endpoints -----------------------------------------------------------

  /** Server time, used to detect clock skew before it becomes a signature failure. */
  async serverTime(): Promise<Result<{ serverTime: number }, BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/time",
      security: "PUBLIC",
      retryable: true,
    });
  }

  /**
   * API key permissions.
   *
   * Used by the withdrawal boot guard. This is a mainnet (`/sapi`) endpoint and is not
   * expected to exist on Spot Testnet — callers must treat a failure as "could not
   * verify" rather than as "withdrawals are disabled".
   */
  async apiRestrictions(): Promise<Result<{ enableWithdrawals: boolean }, BondedError>> {
    const raw = await this.#request<unknown>({
      method: "GET",
      path: "/sapi/v1/account/apiRestrictions",
      security: "SIGNED",
      retryable: true,
    });
    if (!raw.ok) return raw;

    const body = raw.value as { enableWithdrawals?: unknown };
    if (typeof body.enableWithdrawals !== "boolean") {
      return err(
        bondedError(
          ErrorCode.EXCHANGE_MALFORMED_RESPONSE,
          "apiRestrictions did not report enableWithdrawals",
        ),
      );
    }
    return ok({ enableWithdrawals: body.enableWithdrawals });
  }

  /** Symbol metadata and trading filters — the grounding source for a mandate. */
  async exchangeInfo(symbols?: readonly string[]): Promise<Result<unknown, BondedError>> {
    const query: Query =
      symbols === undefined || symbols.length === 0
        ? {}
        : { symbols: JSON.stringify([...symbols]) };
    return this.#request({
      method: "GET",
      path: "/api/v3/exchangeInfo",
      query,
      security: "PUBLIC",
      retryable: true,
    });
  }

  async account(): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/account",
      security: "SIGNED",
      retryable: true,
    });
  }

  /** Open orders. Omitting `symbol` is far heavier in rate-limit weight — pass one where possible. */
  async openOrders(symbol?: string): Promise<Result<unknown[], BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/openOrders",
      query: symbol === undefined ? {} : { symbol },
      security: "SIGNED",
      retryable: true,
    });
  }

  /** All orders for a symbol, including ones BONDED never authorised. The reconciler's backstop. */
  async allOrders(
    symbol: string,
    options: { readonly startTime?: number; readonly limit?: number } = {},
  ): Promise<Result<unknown[], BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/allOrders",
      query: {
        symbol,
        ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
        limit: options.limit ?? 500,
      },
      security: "SIGNED",
      retryable: true,
    });
  }

  /**
   * Executed fills for a symbol. The input to realised-PnL computation.
   *
   * `startTime` reaches back beyond the current day so a position opened earlier has a
   * known cost basis; without that, a sell would be reported as unbasised.
   */
  async myTrades(
    symbol: string,
    options: {
      readonly startTime?: number;
      /** Fetch only trades after this id. Mutually exclusive with `startTime`. */
      readonly fromId?: number;
      readonly limit?: number;
    } = {},
  ): Promise<Result<unknown[], BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/myTrades",
      query: {
        symbol,
        ...(options.fromId === undefined ? {} : { fromId: options.fromId }),
        ...(options.fromId === undefined && options.startTime !== undefined
          ? { startTime: options.startTime }
          : {}),
        limit: options.limit ?? 1000,
      },
      security: "SIGNED",
      retryable: true,
    });
  }

  async tickerPrice(symbols: readonly string[]): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "GET",
      path: "/api/v3/ticker/price",
      query: buildTickerQuery(symbols),
      security: "PUBLIC",
      retryable: true,
    });
  }

  // ---- User data stream ----------------------------------------------------
  //
  // The listen-key flow. Binance also exposes `userDataStream.subscribe` over the
  // WebSocket API, but that requires an authenticated session (`session.logon`), which
  // in turn requires Ed25519 keys — the listen-key flow works with the HMAC keys the
  // testnet hands out, so it is what BONDED uses. See MEMORY.md.

  /** Open a user data stream and return its listen key. Valid for 60 minutes. */
  async createListenKey(): Promise<Result<string, BondedError>> {
    const raw = await this.#request<unknown>({
      method: "POST",
      path: "/api/v3/userDataStream",
      security: "API_KEY",
      retryable: true,
    });
    if (!raw.ok) return raw;
    const body = raw.value as { listenKey?: unknown };
    if (typeof body.listenKey !== "string" || body.listenKey === "") {
      return err(
        bondedError(ErrorCode.EXCHANGE_MALFORMED_RESPONSE, "userDataStream returned no listenKey"),
      );
    }
    return ok(body.listenKey);
  }

  /**
   * Extend a listen key's validity.
   *
   * Must be called well inside the 60-minute window. A lapsed key silently stops
   * delivering events, which would blind the audit path without any error surfacing —
   * so the caller treats a keepalive failure as a reason to halt, not to continue.
   */
  async keepAliveListenKey(listenKey: string): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "PUT",
      path: "/api/v3/userDataStream",
      query: { listenKey },
      security: "API_KEY",
      retryable: true,
    });
  }

  async closeListenKey(listenKey: string): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "DELETE",
      path: "/api/v3/userDataStream",
      query: { listenKey },
      security: "API_KEY",
      retryable: false,
    });
  }

  /**
   * Place an order.
   *
   * **Never retried.** A timeout leaves it genuinely unknown whether the order reached
   * the matching engine, and a second attempt could double the position — which is
   * exactly the outcome the mandate exists to prevent. The caller gets the ambiguity
   * and must resolve it by querying, not by guessing.
   */
  async placeOrder(params: Query): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "POST",
      path: "/api/v3/order",
      query: params,
      security: "SIGNED",
      retryable: false,
    });
  }

  async cancelOrder(params: Query): Promise<Result<unknown, BondedError>> {
    return this.#request({
      method: "DELETE",
      path: "/api/v3/order",
      query: params,
      security: "SIGNED",
      retryable: false,
    });
  }
}

/**
 * Binance exposes two spellings for this endpoint: `symbol` for one pair and `symbols`
 * for a batch. Using the batch form for a single symbol works but costs more rate-limit
 * weight, so the single form is preferred where it applies.
 */
function buildTickerQuery(symbols: readonly string[]): Query {
  const [only] = symbols;
  if (symbols.length === 1 && only !== undefined) return { symbol: only };
  return { symbols: JSON.stringify([...symbols]) };
}

/** Longest `Retry-After` we will wait inside a single call. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The wait Binance asked for, in milliseconds.
 *
 * `Retry-After` is either delta-seconds or an HTTP date; both are accepted. A value that
 * is absent, unparseable or in the past yields `undefined`, and the caller falls back to
 * its own backoff.
 */
function retryAfterFrom(error: BondedError): number | undefined {
  const raw = error.details["retryAfter"];
  if (typeof raw !== "string") return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.ceil(seconds * 1_000) : undefined;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const waitMs = at - Date.now();
  return waitMs > 0 ? waitMs : undefined;
}

function isRetryableError(error: BondedError): boolean {
  if (error.code === ErrorCode.EXCHANGE_UNREACHABLE) return true;
  if (error.code !== ErrorCode.EXCHANGE_HTTP) return false;
  const status = error.details["status"];
  return typeof status === "number" && RETRYABLE_STATUS.has(status);
}

/** Exponential backoff with jitter, so concurrent clients do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 250, 4_000);
  return base + Math.random() * 250;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
