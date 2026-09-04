/**
 * Which Binance hosts count as testnet, and which as production.
 *
 * This is the control that stands between a configuration typo and real money, so it
 * lives in one small file that can be read in full during review.
 *
 * The rule is an **allowlist of hostnames**, never a substring test. A check like
 * `baseUrl.includes("testnet")` is satisfied by `https://api.binance.com/?x=testnet`
 * and by `https://testnet.evil.com`, which means the only thing standing between a
 * mandate marked `testnet` and a live account would be a typo in a query string.
 *
 * A host that is not on either list is not guessed at. It is rejected, because the one
 * thing worse than refusing to start is starting against an exchange nobody identified.
 */

/** Spot REST hosts. */
const TESTNET_REST_HOSTS = new Set(["testnet.binance.vision"]);

const PROD_REST_HOSTS = new Set([
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com",
  "api3.binance.com",
  "api4.binance.com",
  "api-gcp.binance.com",
]);

/** User data stream hosts. */
const TESTNET_STREAM_HOSTS = new Set(["stream.testnet.binance.vision", "testnet.binance.vision"]);

const PROD_STREAM_HOSTS = new Set([
  "stream.binance.com",
  "stream-cloud.binance.com",
  "data-stream.binance.vision",
]);

export type ExchangeEnv = "testnet" | "prod";

export type HostClassification =
  | { readonly ok: true; readonly env: ExchangeEnv; readonly hostname: string }
  | { readonly ok: false; readonly reason: string };

interface HostRules {
  readonly testnet: ReadonlySet<string>;
  readonly prod: ReadonlySet<string>;
  readonly schemes: readonly string[];
  readonly label: string;
}

const REST: HostRules = {
  testnet: TESTNET_REST_HOSTS,
  prod: PROD_REST_HOSTS,
  schemes: ["https:"],
  label: "REST base URL",
};

const STREAM: HostRules = {
  testnet: TESTNET_STREAM_HOSTS,
  prod: PROD_STREAM_HOSTS,
  schemes: ["wss:"],
  label: "stream base URL",
};

function classify(raw: string, rules: HostRules): HostClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${rules.label} is not a valid URL: ${raw}` };
  }

  // Plaintext would put a signed request, and the API key header, on the wire.
  if (!rules.schemes.includes(url.protocol)) {
    return {
      ok: false,
      reason: `${rules.label} must use ${rules.schemes.join(" or ")}, got ${url.protocol}`,
    };
  }

  // Credentials in a URL are never legitimate here and are a classic way to make a
  // hostile host look like a familiar one in a log line.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `${rules.label} must not contain credentials` };
  }

  const hostname = url.hostname.toLowerCase();
  if (rules.testnet.has(hostname)) return { ok: true, env: "testnet", hostname };
  if (rules.prod.has(hostname)) return { ok: true, env: "prod", hostname };

  return {
    ok: false,
    reason: `${rules.label} host ${hostname} is not a recognised Binance host`,
  };
}

/** Classify a Spot REST base URL as testnet, production, or unrecognised. */
export function classifyRestHost(baseUrl: string): HostClassification {
  return classify(baseUrl, REST);
}

/** Classify a user-data-stream base URL as testnet, production, or unrecognised. */
export function classifyStreamHost(streamUrl: string): HostClassification {
  return classify(streamUrl, STREAM);
}

/** Every recognised host, for error messages that tell an operator what is allowed. */
export function knownHosts(env: ExchangeEnv): { rest: string[]; stream: string[] } {
  return {
    rest: [...(env === "testnet" ? TESTNET_REST_HOSTS : PROD_REST_HOSTS)].sort(),
    stream: [...(env === "testnet" ? TESTNET_STREAM_HOSTS : PROD_STREAM_HOSTS)].sort(),
  };
}
