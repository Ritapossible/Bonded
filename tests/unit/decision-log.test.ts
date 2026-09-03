import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical.js";
import { ErrorCode } from "../../src/core/errors.js";
import { unwrap } from "../../src/core/result.js";
import { DecisionLog, serializeRecord, verifyChain } from "../../src/audit/decision-log.js";
import { GENESIS_HASH, type DecisionRecord } from "../../src/domain/decision.js";
import { decimalUnsafe } from "../../src/core/money.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bonded-log-"));
  path = join(dir, "decisions.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<DecisionRecord> = {}): Omit<DecisionRecord, "seq" | "prevHash"> {
  return {
    ts: "2026-09-06T12:00:00.000Z",
    mandateHash: "a".repeat(64),
    intent: {
      kind: "LIMIT",
      symbol: "ETHUSDT",
      side: "BUY",
      quantity: decimalUnsafe("0.1"),
      price: decimalUnsafe("2000"),
    },
    notionalUsd: decimalUnsafe("200"),
    outcome: "ALLOW",
    ...overrides,
  };
}

describe("DecisionLog", () => {
  it("starts an empty log at the genesis link", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    expect(log.nextSeq).toBe(0);
    expect(log.headHash).toBe(GENESIS_HASH);
    await log.close();
  });

  it("chains each record to the previous one", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    const first = unwrap(await log.append(draft()), "append 1");
    const second = unwrap(await log.append(draft()), "append 2");
    await log.close();

    expect(first.seq).toBe(0);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(sha256Hex(unwrap(serializeRecord(first), "serialize")));
  });

  it("resumes from the existing head after reopening", async () => {
    const first = unwrap(await DecisionLog.open(path), "open 1");
    await first.append(draft());
    await first.append(draft());
    const head = first.headHash;
    await first.close();

    const reopened = unwrap(await DecisionLog.open(path), "open 2");
    expect(reopened.nextSeq).toBe(2);
    expect(reopened.headHash).toBe(head);
    await reopened.close();
  });

  it("preserves order under concurrent appends", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    // Fired without awaiting: the queue must serialise them or the chain breaks.
    const results = await Promise.all(Array.from({ length: 25 }, () => log.append(draft())));
    await log.close();

    const seqs = results.map((r) => unwrap(r, "append").seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(unwrap(await verifyChain(path), "verify").recordCount).toBe(25);
  });

  it("verifies a well-formed chain", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    await log.append(draft());
    await log.append(draft({ outcome: "DENY" }));
    await log.close();

    const verified = unwrap(await verifyChain(path), "verify");
    expect(verified.recordCount).toBe(2);
    expect(verified.nextSeq).toBe(2);
  });

  describe("tamper detection", () => {
    it("detects an edited record", async () => {
      const log = unwrap(await DecisionLog.open(path), "open");
      await log.append(draft());
      await log.append(draft());
      await log.close();

      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
      const tampered = JSON.parse(lines[0]!) as DecisionRecord;
      const edited = { ...tampered, outcome: "DENY" as const };
      await writeFile(path, `${JSON.stringify(edited)}\n${lines[1]!}\n`, "utf8");

      const result = await verifyChain(path);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe(ErrorCode.DECISION_LOG_CORRUPT);
    });

    it("detects a removed record", async () => {
      const log = unwrap(await DecisionLog.open(path), "open");
      await log.append(draft());
      await log.append(draft());
      await log.append(draft());
      await log.close();

      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
      await writeFile(path, `${lines[0]!}\n${lines[2]!}\n`, "utf8");

      const result = await verifyChain(path);
      expect(result.ok).toBe(false);
    });

    it("refuses to open a log whose chain is broken", async () => {
      await writeFile(path, `${JSON.stringify({ ...draft(), seq: 5, prevHash: "x" })}\n`, "utf8");
      const result = await DecisionLog.open(path);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe(ErrorCode.DECISION_LOG_CORRUPT);
    });

    it("reports a missing log distinctly from a corrupt one", async () => {
      // A first run must not look like tampering: the boot guard passes on MISSING and
      // fails on CORRUPT, so conflating them would either block startup or hide damage.
      const result = await verifyChain(join(dir, "does-not-exist.jsonl"));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe(ErrorCode.DECISION_LOG_MISSING);
    });

    it("rejects a line that is not valid JSON", async () => {
      await writeFile(path, "not json\n", "utf8");
      const result = await verifyChain(path);
      expect(result.ok).toBe(false);
    });
  });

  it("writes one canonical line per record", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    await log.append(draft());
    await log.close();

    const contents = await readFile(path, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trimEnd().split("\n")).toHaveLength(1);
    // Canonical form sorts keys, so `intent` precedes `mandateHash` precedes `seq`.
    expect(contents.indexOf('"intent"')).toBeLessThan(contents.indexOf('"mandateHash"'));
  });

  it("refuses to append after close", async () => {
    const log = unwrap(await DecisionLog.open(path), "open");
    await log.close();
    const result = await log.append(draft());
    expect(result.ok).toBe(false);
  });
});
