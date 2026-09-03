/**
 * The append-only, hash-chained decision log.
 *
 * This file is the authoritative record of what BONDED authorised. Reconciliation
 * compares it against the exchange's own order history, so its integrity is the
 * foundation the bypass claim rests on: if BONDED could quietly edit its own history,
 * "this order was never authorised" would be an assertion rather than a finding.
 *
 * Design notes:
 *
 * - **Chained.** Each record carries the SHA-256 of the previous record's canonical
 *   line. Altering or removing any record breaks every link after it. This does not
 *   stop an operator rewriting the whole file — that needs an external anchor — but it
 *   makes a *silent* edit impossible, which is the realistic threat.
 * - **Durable before acknowledgement.** A record is fsync'd before the caller is told
 *   it was written. An order must never reach the exchange carrying an authorisation
 *   that is not yet on disk, or a crash would produce a phantom bypass.
 * - **Serialised.** Appends are queued. Concurrent writes would interleave `prevHash`
 *   values and corrupt the chain.
 */

import { createReadStream } from "node:fs";
import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { canonicalize, sha256Hex } from "../core/canonical.js";
import { ErrorCode, bondedError, describeUnknownError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import { GENESIS_HASH, type DecisionRecord } from "../domain/decision.js";

export interface ChainState {
  readonly nextSeq: number;
  readonly headHash: string;
  readonly recordCount: number;
}

/** Serialise a record to its canonical line form. The hash is taken over exactly this text. */
export function serializeRecord(record: DecisionRecord): Result<string, BondedError> {
  const canonical = canonicalize(record);
  if (!canonical.ok) {
    return err(
      bondedError(ErrorCode.DECISION_LOG_CORRUPT, "decision record is not canonicalizable", {
        seq: record.seq,
        cause: canonical.error.message,
      }),
    );
  }
  return ok(canonical.value);
}

/**
 * Walk an existing log, verifying every link, and return the chain head.
 *
 * Streams line by line rather than reading the file into memory: a long-running
 * instance produces a log that should not have to fit in RAM to be verified.
 */
export async function verifyChain(path: string): Promise<Result<ChainState, BondedError>> {
  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 0;
  let recordCount = 0;
  let lineNumber = 0;

  // Probe existence first. `createReadStream` fails asynchronously during iteration,
  // which would surface a missing file as an unreadable one — and a first run is not
  // a corrupt log. Callers need to tell those apart.
  try {
    await stat(path);
  } catch (cause: unknown) {
    return err(
      bondedError(ErrorCode.DECISION_LOG_MISSING, "decision log does not exist", { path }, cause),
    );
  }

  const stream = createReadStream(path, { encoding: "utf8" });

  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber++;
      if (line.trim() === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause: unknown) {
        return err(
          bondedError(
            ErrorCode.DECISION_LOG_CORRUPT,
            "decision log contains a line that is not valid JSON",
            { path, lineNumber },
            cause,
          ),
        );
      }

      const record = parsed as DecisionRecord;
      if (record.seq !== expectedSeq) {
        return err(
          bondedError(ErrorCode.DECISION_LOG_CORRUPT, "decision log sequence is not contiguous", {
            path,
            lineNumber,
            expectedSeq,
            actualSeq: record.seq,
          }),
        );
      }
      if (record.prevHash !== expectedPrevHash) {
        return err(
          bondedError(ErrorCode.DECISION_LOG_CORRUPT, "decision log hash chain is broken", {
            path,
            lineNumber,
            seq: record.seq,
            expectedPrevHash,
            actualPrevHash: record.prevHash,
          }),
        );
      }

      // Re-serialise rather than hashing the raw line: this proves the record's own
      // content produces this link, so a byte-level edit that happens to preserve
      // JSON equivalence still fails verification.
      const canonical = serializeRecord(record);
      if (!canonical.ok) return canonical;

      expectedPrevHash = sha256Hex(canonical.value);
      expectedSeq = record.seq + 1;
      recordCount++;
    }
  } catch (cause: unknown) {
    return err(
      bondedError(
        ErrorCode.DECISION_LOG_IO,
        `failed reading decision log: ${describeUnknownError(cause)}`,
        { path, lineNumber },
        cause,
      ),
    );
  } finally {
    reader.close();
    stream.close();
  }

  return ok({ nextSeq: expectedSeq, headHash: expectedPrevHash, recordCount });
}

