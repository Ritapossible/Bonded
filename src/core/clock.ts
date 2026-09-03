/**
 * Time as an injected dependency.
 *
 * The gate must be a pure function of (mandate, intent, account state, now). Reading
 * the wall clock inside a rule would make trading-window and expiry checks untestable
 * without freezing global time, and would make two evaluations of the same inputs
 * disagree. Every component that needs the time takes a `Clock`.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests and for replaying a recorded session. */
export class FixedClock implements Clock {
  #current: number;

  constructor(startMs: number) {
    this.#current = startMs;
  }

  now(): number {
    return this.#current;
  }

  advance(deltaMs: number): void {
    this.#current += deltaMs;
  }

  set(epochMs: number): void {
    this.#current = epochMs;
  }
}

/** Parse an ISO-8601 instant into epoch milliseconds, or `undefined` if invalid. */
export function parseInstant(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** UTC minutes since midnight, for trading-window comparisons. */
export function utcMinutesOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** UTC calendar day as `YYYY-MM-DD`, the bucket key for daily limits. */
export function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
