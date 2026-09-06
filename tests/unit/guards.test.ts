/**
 * The boot guards, which had no tests.
 *
 * They are the last thing between a misconfiguration and a live account, and the
 * environment guard in particular is the control that the audit found had been a
 * substring match. `config/hosts.ts` is tested on its own; this covers the wiring —
 * that the guard actually consults it, and that a mismatch is fatal rather than a note.
 */

import { describe, expect, it } from "vitest";
import type { BinanceClient } from "../../src/binance/client.js";
import { Secret, type Config } from "../../src/config/env.js";
import { err, ok, unwrap, type Result } from "../../src/core/result.js";
import { ErrorCode, bondedError, type BondedError } from "../../src/core/errors.js";
import { compileMandate, type Mandate, type MandateSpec } from "../../src/domain/mandate.js";
import { runBootGuards } from "../../src/boot/guards.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const SPEC: MandateSpec = {
  version: 1,
  env: "testnet",
  symbols: ["ETHUSDT"],
  orderTypes: ["LIMIT"],
  sides: ["BUY", "SELL"],
  maxNotionalUsd: "500",
  maxOpenOrders: 3,
  dailyLossLimitUsd: "50",
  maxDrawdownPct: "5",
  tradingWindowUtc: ["00:00", "23:59"],
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function config(overrides: Partial<Config["binance"]> = {}, allowProd = false): Config {
  return {
    binance: {
      env: "testnet",
      apiKey: new Secret("k".repeat(32)),
      secretKey: new Secret("v".repeat(32)),
      baseUrl: "https://testnet.binance.vision",
      streamUrl: "wss://stream.testnet.binance.vision/ws",
      timeoutMs: 5_000,
      recvWindowMs: 5_000,
      ...overrides,
    },
    allowProd,
    allowPartialAudit: false,
    watchSymbols: [],
    priceSource: "rest",
    hmacSecret: new Secret("0".repeat(64)),
    mandatePath: "/tmp/does-not-exist/mandate.json",
    decisionLogPath: "/tmp/does-not-exist/decisions.jsonl",
    logLevel: "error",
    pollIntervalMs: 15_000,
    consolePort: 0,
  };
}

/** A client that answers only what the guards ask. */
function client(
  options: { serverTimeMs?: number; restrictions?: unknown; malformedTime?: boolean } = {},
): BinanceClient {
  return {
    serverTime: (): Promise<Result<{ serverTime: number }, BondedError>> =>
      Promise.resolve(
        ok(
          (options.malformedTime === true
            ? {}
            : { serverTime: options.serverTimeMs ?? Date.now() }) as { serverTime: number },
        ),
      ),
    apiRestrictions: (): Promise<Result<unknown, BondedError>> =>
      options.restrictions === undefined
        ? Promise.resolve(err(bondedError(ErrorCode.EXCHANGE_HTTP, "not available on testnet")))
        : Promise.resolve(ok(options.restrictions)),
  } as unknown as BinanceClient;
}

const mandate: Mandate = unwrap(compileMandate(SPEC), "mandate");

async function guard(name: string, ctx: Parameters<typeof runBootGuards>[0]) {
  const results = await runBootGuards(ctx);
  const found = results.find((result) => result.name === name);
  expect(found, `no guard named ${name}`).toBeDefined();
  return found!;
}