/**
 * An open, verified decision log.
 *
 * Construct with `DecisionLog.open`, which verifies the existing chain before allowing
 * a single append. Starting on top of a broken chain would silently discard the
 * guarantee the chain exists to provide.
 */
export class DecisionLog {
  readonly #handle: FileHandle;
  readonly #path: string;
  #nextSeq: number;
  #headHash: string;
  /** Append queue. Concurrent writes would interleave prevHash values. */
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(handle: FileHandle, path: string, state: ChainState) {
    this.#handle = handle;
    this.#path = path;
    this.#nextSeq = state.nextSeq;
    this.#headHash = state.headHash;
  }

  static async open(path: string): Promise<Result<DecisionLog, BondedError>> {
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (cause: unknown) {
      return err(
        bondedError(
          ErrorCode.DECISION_LOG_IO,
          "unable to create decision log directory",
          { path },
          cause,
        ),
      );
    }

    let state: ChainState = { nextSeq: 0, headHash: GENESIS_HASH, recordCount: 0 };
    const verified = await verifyChain(path);
    if (verified.ok) {
      state = verified.value;
    } else if (verified.error.code !== ErrorCode.DECISION_LOG_MISSING) {
      // A corrupt chain must not be appended to: starting on top of a broken chain
      // silently discards the guarantee the chain exists to provide.
      return verified;
    }

    try {
      const handle = await open(path, "a");
      return ok(new DecisionLog(handle, path, state));
    } catch (cause: unknown) {
      return err(
        bondedError(
          ErrorCode.DECISION_LOG_IO,
          "unable to open decision log for append",
          { path },
          cause,
        ),
      );
    }
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  get headHash(): string {
    return this.#headHash;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Append a record, filling in `seq` and `prevHash`.
   *
   * Resolves only after the bytes are on disk. The caller may then act on the
   * authorisation, and not before.
   */
  async append(
    draft: Omit<DecisionRecord, "seq" | "prevHash">,
  ): Promise<Result<DecisionRecord, BondedError>> {
    return this.appendWith(() => ok(draft));
  }

  /**
   * Append a record whose content depends on the sequence number it will receive.
   *
   * An authorised order's `clientOrderId` embeds the seq of the record authorising it,
   * so the id cannot be minted until the seq is known. Reading `nextSeq` beforehand
   * would race: two concurrent callers would mint ids for the same seq and one order
   * would reconcile against the wrong record. The builder therefore runs *inside* the
   * serialised queue, where the seq it is handed is final.
   */
  async appendWith(
    build: (seq: number) => Result<Omit<DecisionRecord, "seq" | "prevHash">, BondedError>,
  ): Promise<Result<DecisionRecord, BondedError>> {
    const task = this.#tail.then(() => this.#appendNow(build));
    // Keep the queue alive even if this append fails, so one error does not wedge the log.
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async #appendNow(
    build: (seq: number) => Result<Omit<DecisionRecord, "seq" | "prevHash">, BondedError>,
  ): Promise<Result<DecisionRecord, BondedError>> {
    if (this.#closed) {
      return err(
        bondedError(ErrorCode.DECISION_LOG_IO, "decision log is closed", { path: this.#path }),
      );
    }

    const draft = build(this.#nextSeq);
    if (!draft.ok) return draft;

    const record: DecisionRecord = { ...draft.value, seq: this.#nextSeq, prevHash: this.#headHash };
    const canonical = serializeRecord(record);
    if (!canonical.ok) return canonical;

    try {
      await this.#handle.write(`${canonical.value}\n`, null, "utf8");
      // Durability before acknowledgement: an order must never carry an authorisation
      // that a crash could erase, or reconciliation would report a phantom bypass.
      await this.#handle.sync();
    } catch (cause: unknown) {
      return err(
        bondedError(
          ErrorCode.DECISION_LOG_IO,
          "failed to durably append decision record",
          { path: this.#path, seq: record.seq },
          cause,
        ),
      );
    }

    // Advance only after a successful, durable write.
    this.#headHash = sha256Hex(canonical.value);
    this.#nextSeq = record.seq + 1;
    return ok(record);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    await this.#handle.close();
  }
}
