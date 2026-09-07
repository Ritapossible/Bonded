/**
 * A setting that is set but never read.
 *
 * From a live debugging cycle the night before a deadline: `BONDED_LOOCKBACK_MS=60000`
 * sat in an operator's `.env`. BONDED read no such variable, applied the twenty-four
 * hour default, and replayed a day of account history against an empty decision log —
 * which burned the bond at startup, every time, for hours.
 *
 * Nothing in the output was wrong, and that was the problem. The config line reported
 * the lookback BONDED was actually using; it had no way to report the one the operator
 * thought they had set. A guard that silently discards its own configuration is not a
 * guard, so an unread `BONDED_*` name is now named out loud.
 */

import { describe, expect, it } from "vitest";
import { formatUnrecognisedSetting, unrecognisedSettings } from "../../src/config/env.js";

describe("settings that are set but not read", () => {
  it("names a misspelled setting and suggests the real one", () => {
    // The exact variable, from the exact `.env`.
    const found = unrecognisedSettings({ BONDED_LOOCKBACK_MS: "60000" });

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("BONDED_LOOCKBACK_MS");
    expect(found[0]?.suggestion).toBe("BONDED_LOOKBACK_MS");
    expect(formatUnrecognisedSetting(found[0]!, 18)).toContain("Did you mean BONDED_LOOKBACK_MS?");
  });

  it("says nothing about settings it does read", () => {
    const found = unrecognisedSettings({
      BONDED_LOOKBACK_MS: "60000",
      BONDED_POLL_INTERVAL_MS: "5000",
      BONDED_ALLOW_PARTIAL_AUDIT: "1",
      BONDED_WATCH_SYMBOLS: "BTCUSDT",
    });

    expect(found).toEqual([]);
  });

  it("leaves the BINANCE_ namespace alone, because it is not ours", () => {
    // The exchange's own CLI and SDKs set variables we have never heard of and are
    // right to. Warning about those would train the operator to ignore the warning.
    const found = unrecognisedSettings({
      BINANCE_API_KEY: "x".repeat(64),
      BINANCE_SOMETHING_ELSE: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });

    expect(found).toEqual([]);
  });

  it("offers no guess when nothing is close, rather than a misleading one", () => {
    const found = unrecognisedSettings({ BONDED_COMPLETELY_MADE_UP_THING: "1" });

    expect(found).toHaveLength(1);
    expect(found[0]?.suggestion).toBeUndefined();
    expect(formatUnrecognisedSetting(found[0]!, 18)).not.toContain("Did you mean");
  });

  it("reports every offender, in a stable order", () => {
    const found = unrecognisedSettings({
      BONDED_ZZZ: "1",
      BONDED_AAA: "1",
      BONDED_LOG_LEVEL: "debug",
    });

    expect(found.map((s) => s.name)).toEqual(["BONDED_AAA", "BONDED_ZZZ"]);
  });
});
