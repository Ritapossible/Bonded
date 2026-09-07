/**
 * Which build is actually running.
 *
 * `dist/` is gitignored and `npm start` runs `dist/cli.js`, so `git pull` alone changes
 * nothing about the code that boots. An operator who pulls a fix and skips the build
 * gets byte-identical behaviour and byte-identical output — including the banner that
 * is supposed to tell them what is happening. That failure mode cost a debugging cycle
 * on a live instance, where a fix was pulled, not built, and read as not working.
 *
 * For a tool whose whole claim is that it can tell you what your account is doing,
 * "you cannot tell which version is guarding you" is not a small gap. So the boot
 * banner now says which build it is, and says so loudly when the compiled output is
 * older than the sources next to it.
 *
 * Staleness is reported, never fatal. The check is an mtime heuristic — a fresh clone,
 * a packed install with no `src/`, or a checkout whose timestamps were rewritten are all
 * legitimate — and refusing to boot on a heuristic would be a worse failure than the one
 * it prevents.
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentity {
  readonly version: string;
  /** Newest mtime among the compiled files actually being run. */
  readonly builtAtMs: number | undefined;
  /** Newest mtime among the sources those files were compiled from, when present. */
  readonly sourceAtMs: number | undefined;
  /** Whether the sources have changed since the compiled output was written. */
  readonly stale: boolean;
}

/**
 * Newest modification time under a directory tree, or undefined if it is not readable.
 *
 * Errors are swallowed on purpose: this is diagnostic colour on the banner, and a
 * permissions quirk in a build directory must not stop a trading gate from starting.
 */
async function newestMtimeMs(dir: string, extension: string): Promise<number | undefined> {
  let newest: number | undefined;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtimeMs(path, extension);
      if (nested !== undefined && (newest === undefined || nested > newest)) newest = nested;
      continue;
    }
    if (!entry.name.endsWith(extension)) continue;
    try {
      const info = await stat(path);
      if (newest === undefined || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      continue;
    }
  }
  return newest;
}

/**
 * Identify the running build from the entry module's own location.
 *
 * Derived from `import.meta.url` rather than from `process.cwd()`, so it describes the
 * code that is executing and not the directory someone happened to launch it from.
 */
export async function readBuildIdentity(options: {
  readonly version: string;
  readonly entryUrl: string;
}): Promise<BuildIdentity> {
  const entryDir = dirname(fileURLToPath(options.entryUrl));
  const builtAtMs = await newestMtimeMs(entryDir, ".js");
  const sourceAtMs = await newestMtimeMs(resolve(entryDir, "..", "src"), ".ts");
  return {
    version: options.version,
    builtAtMs,
    sourceAtMs,
    stale: builtAtMs !== undefined && sourceAtMs !== undefined && sourceAtMs > builtAtMs,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One banner line, in the same shape as the boot guards above it. */
export function formatBuildIdentity(identity: BuildIdentity, width: number): string {
  const name = "build".padEnd(width);
  if (identity.stale && identity.builtAtMs !== undefined && identity.sourceAtMs !== undefined) {
    return (
      `  [WARN] ${name}  ${identity.version}, built ${iso(identity.builtAtMs)} — ` +
      `sources changed ${iso(identity.sourceAtMs)}. You are running older code than you have ` +
      `checked out; run \`npm run build\`.`
    );
  }
  if (identity.builtAtMs === undefined) {
    return `  [WARN] ${name}  ${identity.version}, build time unknown`;
  }
  return `  [PASS] ${name}  ${identity.version}, built ${iso(identity.builtAtMs)}`;
}
