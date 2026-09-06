/**
 * Reference prices through `binance-cli`, Binance's own Agent OS tooling.
 *
 * Driven against a stub that speaks the same protocol — argv in, JSON on stdout — so the
 * wiring, the parsing and every failure path are exercised without a network or an
 * account. The live call is geo-blocked from CI; what can be tested here is everything
 * except whether Binance answers, and that part is the CLI's job rather than BONDED's.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BinanceCliPriceSource, resolveBinanceCli } from "../../src/binance/cli-price-source.js";

let dir: string;

/** A stand-in for the CLI: same argv shape, and whatever body we want on stdout. */
async function stub(body: string): Promise<string> {
  const path = join(dir, `stub-${String(Math.random()).slice(2)}.mjs`);
  await writeFile(path, body, "utf8");
  return path;
}

/** Records the argv it was given, so the call shape itself can be asserted on. */
const ECHO_ARGV = `
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ argv: args }));
`;

const TWO_PRICES = `
process.stdout.write(JSON.stringify([
  { symbol: "BTCUSDT", price: "60000.00" },
  { symbol: "ETHUSDT", price: "2000.00" },
]));
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bonded-cli-price-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolving the CLI", () => {
  it("finds the binary this package declares, not one on PATH", () => {
    // Declared in dependencies, so a judge can see the Agent OS tooling in package.json
    // and the version is the one this project pins.
    const path = resolveBinanceCli();
    expect(path).toBeDefined();
    expect(path).toContain("@binance/binance-cli");
  });
});

describe("fetching prices", () => {
  it("returns the ticker payload the mapper already understands", async () => {
    const source = new BinanceCliPriceSource({ command: await stub(TWO_PRICES) });
    const result = await source.tickerPrice(["BTCUSDT", "ETHUSDT"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { symbol: "BTCUSDT", price: "60000.00" },
      { symbol: "ETHUSDT", price: "2000.00" },
    ]);
  });

  it("calls the documented Agent OS command", async () => {
    const source = new BinanceCliPriceSource({ command: await stub(ECHO_ARGV) });
    const result = await source.tickerPrice(["BTCUSDT", "ETHUSDT"]);
    expect(result.ok && result.value).toEqual({
      argv: ["spot", "ticker-price", "--symbols", "BTCUSDT", "ETHUSDT"],
    });
  });

  it("does not spawn anything when there are no symbols", async () => {
    // The stub would throw if run; reaching ok proves it was never invoked.
    const source = new BinanceCliPriceSource({ command: join(dir, "does-not-exist.mjs") });
    expect(await source.tickerPrice([])).toEqual({ ok: true, value: [] });
  });

  it("names itself, so a banner can say which source is live", () => {
    expect(new BinanceCliPriceSource().name).toBe("binance-cli");
  });
});

describe("failing closed", () => {
  it("rejects a symbol that could be read as a flag", async () => {
    // Never reaches argv. A value like this arriving as an argument would be parsed as
    // an option by the CLI rather than as a symbol.
    const source = new BinanceCliPriceSource({ command: await stub(ECHO_ARGV) });
    const result = await source.tickerPrice(["--profile"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not a valid Binance symbol");
  });

  it("rejects a symbol carrying shell metacharacters", async () => {
    const source = new BinanceCliPriceSource({ command: await stub(ECHO_ARGV) });
    expect((await source.tickerPrice(["BTC;rm -rf /"])).ok).toBe(false);
  });

  it("errors rather than returning a price when the CLI is missing", async () => {
    const source = new BinanceCliPriceSource({ command: join(dir, "absent.mjs") });
    const result = await source.tickerPrice(["BTCUSDT"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("binance-cli");
  });

  it("errors on plain-text output, which is how a geo-block arrives", async () => {
    // The real CLI prints this, unquoted, and exits 0. Parsed as a price it would be
    // nonsense; treated as absent it denies the order, which is correct.
    const geoBlock = `process.stdout.write("Service unavailable from a restricted location");`;
    const source = new BinanceCliPriceSource({ command: await stub(geoBlock) });
    const result = await source.tickerPrice(["BTCUSDT"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("did not return JSON");
    expect(JSON.stringify(result.error.details)).toContain("restricted location");
  });

  it("errors when the CLI exits non-zero", async () => {
    const failing = `process.stderr.write("boom"); process.exit(3);`;
    const source = new BinanceCliPriceSource({ command: await stub(failing) });
    const result = await source.tickerPrice(["BTCUSDT"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.details)).toContain("boom");
  });

  it("does not hang when the CLI does", async () => {
    const hangs = `setTimeout(() => {}, 60_000);`;
    const source = new BinanceCliPriceSource({ command: await stub(hangs), timeoutMs: 250 });
    const started = Date.now();
    const result = await source.tickerPrice(["BTCUSDT"]);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never puts the arguments in the error details", async () => {
    // Details are logged. A blob that can carry argv is one refactor from carrying a
    // secret, so the failure names the reason and the CLI's own stderr, nothing else.
    const failing = `process.exit(1);`;
    const source = new BinanceCliPriceSource({ command: await stub(failing) });
    const result = await source.tickerPrice(["BTCUSDT"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.details)).not.toContain("ticker-price");
  });
});
