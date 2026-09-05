/**
 * The verifier exists so a stranger does not have to take the demo on trust. These
 * tests exist so the verifier does not have to be taken on trust either: each one
 * tampers with a real log in a way someone faking a demo actually would, and asserts
 * that the command refuses it.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintClientOrderId } from "../../src/audit/client-order-id.js";
import { DecisionLog } from "../../src/audit/decision-log.js";
import { ok, unwrap } from "../../src/core/result.js";
import { decimalUnsafe } from "../../src/core/money.js";
import type { OrderIntent } from "../../src/domain/intent.js";
import { formatVerification, verifyDecisionLog } from "../../src/verify/verify-log.js";

const SECRET = "a".repeat(64);
const MANDATE = "b3f1".repeat(16);

const INTENT: OrderIntent = {
  kind: "LIMIT",
  symbol: "ETHUSDT",
  side: "BUY",
  quantity: decimalUnsafe("0.1"),
  price: decimalUnsafe("2000"),
};

let dir: string;
let path: string;

/** A log shaped like a real demo run: two allows, two denials, one cancellation. */
async function writeDemoLog(mandateHash = MANDATE): Promise<void> {
  const log = unwrap(await DecisionLog.open(path), "open");
  const ts = "2026-09-06T12:00:00.000Z";
  await log.appendWith((seq) =>
    ok({
      ts,
      mandateHash,
      intent: INTENT,
      outcome: "ALLOW" as const,
      clientOrderId: unwrap(mintClientOrderId(SECRET, mandateHash, seq), "mint"),
    }),
  );
  await log.appendWith(() =>
    ok({
      ts,
      mandateHash,
      intent: INTENT,
      outcome: "DENY" as const,
      denial: {
        clause: "maxNotionalUsd" as const,
        clauseText: "too big",
        observed: "1000",
        limit: "500",
      },
    }),
  );
  await log.appendWith(() =>
    ok({
      ts,
      mandateHash,
      intent: INTENT,
      outcome: "DENY" as const,
      denial: { clause: "symbolAllowlist" as const, clauseText: "not allowed", observed: "DOGE" },
    }),
  );
  await log.appendWith((seq) =>
    ok({
      ts,
      mandateHash,
      intent: INTENT,
      outcome: "ALLOW" as const,
      clientOrderId: unwrap(mintClientOrderId(SECRET, mandateHash, seq), "mint"),
    }),
  );
  await log.appendWith(() =>
    ok({
      ts,
      mandateHash,
      outcome: "CANCEL" as const,
      cancel: { symbol: "ETHUSDT", clientOrderId: "bnd_x_0_y" },
    }),
  );
  await log.close();
}

async function editLine(index: number, replace: (line: string) => string): Promise<void> {
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  lines[index] = replace(lines[index] ?? "");
  await writeFile(path, lines.join("\n") + "\n");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bonded-verify-"));
  path = join(dir, "decisions.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifying an untampered log", () => {
  it("counts the decisions and reports one ruleset throughout", async () => {
    await writeDemoLog();
    const result = await verifyDecisionLog(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chain.recordCount).toBe(5);
    expect(result.value.allowed).toBe(2);
    expect(result.value.denied).toBe(2);
    expect(result.value.cancelled).toBe(1);
    expect(result.value.mandateHashes).toEqual([MANDATE]);
    expect(result.value.clientOrderIds).toHaveLength(2);
  });

  it("breaks denials down by the clause that fired", async () => {
    await writeDemoLog();
    const result = await verifyDecisionLog(path);
    expect(result.ok && result.value.deniedByClause).toEqual([
      { clause: "maxNotionalUsd", count: 1 },
      { clause: "symbolAllowlist", count: 1 },
    ]);
  });

  it("does not claim to have checked the tags when given no secret", async () => {
    await writeDemoLog();
    const result = await verifyDecisionLog(path);
    expect(result.ok && result.value.tags).toBeUndefined();
    const report = formatVerification(path, unwrap(result, "summary"));
    expect(report).toContain("NOT VERIFIED BY THIS COMMAND");
    expect(report).toContain("needs the HMAC");
  });

  it("verifies the tags when the secret is supplied", async () => {
    await writeDemoLog();
    const result = await verifyDecisionLog(path, { hmacSecret: SECRET });
    expect(result.ok && result.value.tags).toEqual({ authentic: 2, rejected: [] });
  });

  it("rejects tags that do not verify under the given secret", async () => {
    await writeDemoLog();
    const result = await verifyDecisionLog(path, { hmacSecret: "c".repeat(64) });
    expect(result.ok && result.value.tags?.authentic).toBe(0);
    expect(result.ok && result.value.tags?.rejected).toHaveLength(2);
  });
});

describe("tampering a faked demo would need", () => {
  it("catches a single edited field", async () => {
    await writeDemoLog();
    // Raise the limit so the denial looks like it should never have fired.
    await editLine(1, (line) => line.replace('"limit":"500"', '"limit":"5000"'));
    const result = await verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("hash chain is broken");
  });

  it("catches a deleted record", async () => {
    await writeDemoLog();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, [lines[0], lines[2], lines[3], lines[4]].join("\n") + "\n");
    const result = await verifyDecisionLog(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not contiguous");
  });

  it("catches an appended record that was never authorised", async () => {
    await writeDemoLog();
    const forged = JSON.stringify({
      seq: 5,
      prevHash: "0".repeat(64),
      ts: "2026-09-06T12:00:00.000Z",
      mandateHash: MANDATE,
      intent: INTENT,
      outcome: "ALLOW",
      clientOrderId: "bnd_deadbeef_5_000000000000",
    });
    await writeFile(path, (await readFile(path, "utf8")) + forged + "\n");
    const result = await verifyDecisionLog(path);
    expect(result.ok).toBe(false);
  });

  it("catches a log that is not valid JSON", async () => {
    await writeDemoLog();
    await editLine(2, () => "{ not json");
    expect((await verifyDecisionLog(path)).ok).toBe(false);
  });

  it("reports a missing log as missing rather than as corrupt", async () => {
    const result = await verifyDecisionLog(join(dir, "nothing-here.jsonl"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not exist");
  });
});

describe("a log whose rules changed mid-run", () => {
  it("names every mandate cited instead of reporting one", async () => {
    // The chain can be intact while the ruleset was swapped underneath it. That is not
    // corruption, but it is not a clean bill of health either.
    const log = unwrap(await DecisionLog.open(path), "open");
    for (const mandateHash of [MANDATE, "c".repeat(64)]) {
      await log.appendWith(() =>
        ok({
          ts: "2026-09-06T12:00:00.000Z",
          mandateHash,
          intent: INTENT,
          outcome: "DENY" as const,
          denial: { clause: "expiry" as const, clauseText: "expired", observed: "x" },
        }),
      );
    }
    await log.close();

    const result = await verifyDecisionLog(path);
    expect(result.ok && result.value.mandateHashes).toHaveLength(2);
    const report = formatVerification(path, unwrap(result, "summary"));
    expect(report).toContain("DIFFERENT rulesets");
  });
});
