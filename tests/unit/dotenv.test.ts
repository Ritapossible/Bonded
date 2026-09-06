/**
 * `.env` loading, which the documented setup depended on and which did not exist.
 *
 * The precedence test is the one that matters: an explicitly-set environment variable
 * must beat a file. A stale `.env` sitting in a directory, silently overriding a
 * deliberate `BINANCE_API_ENV=prod`, is how the wrong account gets traded.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotenvCandidates, loadDotenv, parseDotenv } from "../../src/config/dotenv.js";

describe("parseDotenv", () => {
  it("reads plain assignments", () => {
    expect(parseDotenv("A=1\nB=two")).toEqual(
      new Map([
        ["A", "1"],
        ["B", "two"],
      ]),
    );
  });

  it("ignores comments and blank lines", () => {
    expect(parseDotenv("# a comment\n\nA=1\n   \n# another\n")).toEqual(new Map([["A", "1"]]));
  });

  it("accepts an export prefix, which people paste in from a shell", () => {
    expect(parseDotenv("export A=1")).toEqual(new Map([["A", "1"]]));
  });

  it("strips matching quotes so a quoted secret does not gain them", () => {
    expect(parseDotenv(`A="quoted"\nB='single'`)).toEqual(
      new Map([
        ["A", "quoted"],
        ["B", "single"],
      ]),
    );
  });

  it("keeps a value containing an equals sign intact", () => {
    // Base64 secrets end in '='. Splitting on the last one would corrupt them.
    expect(parseDotenv("A=abc=def==")).toEqual(new Map([["A", "abc=def=="]]));
  });

  it("keeps a '#' that is part of an unquoted value", () => {
    expect(parseDotenv("A=pa#ssword")).toEqual(new Map([["A", "pa#ssword"]]));
  });

  it("drops a trailing inline comment", () => {
    expect(parseDotenv("A=value # trailing")).toEqual(new Map([["A", "value"]]));
  });

  it("does not treat a '#' inside quotes as a comment", () => {
    expect(parseDotenv(`A="value # not a comment"`)).toEqual(
      new Map([["A", "value # not a comment"]]),
    );
  });

  it("skips malformed lines rather than guessing", () => {
    expect(parseDotenv("no equals here\n=novalue\n1BAD=x\nA=1")).toEqual(new Map([["A", "1"]]));
  });

  it("reads an empty value as empty, not as absent", () => {
    expect(parseDotenv("A=")).toEqual(new Map([["A", ""]]));
  });
});

describe("loadDotenv", () => {
  let dir: string;
  const touched: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bonded-dotenv-"));
  });

  afterEach(async () => {
    // Assigning undefined removes the key without a dynamic delete, which the lint
    // rule forbids for good reasons that do not apply to test cleanup.
    for (const key of touched.splice(0)) process.env[key] = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("fills in a variable the environment does not have", async () => {
    await writeFile(join(dir, ".env"), "BONDED_TEST_FILLED=from-file\n");
    touched.push("BONDED_TEST_FILLED");

    const result = loadDotenv(dir);
    expect(result.applied).toContain("BONDED_TEST_FILLED");
    expect(process.env["BONDED_TEST_FILLED"]).toBe("from-file");
  });

  it("never overwrites a variable that is already set", async () => {
    // The rule that keeps a stale file from redirecting a deliberate choice.
    process.env["BONDED_TEST_WINS"] = "from-environment";
    touched.push("BONDED_TEST_WINS");
    await writeFile(join(dir, ".env"), "BONDED_TEST_WINS=from-file\n");

    const result = loadDotenv(dir);
    expect(process.env["BONDED_TEST_WINS"]).toBe("from-environment");
    expect(result.skipped).toContain("BONDED_TEST_WINS");
    expect(result.applied).not.toContain("BONDED_TEST_WINS");
  });

  it("reports the file it read but never the values", async () => {
    await writeFile(join(dir, ".env"), "BONDED_TEST_SECRET=hunter2\n");
    touched.push("BONDED_TEST_SECRET");

    const result = loadDotenv(dir);
    expect(result.path).toBe(join(dir, ".env"));
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("does nothing, and does not throw, when there is no file", () => {
    const result = loadDotenv(dir);
    expect(result).toEqual({ path: undefined, applied: [], skipped: [] });
  });

  it("looks beside the installation as well as in the working directory", () => {
    // An MCP server is launched by the agent, often from a GUI with an arbitrary cwd.
    //
    // The expected second candidate is derived here from this test file's own location
    // rather than from the checkout's name. Asserting on a literal "/bonded/.env" passed
    // only because this working copy happens to sit in a directory called `bonded`, and
    // went red for anyone who cloned into `Bonded` — as the README's own clone command
    // tells them to — or into any other name.
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

    const candidates = dotenvCandidates("/some/other/place");
    expect(candidates[0]).toBe("/some/other/place/.env");
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates).toContain(join(packageRoot, ".env"));
  });
});
