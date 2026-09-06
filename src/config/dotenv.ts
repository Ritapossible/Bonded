/**
 * Load `.env`, because the documented setup says to write one.
 *
 * `.env.example` tells an operator to `cp .env.example .env` and fill in their keys, and
 * nothing read the file. Following the instructions exactly produced
 * `configuration error: BINANCE_API_KEY Required` — the setup path in the README, in
 * SKILL.md and on the docs site was broken end to end.
 *
 * Two rules govern this, and both matter more than the convenience:
 *
 * 1. **The real environment always wins.** A value already in `process.env` is never
 *    overwritten by the file. Otherwise a stale `.env` left in a directory could
 *    silently redirect a deliberately-set `BINANCE_API_ENV=prod` — a config file
 *    quietly overriding an explicit choice is how the wrong account gets traded.
 * 2. **Look beside the installation, not only in the working directory.** An MCP server
 *    is launched by the agent, often from a GUI with no shell and an arbitrary cwd. A
 *    loader that only checks `process.cwd()` works from a terminal and fails from
 *    Claude Desktop, which is the harder failure to diagnose.
 *
 * Deliberately not a dependency. Node 22 could do this with `--env-file`, but that is a
 * flag on the command line an agent writes for us, and the parsing below is small enough
 * to own.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DotenvResult {
  /** The file that was read, if one was found. */
  readonly path: string | undefined;
  /** Names set from the file. Values are never reported — they are secrets. */
  readonly applied: readonly string[];
  /** Names present in the file but already set in the environment, so left alone. */
  readonly skipped: readonly string[];
}

/**
 * Parse `.env` text.
 *
 * A deliberately small subset: `KEY=value`, `#` comments, blank lines, optional
 * `export ` prefix, and matching single or double quotes stripped from the value. No
 * interpolation, no multi-line values — a config format with an expression language is
 * a config format that can surprise you.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) continue;

    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(equals + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at an inline comment.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out.set(key, value);
  }

  return out;
}

/** Where to look, in order. The first file that exists wins. */
export function dotenvCandidates(cwd = process.cwd()): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/config/ or dist/config/ — the package root is two levels up either way.
  const packageRoot = resolve(here, "..", "..");
  const candidates = [join(cwd, ".env"), join(packageRoot, ".env")];
  return [...new Set(candidates)];
}

/**
 * Apply the first `.env` found to `process.env`, without overwriting anything already set.
 *
 * Never throws: a missing or unreadable file is the normal case for an operator who
 * exports their variables instead, and a startup that dies on the absence of an optional
 * file would be worse than the problem it solves.
 */
export function loadDotenv(cwd = process.cwd()): DotenvResult {
  for (const path of dotenvCandidates(cwd)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of parseDotenv(text)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied.push(key);
      } else {
        skipped.push(key);
      }
    }
    return { path, applied, skipped };
  }

  return { path: undefined, applied: [], skipped: [] };
}
