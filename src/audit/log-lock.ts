/**
 * One writer per decision log.
 *
 * The log is an append-only hash chain: each record carries the hash of the one before
 * it. Two processes appending to the same file interleave their chains — each computes
 * `prevHash` from the record *it* last wrote, not the one actually last on disk — and
 * the result is a log that fails verification at the next startup. BONDED then refuses
 * to boot, correctly, on a trail it corrupted itself.
 *
 * That is not hypothetical. The documented demo setup ran `npm start` and *also*
 * registered the MCP server with an agent, and the agent launches its own BONDED from
 * the same working directory — two instances, one `./data/decisions.jsonl`, no lock.
 *
 * `open(path, "a")` does not prevent this on any platform. So a lock file does, taken
 * with `wx` (create-exclusive) which is atomic on POSIX and Windows alike.
 *
 * **Stale locks are recovered, not worked around.** A process killed with SIGKILL leaves
 * its lock behind, and an operator who cannot start after a crash will delete the lock
 * — or the log — to get moving. So the lock records its pid, and a lock whose process is
 * gone is taken over. A lock whose process is *alive* is refused, with both pids named.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

export interface LockContents {
  readonly pid: number;
  readonly acquiredAt: string;
}

export function lockPathFor(logPath: string): string {
  return `${logPath}.lock`;
}

/** Whether a process exists. Signal 0 checks liveness without delivering anything. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    // EPERM means it exists but belongs to another user — alive for our purposes.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockContents | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== "number") return undefined;
    const acquiredAt = (parsed as { acquiredAt?: unknown }).acquiredAt;
    return { pid, acquiredAt: typeof acquiredAt === "string" ? acquiredAt : "unknown" };
  } catch {
    // Unreadable or malformed: treat as stale rather than blocking startup forever on a
    // file nobody can interpret.
    return undefined;
  }
}

/**
 * Take the writer lock for a decision log.
 *
 * Returns a release function on success. Never throws.
 */
export async function acquireLogLock(
  logPath: string,
  pid = process.pid,
): Promise<Result<() => Promise<void>, BondedError>> {
  const path = lockPathFor(logPath);

  const write = async (): Promise<void> => {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(
        JSON.stringify({ pid, acquiredAt: new Date().toISOString() } satisfies LockContents),
        "utf8",
      );
    } finally {
      await handle.close();
    }
  };

  const release = async (): Promise<void> => {
    // Only remove a lock still held by this process, so releasing after a takeover
    // cannot delete the new holder's lock.
    const current = await readLock(path);
    if (current?.pid !== pid) return;
    await unlink(path).catch(() => undefined);
  };

  try {
    await write();
    return ok(release);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
      return err(
        bondedError(ErrorCode.DECISION_LOG_IO, "could not take the decision log lock", {
          path,
        }),
      );
    }
  }

  const holder = await readLock(path);
  if (holder !== undefined && processAlive(holder.pid)) {
    return err(
      bondedError(
        ErrorCode.DECISION_LOG_IO,
        "another BONDED is already writing this decision log",
        {
          path: logPath,
          heldByPid: holder.pid,
          heldSince: holder.acquiredAt,
          thisPid: pid,
          hint:
            "Two instances appending to one hash-chained log corrupt it. Stop the other " +
            "instance, or give this one its own BONDED_DECISION_LOG_PATH.",
        },
      ),
    );
  }

  // Stale: the holder is gone. Take it over.
  await unlink(path).catch(() => undefined);
  try {
    await write();
    return ok(release);
  } catch {
    return err(
      bondedError(
        ErrorCode.DECISION_LOG_IO,
        "could not take the decision log lock after clearing a stale one",
        {
          path,
        },
      ),
    );
  }
}
