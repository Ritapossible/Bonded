/**
 * Binance client tests.
 *
 * This module signs every authenticated request and decides what may be retried. Both
 * are easy to get subtly wrong and impossible to notice until production: a signature
 * built over a different string than the one sent fails only against the real exchange,
 * and a retried order placement produces a second position rather than an error.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BinanceClient } from "../../src/binance/client.js";
import { Secret } from "../../src/config/env.js";
import { ErrorCode } from "../../src/core/errors.js";
import { createSilentLogger } from "../../src/observability/logger.js";

const API_KEY = "k".repeat(32);
const SECRET_KEY = "v".repeat(32);

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/** Records every request and replays a scripted sequence of responses. */
function recorder(responses: (() => Response)[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: urlOf(input), method: init?.method ?? "GET", headers });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (next === undefined) throw new Error("no scripted response");
    return Promise.resolve(next());
  };
  return { calls, fetchImpl };
}

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(fetchImpl: typeof fetch, maxRetries = 0): BinanceClient {
  return new BinanceClient({
    baseUrl: "https://testnet.binance.vision",
    apiKey: new Secret(API_KEY),
    secretKey: new Secret(SECRET_KEY),
    timeoutMs: 500,
    recvWindowMs: 5_000,
    logger: createSilentLogger(),
    fetchImpl,
    maxRetries,
    sleep: () => Promise.resolve(),
  });
}

describe("signing", () => {
  it("signs exactly the query string it sends", async () => {
    // The signature is verified by Binance against the literal bytes it receives, so
    // re-encoding or re-ordering between signing and sending is the classic cause of
    // `-1022 Signature for this request is not valid`.
    const { calls, fetchImpl } = recorder([() => json({ canTrade: true, balances: [] })]);
    await client(fetchImpl).account();

    const url = new URL(calls[0]!.url);
    const signature = url.searchParams.get("signature");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    const signed = url.search.slice(1).replace(`&signature=${signature!}`, "");
    const expected = createHmac("sha256", SECRET_KEY).update(signed, "utf8").digest("hex");
    expect(signature).toBe(expected);
  });

  it("includes recvWindow and a timestamp on signed requests", async () => {
    const { calls, fetchImpl } = recorder([() => json({ canTrade: true, balances: [] })]);
    await client(fetchImpl).account();

    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get("recvWindow")).toBe("5000");
    expect(Number(params.get("timestamp"))).toBeGreaterThan(0);
  });

  it("sends the API key header on signed requests", async () => {
    const { calls, fetchImpl } = recorder([() => json({ canTrade: true, balances: [] })]);
    await client(fetchImpl).account();
    expect(calls[0]!.headers["x-mbx-apikey"]).toBe(API_KEY);
  });

  it("sends no credential on public requests", async () => {
    const { calls, fetchImpl } = recorder([() => json({ symbols: [] })]);
    await client(fetchImpl).exchangeInfo();
    expect(calls[0]!.headers["x-mbx-apikey"]).toBeUndefined();
    expect(calls[0]!.url).not.toContain("signature");
  });

  it("sends the key but no signature on user-stream requests", async () => {
    // Binance's USER_STREAM security type: header only. Signing these is rejected.
    const { calls, fetchImpl } = recorder([() => json({ listenKey: "abc123" })]);
    await client(fetchImpl).createListenKey();
    expect(calls[0]!.headers["x-mbx-apikey"]).toBe(API_KEY);
    expect(calls[0]!.url).not.toContain("signature");
  });
});

