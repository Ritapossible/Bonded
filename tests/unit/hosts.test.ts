import { describe, expect, it } from "vitest";
import { classifyRestHost, classifyStreamHost, knownHosts } from "../../src/config/hosts.js";

describe("classifyRestHost", () => {
  it("recognises the Spot testnet host", () => {
    const result = classifyRestHost("https://testnet.binance.vision");
    expect(result).toEqual({ ok: true, env: "testnet", hostname: "testnet.binance.vision" });
  });

  it("recognises production hosts", () => {
    for (const host of knownHosts("prod").rest) {
      const result = classifyRestHost(`https://${host}`);
      expect(result.ok && result.env).toBe("prod");
    }
  });

  // The bug this file exists for: a substring check on the whole URL passed all of these.
  it.each([
    "https://api.binance.com/?x=testnet",
    "https://api.binance.com/testnet",
    "https://api.binance.com#testnet",
    "https://testnet.evil.com",
    "https://api.binance.com.testnet.evil.com",
    "https://testnet.binance.vision.evil.com",
  ])("does not accept %s as testnet", (url) => {
    const result = classifyRestHost(url);
    const isTestnet = result.ok && result.env === "testnet";
    expect(isTestnet).toBe(false);
  });

  it("classifies a production URL carrying the word testnet as production", () => {
    const result = classifyRestHost("https://api.binance.com/?x=testnet");
    expect(result).toEqual({ ok: true, env: "prod", hostname: "api.binance.com" });
  });

  it("rejects plaintext http, which would put a signed request on the wire", () => {
    const result = classifyRestHost("http://testnet.binance.vision");
    expect(result.ok).toBe(false);
  });

  it("rejects credentials embedded in the URL", () => {
    const result = classifyRestHost("https://user:pass@testnet.binance.vision");
    expect(result).toEqual({
      ok: false,
      reason: "REST base URL must not contain credentials",
    });
  });

  it("rejects an unparseable URL rather than guessing", () => {
    expect(classifyRestHost("not a url").ok).toBe(false);
  });

  it("is case-insensitive on the hostname", () => {
    const result = classifyRestHost("https://TESTNET.BINANCE.VISION");
    expect(result.ok && result.env).toBe("testnet");
  });

  it("ignores port, path and query when identifying the host", () => {
    const result = classifyRestHost("https://testnet.binance.vision:443/api/v3?a=1");
    expect(result.ok && result.hostname).toBe("testnet.binance.vision");
  });
});

describe("classifyStreamHost", () => {
  it("recognises the testnet stream host", () => {
    const result = classifyStreamHost("wss://stream.testnet.binance.vision/ws");
    expect(result.ok && result.env).toBe("testnet");
  });

  it("recognises the production stream host", () => {
    const result = classifyStreamHost("wss://stream.binance.com:9443/ws");
    expect(result.ok && result.env).toBe("prod");
  });

  it("rejects https for a stream URL", () => {
    expect(classifyStreamHost("https://stream.testnet.binance.vision").ok).toBe(false);
  });

  it("rejects an unknown stream host", () => {
    expect(classifyStreamHost("wss://stream.evil.com/ws").ok).toBe(false);
  });
});
