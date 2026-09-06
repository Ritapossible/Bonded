/**
 * One writer per decision log.
 *
 * The documented demo setup ran `npm start` and also registered the MCP server with an
 * agent — and the agent launches its own BONDED from the same directory. Two instances,
 * one `./data/decisions.jsonl`, `open(path, "a")` on both, no lock. Each computes
 * `prevHash` from the record it last wrote rather than the one actually last on disk, so
 * the chain interleaves and fails verification at the next boot. BONDED then refuses to
 * start on a trail it corrupted itself, and the operator's obvious move — delete the log
 * — destroys the evidence.
 *
 * A second writer must be refused at open, before a single record is appended.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLogLock, lockPathFor } from "../../src/audit/log-lock.js";
import { DecisionLog } from "../../src/audit/decision-log.js";
import { ok, unwrap } from "../../src/core/result.js";
import { decimalUnsafe } from "../../src/core/money.js";
import type { OrderIntent } from "../../src/domain/intent.js";

const INTENT: OrderIntent = {
  kind: "LIMIT",
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: decimalUnsafe("0.1"),
  price: decimalUnsafe("2000"),
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bonded-lock-"));
  path = join(dir, "decisions.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a second writer", () => {
  it("is refused, naming both processes", async () => {
    const first = unwrap(await acquireLogLock(path), "first");

    const second = await acquireLogLock(path);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain("already writing");
    expect(second.error.details["heldByPid"]).toBe(process.pid);

    await first();
  });

  it("cannot open the log at all while another holds it", async () => {
    // The check belongs at open, not at the first append: an instance that starts and
    // then refuses every write is worse than one that refuses to start.
    const release = unwrap(await acquireLogLock(path), "held");

    const log = await DecisionLog.open(path);
    expect(log.ok).toBe(false);

    await release();
  });

  it("succeeds once the first writer releases", async () => {
    const release = unwrap(await acquireLogLock(path), "first");
    await release();

    const log = unwrap(await DecisionLog.open(path), "second");
    await log.close();
  });
});

describe("a lock left behind by a dead process", () => {
  it("is taken over rather than blocking startup forever", async () => {
    // SIGKILL leaves the lock behind. An operator who cannot start after a crash will
    // delete something to get moving, and the log is the thing they must not delete.
    await writeFile(
      lockPathFor(path),
      JSON.stringify({ pid: 0x7ffffffe, acquiredAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );

    const log = await DecisionLog.open(path);
    expect(log.ok).toBe(true);
    if (log.ok) await log.value.close();
  });

  it("is taken over when the lock file is unreadable", async () => {
    await writeFile(lockPathFor(path), "{ not json", "utf8");
    const release = await acquireLogLock(path);
    expect(release.ok).toBe(true);
    if (release.ok) await release.value();
  });
});

describe("releasing", () => {
  it("removes the lock so the next run starts clean", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    await log.appendWith(() =>
      ok({
        ts: "2026-09-06T12:00:00.000Z",
        mandateHash: "b3f1".repeat(16),
        intent: INTENT,
        outcome: "DENY" as const,
        denial: { clause: "expiry" as const, clauseText: "expired", observed: "x" },
      }),
    );
    await log.close();

    await expect(readFile(lockPathFor(path), "utf8")).rejects.toThrow();
    // And the log itself survives, with its record.
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not delete a lock another process has since taken", async () => {
    const release = unwrap(await acquireLogLock(path, 111), "ours");
    await writeFile(
      lockPathFor(path),
      JSON.stringify({ pid: 222, acquiredAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );

    await release();

    const still: unknown = JSON.parse(await readFile(lockPathFor(path), "utf8"));
    expect((still as { pid: number }).pid).toBe(222);
  });
});