describe("retries", () => {
  it("retries a 5xx on an idempotent read", async () => {
    const { calls, fetchImpl } = recorder([
      () => json({ msg: "unavailable" }, 503),
      () => json({ serverTime: 1 }),
    ]);
    const result = await client(fetchImpl, 3).serverTime();
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("never retries order placement", async () => {
    // A timeout does not say whether the order reached the matching engine. Retrying
    // blind is how a bounded mandate produces two positions.
    const { calls, fetchImpl } = recorder([() => json({ msg: "unavailable" }, 503)]);
    const result = await client(fetchImpl, 3).placeOrder({ symbol: "ETHUSDT" });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never retries cancellation", async () => {
    const { calls, fetchImpl } = recorder([() => json({ msg: "unavailable" }, 503)]);
    await client(fetchImpl, 3).cancelOrder({ symbol: "ETHUSDT", orderId: 1 });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 4xx the exchange understood and refused", async () => {
    // A bad signature or an unknown symbol will not become valid on a second attempt.
    const { calls, fetchImpl } = recorder([
      () => json({ code: -1121, msg: "Invalid symbol." }, 400),
    ]);
    const result = await client(fetchImpl, 3).account();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(ErrorCode.EXCHANGE_REJECTED);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the retry budget", async () => {
    const { calls, fetchImpl } = recorder([() => json({ msg: "nope" }, 503)]);
    const result = await client(fetchImpl, 2).serverTime();
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(3); // the first attempt plus two retries
  });
});

describe("error mapping", () => {
  it("surfaces Binance's own error code and message", async () => {
    const { fetchImpl } = recorder([
      () => json({ code: -2010, msg: "Account has insufficient balance." }, 400),
    ]);
    const result = await client(fetchImpl).placeOrder({ symbol: "ETHUSDT" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe("Account has insufficient balance.");
    expect(result.error.details["binanceCode"]).toBe(-2010);
  });

  it("classifies rate limiting as retryable rather than a refusal", async () => {
    const { fetchImpl } = recorder([() => json({ msg: "too many" }, 429, { "retry-after": "3" })]);
    const result = await client(fetchImpl).serverTime();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(ErrorCode.EXCHANGE_HTTP);
    expect(result.error.details["retryAfterSeconds"]).toBe(3);
  });

  it("handles a non-JSON error body without throwing", async () => {
    const { fetchImpl } = recorder([() => new Response("<html>gateway</html>", { status: 502 })]);
    const result = await client(fetchImpl).serverTime();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(ErrorCode.EXCHANGE_HTTP);
  });

  it("reports a malformed success body rather than returning garbage", async () => {
    const { fetchImpl } = recorder([
      () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    const result = await client(fetchImpl).serverTime();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(ErrorCode.EXCHANGE_MALFORMED_RESPONSE);
  });

  it("reports a transport failure as unreachable", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await client(fetchImpl).serverTime();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(ErrorCode.EXCHANGE_UNREACHABLE);
  });

  it("never leaks the secret key into an error", async () => {
    const { fetchImpl } = recorder([() => json({ code: -1022, msg: "Signature invalid" }, 400)]);
    const result = await client(fetchImpl).account();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const serialised = JSON.stringify(result.error.toJSON());
    expect(serialised).not.toContain(SECRET_KEY);
    expect(serialised).not.toContain(API_KEY);
  });
});

describe("rate-limit accounting", () => {
  it("records the used-weight header", async () => {
    const { fetchImpl } = recorder([
      () => json({ serverTime: 1 }, 200, { "x-mbx-used-weight-1m": "142" }),
    ]);
    const c = client(fetchImpl);
    await c.serverTime();
    expect(c.usedWeight).toBe(142);
  });
});

describe("query construction", () => {
  it("omits undefined parameters entirely", async () => {
    const { calls, fetchImpl } = recorder([() => json([])]);
    await client(fetchImpl).allOrders("ETHUSDT");
    expect(calls[0]!.url).not.toContain("startTime");
  });

  it("uses the single-symbol form for one ticker", async () => {
    // The batch form works for one symbol but costs more rate-limit weight.
    const { calls, fetchImpl } = recorder([() => json({ symbol: "ETHUSDT", price: "1" })]);
    await client(fetchImpl).tickerPrice(["ETHUSDT"]);
    expect(calls[0]!.url).toContain("symbol=ETHUSDT");
    expect(calls[0]!.url).not.toContain("symbols=");
  });

  it("prefers fromId over startTime when fetching trades incrementally", async () => {
    const { calls, fetchImpl } = recorder([() => json([])]);
    await client(fetchImpl).myTrades("ETHUSDT", { fromId: 99, startTime: 1 });
    expect(calls[0]!.url).toContain("fromId=99");
    expect(calls[0]!.url).not.toContain("startTime");
  });
});
