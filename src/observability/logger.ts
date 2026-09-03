/**
 * Structured logging.
 *
 * **Everything goes to stderr, never stdout.** BONDED speaks MCP over stdio, where
 * stdout carries JSON-RPC frames. A single log line written to stdout corrupts the
 * transport and the agent's connection dies with a parse error that points nowhere
 * near the real cause. This is the most expensive mistake available in this codebase,
 * so the destination is fixed here and `no-console` is an error in the lint config.
 *
 * Redaction is belt and braces: credentials are already wrapped in `Secret` (see
 * `config/env.ts`), and the paths below catch anything that slips past that.
 */

import pino from "pino";
import type { Logger as PinoLogger } from "pino";

export type Logger = PinoLogger;

const REDACTED_PATHS = [
  "apiKey",
  "secretKey",
  "hmacSecret",
  "signature",
  "*.apiKey",
  "*.secretKey",
  "*.hmacSecret",
  "*.signature",
  "req.headers.authorization",
];

export interface LoggerOptions {
  readonly level: "debug" | "info" | "warn" | "error";
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: "bonded" },
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
      formatters: {
        // Emit the level as a word rather than a number: during a build these logs are
        // read by a person in a terminal far more often than by a collector.
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // fd 2 — stderr. See the note at the top of this file.
    // `sync` so that a log line written just before a crash is not lost in a buffer.
    pino.destination({ dest: 2, sync: true }),
  );
}

/** Logger that discards everything, for tests. */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
