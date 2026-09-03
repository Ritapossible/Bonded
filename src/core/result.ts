/**
 * A `Result` makes expected failures part of the type signature.
 *
 * BONDED distinguishes two kinds of failure, and the distinction is load-bearing:
 *
 * - **Expected failures** — a malformed mandate, a rejected order, an unparseable
 *   decimal. These are domain outcomes, returned as `Err`. Callers must handle them.
 * - **Programmer errors** — a broken invariant, an impossible branch. These throw,
 *   because there is no sensible recovery and the stack trace is the useful artifact.
 *
 * Using exceptions for the first kind is how a gate ends up failing open: an
 * uncaught throw in an evaluation path is indistinguishable from "no rule fired".
 */

export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Map the success value, leaving an error untouched. */
export function mapOk<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Chain a fallible step onto a success, short-circuiting on error. */
export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/**
 * Collect a list of results into a result of a list, failing on the first error.
 * Used when validating every symbol in a mandate: one bad symbol fails the mandate.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}

/**
 * Unwrap a success or throw. Only legitimate where an `Err` would be a programmer
 * error — in tests, or after an explicit `isOk` check the type system cannot see.
 */
export function unwrap<T, E>(r: Result<T, E>, context: string): T {
  if (!r.ok) {
    throw new Error(`${context}: unwrap called on Err: ${JSON.stringify(r.error)}`);
  }
  return r.value;
}
