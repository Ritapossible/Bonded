/**
 * The banner must say which build is running.
 *
 * From a live debugging cycle: a fix was pushed, pulled, and reported as not working.
 * `dist/` is gitignored and `npm start` runs `dist/cli.js`, so the pull had changed
 * nothing that executes — but nothing in the output could distinguish that from a fix
 * that genuinely failed. Two people then reasoned about the wrong binary.
 */

import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { formatBuildIdentity, readBuildIdentity } from "../../src/boot/build-identity.js";

/** A checkout with a `dist/` and a `src/` whose mtimes the test sets by hand. */
async function checkout(builtAtMs: number, sourceAtMs: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bonded-build-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "src", "nested"), { recursive: true });

  const emitted = join(root, "dist", "cli.js");
  await writeFile(emitted, "// compiled\n");
  await utimes(emitted, new Date(builtAtMs), new Date(builtAtMs));

  // Nested, to prove the walk is recursive: the file that changed is rarely the one at
  // the top of the tree.
  const source = join(root, "src", "nested", "order-source.ts");
  await writeFile(source, "// source\n");
  await utimes(source, new Date(sourceAtMs), new Date(sourceAtMs));

  return root;
}

function entryUrl(root: string): string {
  return pathToFileURL(join(root, "dist", "cli.js")).href;
}

describe("identifying the running build", () => {
  it("reports the compiled output as current when it is newer than the sources", async () => {
    const root = await checkout(2_000_000_000_000, 1_999_999_000_000);
    const identity = await readBuildIdentity({ version: "0.1.0", entryUrl: entryUrl(root) });

    expect(identity.stale).toBe(false);
    expect(identity.builtAtMs).toBe(2_000_000_000_000);
    expect(formatBuildIdentity(identity, 10)).toContain("[PASS]");
  });

  it("calls out a build older than the sources next to it", async () => {
    // The exact case: sources pulled, build skipped.
    const root = await checkout(1_999_999_000_000, 2_000_000_000_000);
    const identity = await readBuildIdentity({ version: "0.1.0", entryUrl: entryUrl(root) });

    expect(identity.stale).toBe(true);
    const line = formatBuildIdentity(identity, 10);
    expect(line).toContain("[WARN]");
    expect(line).toContain("npm run build");
  });

  it("does not claim staleness when there are no sources to compare against", async () => {
    // A packed install ships `dist/` without `src/`. Absence of evidence is not a
    // stale build, and saying otherwise would make the warning worthless.
    const root = await mkdtemp(join(tmpdir(), "bonded-build-"));
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "cli.js"), "// compiled\n");

    const identity = await readBuildIdentity({ version: "0.1.0", entryUrl: entryUrl(root) });

    expect(identity.sourceAtMs).toBeUndefined();
    expect(identity.stale).toBe(false);
    expect(formatBuildIdentity(identity, 10)).toContain("[PASS]");
  });

  it("never throws on an unreadable tree, because this must not stop a boot", async () => {
    const missing = pathToFileURL(join(tmpdir(), "bonded-nowhere", "dist", "cli.js")).href;
    const identity = await readBuildIdentity({ version: "0.1.0", entryUrl: missing });

    expect(identity.builtAtMs).toBeUndefined();
    expect(identity.stale).toBe(false);
    expect(formatBuildIdentity(identity, 10)).toContain("build time unknown");
  });
});