describe("the environment guard", () => {
  it("passes on a genuine testnet pair of hosts", async () => {
    const result = await guard("environment", {
      config: config(),
      client: client(),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("PASS");
    expect(result.detail).toContain("testnet.binance.vision");
  });

  it("fails a production host declared as testnet, however the URL is dressed up", async () => {
    // The substring check this replaced accepted every one of these.
    for (const baseUrl of [
      "https://api.binance.com/?x=testnet",
      "https://api.binance.com/testnet",
      "https://testnet.evil.com",
    ]) {
      const result = await guard("environment", {
        config: config({ baseUrl }),
        client: client(),
        mandate,
        nowMs: NOW,
      });
      expect(result.status, baseUrl).toBe("FAIL");
    }
  });

  it("fails when the stream host disagrees with the REST host", async () => {
    const result = await guard("environment", {
      config: config({ streamUrl: "wss://stream.binance.com:9443/ws" }),
      client: client(),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("prod host");
  });

  it("refuses production unless it was enabled explicitly", async () => {
    const prod = config({ env: "prod", baseUrl: "https://api.binance.com" });
    const result = await guard("environment", {
      config: prod,
      client: client(),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("BONDED_ALLOW_PROD");
  });

  it("warns rather than passes silently when production is enabled", async () => {
    const result = await guard("environment", {
      config: config(
        {
          env: "prod",
          baseUrl: "https://api.binance.com",
          streamUrl: "wss://stream.binance.com:9443/ws",
        },
        true,
      ),
      client: client(),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("PRODUCTION");
  });
});

describe("the clock skew guard", () => {
  it("passes when the local clock agrees with the exchange", async () => {
    const result = await guard("clockSkew", {
      config: config(),
      client: client({ serverTimeMs: Date.now() + 200 }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("PASS");
  });

  it("fails rather than passing when the exchange returns no usable time", async () => {
    // NaN skew made `Math.abs(skew) > limit` false, so the guard reported PASS on a
    // check it had not performed.
    const result = await guard("clockSkew", {
      config: config(),
      client: client({ malformedTime: true }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
  });

  it("fails on skew large enough to break signatures", async () => {
    const result = await guard("clockSkew", {
      config: config(),
      client: client({ serverTimeMs: Date.now() + 30_000 }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
  });

  /**
   * Binance's admission rule is asymmetric:
   *
   *     timestamp < (serverTime + 1000) && (serverTime - timestamp) <= recvWindow
   *
   * A single `Math.abs(skew) > 2000` treated both directions alike, so a clock ~1.7s
   * AHEAD passed the guard — and then every signed request came back `-1021 Timestamp
   * for this request is outside of the recvWindow`. Found by running it, not reading it.
   */
  it("fails a clock that is ahead by less than the old symmetric limit", async () => {
    // Local ahead of the exchange by ~1.7s: `Math.abs(skew) > 2000` was false, so this
    // used to PASS. Binance rejects it, because being ahead is capped at 1000 ms and
    // recvWindow cannot widen that.
    const result = await guard("clockSkew", {
      config: config(),
      client: client({ serverTimeMs: Date.now() - 1_700 }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("AHEAD");
    expect(result.detail).toContain("1000 ms");
  });

  it("still allows the same distance behind, which the exchange tolerates", async () => {
    // The asymmetry is the point: recvWindow covers being behind, nothing covers being
    // ahead. Failing both alike would reject a clock the exchange is happy with.
    const result = await guard("clockSkew", {
      config: config(),
      client: client({ serverTimeMs: Date.now() + 1_700 }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("PASS");
    expect(result.detail).toContain("behind");
  });

  it("names the direction, so the fix is obvious from the banner", async () => {
    const behind = await guard("clockSkew", {
      config: config(),
      client: client({ serverTimeMs: Date.now() + 30_000 }),
      mandate,
      nowMs: NOW,
    });
    expect(behind.detail).toContain("BEHIND");
  });
});

describe("the withdrawal guard", () => {
  it("reports what it checked instead of claiming a check it could not make", async () => {
    // Spot Testnet has no apiRestrictions endpoint. The guard must not report PASS on
    // the strength of a call that failed.
    const result = await guard("withdrawalPermission", {
      config: config(),
      client: client(),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("not verified");
  });

  it("fails when the exchange says withdrawals are enabled", async () => {
    // Only reachable on production: testnet has no such endpoint, and the guard says so
    // rather than pretending to have checked.
    const result = await guard("withdrawalPermission", {
      config: config(
        {
          env: "prod",
          baseUrl: "https://api.binance.com",
          streamUrl: "wss://stream.binance.com:9443/ws",
        },
        true,
      ),
      client: client({ restrictions: { enableWithdrawals: true } }),
      mandate,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
  });
});

describe("the mandate guard", () => {
  it("fails when no mandate was loaded", async () => {
    const result = await guard("mandate", {
      config: config(),
      client: client(),
      mandate: undefined,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
  });

  it("fails on an expired mandate", async () => {
    const expired = unwrap(
      compileMandate({ ...SPEC, expiresAt: "2020-01-01T00:00:00.000Z" }),
      "expired mandate",
    );
    const result = await guard("mandate", {
      config: config(),
      client: client(),
      mandate: expired,
      nowMs: NOW,
    });
    expect(result.status).toBe("FAIL");
  });
});
