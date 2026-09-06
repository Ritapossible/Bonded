/**
 * Independent verification of a decision log.
 *
 * The demo shows a bypass being caught. A viewer has no reason to believe it — every
 * frame of it could be staged. This is the answer: publish the log the run produced and
 * let anyone check it without running BONDED, without the API keys, and without
 * trusting whoever recorded the video.
 *
 * It is the project's own argument applied to its own evidence. BONDED does not ask the
 * exchange to be trusted; it reconciles against a second, independent account. A claim
 * about BONDED should not ask to be trusted either.
 *
 * **What a third party can check here**, holding nothing but the file:
 *
 * - the hash chain from genesis, so no record was edited, removed or reordered;
 * - that sequence numbers are contiguous, so none was dropped;
 * - that every record cites the same mandate hash, so the rules were not swapped
 *   mid-run while the trail was kept;
 * - the exchange order ids, which are checkable against Binance itself.
 *
 * **What it cannot check without the HMAC secret**: whether each stamped client order
 * id is authentic. That verification needs the key, and the key is the operator's. Pass
 * `--secret` if you hold it. Otherwise the report says the tags were not verified,
 * rather than quietly implying they were.
 *
 * **What a hash chain cannot do at all, and why `--head` exists.** The chain hash is
 * unkeyed, so anyone can compute it. Walking the chain proves every record agrees with
 * the one after it — which pins every record except the last, because nothing follows
 * the last one to disagree with it. Two edits therefore survive a chain walk: changing
 * the final record, and appending a new record with a correctly computed `prevHash`.
 * Both are exactly what faking a demo would look like, so neither may be reported as
 * verified.
 *
 * The fix does not need a secret, only an out-of-band commitment. The head hash is a
 * commitment to the entire history: publish it — say it in the video, put it in a
 * README, post it — and pass it back as `--head`. Any edit anywhere, tail included,
 * moves the head and fails the check. Without `--head`, the report says the tail is
 * unwitnessed instead of calling the log verified.
 */

import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { verifyClientOrderId } from "../audit/client-order-id.js";
import { verifyChain, type ChainState } from "../audit/decision-log.js";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { DecisionRecord } from "../domain/decision.js";

export interface LogSummary {
  readonly chain: ChainState;
  readonly allowed: number;
  readonly denied: number;
  readonly cancelled: number;
  /** Denials by clause, most frequent first. */
  readonly deniedByClause: readonly { readonly clause: string; readonly count: number }[];
  /** Distinct mandate hashes cited. More than one means the rules changed mid-log. */
  readonly mandateHashes: readonly string[];
  readonly firstTs: string | undefined;
  readonly lastTs: string | undefined;
  /** Stamped ids of authorised orders, checkable against the exchange. */
  readonly clientOrderIds: readonly string[];
  /**
   * Tag verification, when a secret was supplied.
   *
   * Absent means it was not attempted — which the report states rather than leaving the
   * reader to assume one way or the other.
   */
  readonly tags?: { readonly authentic: number; readonly rejected: readonly string[] };
  /** True when the caller pinned the head and it matched. Absent means no head was given. */
  readonly headPinned?: boolean;
}

export interface VerifyOptions {
  /** HMAC secret, if the caller holds it. Enables client-order-id tag verification. */
  readonly hmacSecret?: string;
  /**
   * A head hash published out of band, to pin the history against.
   *
   * This is what closes the tail gap. Without it the chain cannot distinguish an
   * honest final record from an edited one, or an appended record from a real one.
   */
  readonly expectedHead?: string;
}

/**
 * Verify a decision log and summarise it.
 *
 * Chain integrity is delegated to `verifyChain` rather than reimplemented here: a second
 * implementation of the check would be a second thing to keep correct, and a verifier
 * that disagrees with the writer is worse than no verifier.
 */
