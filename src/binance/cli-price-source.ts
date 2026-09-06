/**
 * Reference prices via `binance-cli`, Binance's own Agent OS tooling.
 *
 * BONDED signs its own order requests, and that is deliberate: the gate has to control
 * the exact query string it signs and stamp a `newClientOrderId` on every order, so a
 * process boundary in the signing path would buy nothing and cost the guarantee. That
 * reasoning is about the *write* path. It says nothing about reads.
 *
 * Reference prices are a read. `binance-cli spot ticker-price` is the official Agent OS
 * command for exactly this call, it supports Spot Testnet, it needs no OAuth, and it
 * reads the same environment variables BONDED already takes — `BINANCE_API_KEY`,
 * `BINANCE_SECRET_KEY`, `BINANCE_API_ENV`, `BINANCE_SPOT_BASE_PATH`. So this source
 * drops in with no new configuration and no new credential.
 *
 * The other Agent OS surface, the hosted MCP server at `agent.binance.com/mcp/agentic`,
 * is not usable from here and the reason is worth recording so nobody spends a day on
 * it: it answers `401` to an unauthenticated `initialize`, so the "market data needs no
 * auth" scope still sits behind an interactive OAuth consent, and it has no testnet. An
 * unattended server cannot complete a browser consent flow.
 *
 * **Off by default** (`BONDED_PRICE_SOURCE=binance-cli` opts in). A source that shells
 * out has failure modes a direct fetch does not — a missing binary, a slow spawn — and
 * the default path should be the one with the fewest moving parts.
 *
 * **Fails closed.** Every failure returns an error rather than a stale or absent price.
 * The gate denies on a missing reference price (`referencePrice`), so an unavailable
 * source refuses orders instead of sizing them against a guess.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

/** What the state provider needs from a price source. `BinanceClient` already fits. */
export interface PriceSource {
  /** Named so a boot banner can say which source is live. */
  readonly name: string;
  tickerPrice(symbols: readonly string[]): Promise<Result<unknown, BondedError>>;
}

/**
 * Binance symbols are upper-case alphanumerics.
 *
 * Enforced before the value reaches argv, so nothing that could be read as a flag —
 * `--profile`, say — can arrive through a symbol. Symbols come from the mandate, which
 * is the operator's own file, so this is defence in depth rather than a live hole; it
 * costs one regex and removes the need to reason about the argument parser at all.
 */
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

const DEFAULT_TIMEOUT_MS = 10_000;
/** A ticker list for the mandate's symbols is small; this is a runaway guard. */
const MAX_OUTPUT_BYTES = 1_000_000;

export interface CliPriceSourceOptions {
  readonly timeoutMs?: number;
  /** Overridable for tests, which point it at a stub that speaks the same protocol. */
  readonly command?: string;
}

/** Resolve the binary that ships in this package rather than trusting PATH. */
export function resolveBinanceCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // The package's own entry point, run with the current node. Using the shipped
    // module rather than a `binance-cli` on PATH means the version is the one this
    // project declares, not whatever happens to be installed globally.
    return require.resolve("@binance/binance-cli/dist/index.mjs");
  } catch {
    return undefined;
  }
}

export class BinanceCliPriceSource implements PriceSource {
  readonly name = "binance-cli";
  readonly #timeoutMs: number;
  readonly #command: string | undefined;

  constructor(options: CliPriceSourceOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#command = options.command ?? resolveBinanceCli();
  }

  async tickerPrice(symbols: readonly string[]): Promise<Result<unknown, BondedError>> {
    if (symbols.length === 0) return ok([]);

    for (const symbol of symbols) {
      if (!SYMBOL_PATTERN.test(symbol)) {
        return err(
          bondedError(
            ErrorCode.EXCHANGE_MALFORMED_RESPONSE,
            "symbol is not a valid Binance symbol",
            {
              symbol,
            },
          ),
        );
      }
    }

    const entry = this.#command;
    if (entry === undefined) {
      return err(
        bondedError(
          ErrorCode.EXCHANGE_UNREACHABLE,
          "binance-cli is not installed; run npm install, or unset BONDED_PRICE_SOURCE to use REST",
          {},
        ),
      );
    }

    // `--symbols` takes a list even for one symbol, so there is one code path rather
    // than two. execFile, never exec: no shell means no quoting to get wrong.
    const args = [entry, "spot", "ticker-price", "--symbols", ...symbols];

    const run = await this.#exec(args);
    if (!run.ok) return run;

    try {
      return ok(JSON.parse(run.value));
    } catch (cause: unknown) {
      // The CLI prints plain text for some failures — a geo-block, for one — so
      // unparseable output is a failed call, not a malformed price.
      return err(
        bondedError(
          ErrorCode.EXCHANGE_MALFORMED_RESPONSE,
          "binance-cli did not return JSON",
          { output: run.value.slice(0, 400) },
          cause,
        ),
      );
    }
  }

  #exec(args: readonly string[]): Promise<Result<string, BondedError>> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [...args],
        { timeout: this.#timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            // Deliberately not `error.message`: Node prefixes it with
            // "Command failed: <the entire command line>", which would put argv into a
            // details blob that gets logged. It is clean today, but a details field
            // that can carry arguments is one refactor away from carrying a secret.
            // The exit code and signal say everything a reader needs.
            const failure = error as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: NodeJS.Signals | null;
            };
            resolve(
              err(
                bondedError(
                  ErrorCode.EXCHANGE_UNREACHABLE,
                  failure.killed === true ? "binance-cli timed out" : "binance-cli failed",
                  {
                    exitCode: failure.code ?? null,
                    signal: failure.signal ?? null,
                    stderr: stderr.slice(0, 400),
                  },
                ),
              ),
            );
            return;
          }
          resolve(ok(stdout));
        },
      );
    });
  }
}
