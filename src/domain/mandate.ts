/**
 * The mandate: the complete, deterministic statement of what an agent may do.
 *
 * Two properties matter more than any individual clause.
 *
 * 1. **It is data, not code.** A mandate is compiled once, validated, hashed, and then
 *    only ever read. Nothing at request time can widen it.
 * 2. **It is content-addressed.** `mandateHash` is the SHA-256 of the canonical form
 *    and is stamped into every decision record and every certificate. A record that
 *    cites a hash is a record about one exact ruleset — the rules cannot be quietly
 *    loosened while the audit trail is kept.
 *
 * All fractional values are decimal strings (see `core/money.ts`). Only counts and
 * versions are JS numbers, and only as safe integers.
 */

import { z } from "zod";
import { canonicalHash } from "../core/canonical.js";
import { parseInstant } from "../core/clock.js";
import { ErrorCode, bondedError, type BondedError } from "../core/errors.js";
import { greaterThan, parsePositiveDecimal, type DecimalString } from "../core/money.js";
import { err, ok, type Result } from "../core/result.js";

export const ORDER_SIDES = ["BUY", "SELL"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ["LIMIT", "MARKET"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** `HH:MM` in 24-hour UTC. */
const HUNDRED = "100" as DecimalString;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Uppercase alphanumeric, matching Binance's symbol convention. */
const SYMBOL = /^[A-Z0-9]{2,20}$/;

const decimalString = (field: string) =>
  z.string().superRefine((value, ctx) => {
    const parsed = parsePositiveDecimal(value, field);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error.message });
    }
  });

/**
 * The wire form of a mandate — what is written to disk and what gets hashed.
 * `strict()` so that an unrecognised key is an error: a typo'd clause name must never
 * be silently ignored, because the operator would believe a limit is in force when
 * nothing is enforcing it.
 */
export const MandateSchema = z
  .object({
    version: z.literal(1),
    env: z.enum(["testnet", "prod"]),
    symbols: z.array(z.string().regex(SYMBOL, "not a valid Binance symbol")).min(1).max(50),
    orderTypes: z.array(z.enum(ORDER_TYPES)).min(1),
    sides: z.array(z.enum(ORDER_SIDES)).min(1),
    maxNotionalUsd: decimalString("maxNotionalUsd"),
    maxOpenOrders: z.number().int().min(1).max(100),
    dailyLossLimitUsd: decimalString("dailyLossLimitUsd"),
    // Bounded at 100: a percentage above it can never be reached, which is a silently
    // disabled clause wearing the appearance of an enabled one.
    maxDrawdownPct: decimalString("maxDrawdownPct").superRefine((value, ctx) => {
      const parsed = parsePositiveDecimal(value, "maxDrawdownPct");
      if (parsed.ok && greaterThan(parsed.value, HUNDRED)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must not exceed 100, since it is a percentage of the quote balance",
        });
      }
    }),
    tradingWindowUtc: z.tuple([
      z.string().regex(TIME_OF_DAY, "expected HH:MM"),
      z.string().regex(TIME_OF_DAY, "expected HH:MM"),
    ]),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MandateSpec = z.infer<typeof MandateSchema>;

/**
 * A validated mandate plus its derived, precomputed form.
 *
 * Derived fields exist so the gate does no parsing on the hot path: symbol membership
 * is a `Set` lookup and window bounds are integers, both resolved once at load time.
 */
export interface Mandate {
  readonly spec: MandateSpec;
  readonly hash: string;
  readonly symbols: ReadonlySet<string>;
  readonly orderTypes: ReadonlySet<OrderType>;
  readonly sides: ReadonlySet<OrderSide>;
  readonly maxNotionalUsd: DecimalString;
  readonly dailyLossLimitUsd: DecimalString;
  readonly maxDrawdownPct: DecimalString;
  readonly windowStartMinute: number;
  readonly windowEndMinute: number;
  readonly expiresAtMs: number;
}

function minutesOfDay(hhmm: string): number {
  // The regex in the schema guarantees this shape, so the parse cannot fail here.
  const [hours, minutes] = hhmm.split(":") as [string, string];
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Validate a candidate mandate and derive its runtime form.
 *
 * This is the only constructor. There is no way to obtain a `Mandate` that has not
 * been through the schema, had its window and expiry resolved, and been hashed.
 */
export function compileMandate(input: unknown): Result<Mandate, BondedError> {
  const parsed = MandateSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      bondedError(ErrorCode.MANDATE_INVALID, "mandate failed validation", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }),
    );
  }
  const spec = parsed.data;

  const expiresAtMs = parseInstant(spec.expiresAt);
  if (expiresAtMs === undefined) {
    return err(
      bondedError(ErrorCode.MANDATE_INVALID, "expiresAt is not a valid instant", {
        expiresAt: spec.expiresAt,
      }),
    );
  }

  const windowStartMinute = minutesOfDay(spec.tradingWindowUtc[0]);
  const windowEndMinute = minutesOfDay(spec.tradingWindowUtc[1]);
  if (windowEndMinute < windowStartMinute) {
    // Rejected rather than interpreted as an overnight window. A mandate whose meaning
    // depends on a convention the operator may not share is worse than no mandate.
    return err(
      bondedError(ErrorCode.MANDATE_INVALID, "tradingWindowUtc must not wrap past midnight", {
        window: spec.tradingWindowUtc,
      }),
    );
  }

  const duplicateSymbol = findDuplicate(spec.symbols);
  if (duplicateSymbol !== undefined) {
    return err(
      bondedError(ErrorCode.MANDATE_INVALID, "duplicate symbol in allowlist", {
        symbol: duplicateSymbol,
      }),
    );
  }

  const hash = canonicalHash(spec);
  if (!hash.ok) return hash;

  return ok({
    spec,
    hash: hash.value,
    symbols: new Set(spec.symbols),
    orderTypes: new Set(spec.orderTypes),
    sides: new Set(spec.sides),
    maxNotionalUsd: spec.maxNotionalUsd as DecimalString,
    dailyLossLimitUsd: spec.dailyLossLimitUsd as DecimalString,
    maxDrawdownPct: spec.maxDrawdownPct as DecimalString,
    windowStartMinute,
    windowEndMinute,
    expiresAtMs,
  });
}

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/**
 * The view of the mandate the agent is allowed to see: clause *names* only.
 *
 * The agent learns the rules by being refused, one clause at a time. It never reads
 * the thresholds, so it cannot reason about how close it is to a limit or shape its
 * behaviour to sit just inside one.
 */
export function mandateSummaryForAgent(
  mandate: Mandate,
  clauses: readonly string[],
): {
  mandateHash: string;
  clauses: string[];
  expiresAt: string;
} {
  return {
    mandateHash: mandate.hash,
    // Passed in rather than listed here. The hand-written list this replaced had drifted
    // to nine names out of nineteen, omitted `scope` — the one an agent must stop on —
    // and advertised `exchangeFilters`, which was never a clause id at all, so an agent
    // could be refused by a name it had been told did not exist.
    clauses: [...clauses],
    expiresAt: mandate.spec.expiresAt,
  };
}