export async function verifyDecisionLog(
  path: string,
  options: VerifyOptions = {},
): Promise<Result<LogSummary, BondedError>> {
  const chain = await verifyChain(path);
  if (!chain.ok) return chain;

  // Before anything else. A pinned head that does not match means the history in this
  // file is not the history that was committed to, and nothing below it is worth
  // reporting as a finding about that history.
  if (options.expectedHead !== undefined) {
    const expected = options.expectedHead.trim().toLowerCase();
    if (expected !== chain.value.headHash) {
      return err(
        bondedError(
          ErrorCode.DECISION_LOG_CORRUPT,
          "decision log head does not match the head you pinned",
          { path, expectedHead: expected, actualHead: chain.value.headHash },
        ),
      );
    }
  }

  let allowed = 0;
  let denied = 0;
  let cancelled = 0;
  let authentic = 0;
  const rejected: string[] = [];
  const byClause = new Map<string, number>();
  const mandateHashes = new Set<string>();
  const clientOrderIds: string[] = [];
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as DecisionRecord;

      firstTs ??= record.ts;
      lastTs = record.ts;
      mandateHashes.add(record.mandateHash);

      switch (record.outcome) {
        case "ALLOW": {
          allowed++;
          if (record.clientOrderId !== undefined) {
            clientOrderIds.push(record.clientOrderId);
            if (options.hmacSecret !== undefined) {
              const verdict = verifyClientOrderId(
                options.hmacSecret,
                record.mandateHash,
                record.clientOrderId,
              );
              if (verdict.kind === "authentic") authentic++;
              else rejected.push(`${record.clientOrderId} (${verdict.kind})`);
            }
          }
          break;
        }
        case "DENY": {
          denied++;
          const clause = record.denial?.clause ?? "unknown";
          byClause.set(clause, (byClause.get(clause) ?? 0) + 1);
          break;
        }
        case "CANCEL":
          cancelled++;
          break;
      }
    }
  } catch (cause: unknown) {
    return err(
      bondedError(
        ErrorCode.DECISION_LOG_CORRUPT,
        "could not read the decision log",
        { path },
        cause,
      ),
    );
  } finally {
    reader.close();
  }

  return ok({
    chain: chain.value,
    allowed,
    denied,
    cancelled,
    deniedByClause: [...byClause.entries()]
      .map(([clause, count]) => ({ clause, count }))
      .sort((a, b) => b.count - a.count || a.clause.localeCompare(b.clause)),
    mandateHashes: [...mandateHashes],
    firstTs,
    lastTs,
    clientOrderIds,
    ...(options.hmacSecret === undefined ? {} : { tags: { authentic, rejected } }),
    ...(options.expectedHead === undefined ? {} : { headPinned: true }),
  });
}

/** The report, written for someone who has never seen this project. */
export function formatVerification(path: string, summary: LogSummary): string {
  const lines: string[] = [];
  const say = (text = "") => lines.push(text);

  say(`BONDED decision log — ${path}`);
  say();
  say("  VERIFIED");
  say(
    `    hash chain          intact from genesis across ${String(summary.chain.recordCount)} records` +
      (summary.headPinned === true ? "" : " (tail unwitnessed - see below)"),
  );
  say(`    sequence            contiguous, 0 to ${String(summary.chain.nextSeq - 1)}`);
  say(`    head                ${summary.chain.headHash}`);
  if (summary.headPinned === true) {
    say("    pinned head         MATCHES — this is the history that was committed to");
  }
  say(
    summary.mandateHashes.length === 1
      ? `    mandate             ${summary.mandateHashes[0] ?? ""} — one ruleset throughout`
      : `    mandate             ${String(summary.mandateHashes.length)} DIFFERENT rulesets cited: ${summary.mandateHashes.join(", ")}`,
  );
  if (summary.firstTs !== undefined) {
    say(`    covering            ${summary.firstTs} to ${summary.lastTs ?? ""}`);
  }

  say();
  say("  DECISIONS");
  say(`    allowed             ${String(summary.allowed)}`);
  say(`    denied              ${String(summary.denied)}`);
  if (summary.cancelled > 0) say(`    cancelled           ${String(summary.cancelled)}`);
  for (const { clause, count } of summary.deniedByClause) {
    say(`      ${clause.padEnd(24)}${String(count)}`);
  }

  if (summary.tags !== undefined) {
    say();
    say("  CLIENT ORDER ID TAGS");
    say(`    authentic           ${String(summary.tags.authentic)}`);
    if (summary.tags.rejected.length > 0) {
      say(`    REJECTED            ${String(summary.tags.rejected.length)}`);
      for (const id of summary.tags.rejected) say(`      ${id}`);
    }
  }

  say();
  say("  NOT VERIFIED BY THIS COMMAND");
  if (summary.headPinned !== true) {
    // The chain pins every record against the one after it, so the last record is
    // pinned by nothing. Saying "verified" without saying this would be the exact
    // overclaim this command exists to refuse.
    say("    Whether the LAST record is genuine, or whether records were appended. The");
    say("    chain hash is unkeyed, so anyone can extend it: a chain walk pins every");
    say("    record against the next one, and nothing follows the last one. Re-run with");
    say(`      --head ${summary.chain.headHash}`);
    say("    against a head the operator published beforehand — in the video, a README,");
    say("    anywhere public. Any edit at all moves the head, tail included.");
  }
  if (summary.tags === undefined) {
    say("    Whether each stamped client order id is authentic. That needs the HMAC");
    say("    secret, which belongs to the operator. Pass --secret if you hold it.");
  } else {
    say("    What an authentic tag covers: the mandate hash and the sequence number, not");
    say("    the order's symbol, side, quantity or price. A valid tag says this decision");
    say("    was minted by the key holder under that ruleset, not what it asked for.");
  }
  say("    Whether these orders reached the exchange, and what they did there. Check");
  say("    the ids below against Binance yourself — that is the point of listing them.");
  say("    A log is a claim about what BONDED authorised, not proof of what happened.");

  if (summary.clientOrderIds.length > 0) {
    say();
    say("  AUTHORISED ORDER IDS");
    for (const id of summary.clientOrderIds.slice(0, 20)) say(`    ${id}`);
    if (summary.clientOrderIds.length > 20) {
      say(`    … and ${String(summary.clientOrderIds.length - 20)} more`);
    }
  }

  say();
  return lines.join("\n");
}
