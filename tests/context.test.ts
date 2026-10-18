import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, ForgeError } from "../cli/lib/context.ts";

test("exec captures stdout and the exit code", async () => {
  const r = await createContext().exec(["printf", "hello"]);
  assert.equal(r.stdout, "hello");
  assert.equal(r.code, 0);
});

test("exec does not throw on a non-zero exit code", async () => {
  const r = await createContext().exec(["false"]);
  assert.equal(r.code, 1);
});

test("exec reports a missing binary as a non-zero code, not a crash", async () => {
  const r = await createContext().exec(["definitely-not-a-real-binary-xyz"]);
  assert.notEqual(r.code, 0);
});

test("exec passes input on stdin", async () => {
  const r = await createContext().exec(["cat"], { input: "piped" });
  assert.equal(r.stdout, "piped");
});

test("exec passes arguments without a shell in between", async () => {
  const r = await createContext().exec(["printf", "%s", "a b; echo pwned"]);
  assert.equal(r.stdout, "a b; echo pwned");
});

test("ForgeError carries only the message, without an Error: prefix", () => {
  const e = new ForgeError("no container found for x/y");
  assert.equal(e.message, "no container found for x/y");
  assert.ok(e instanceof Error);
});

test("exec passes extra environment variables", async () => {
  const r = await createContext().exec(["sh", "-c", "printf %s \"$FORGE_T\""], { env: { FORGE_T: "ok" } });
  assert.equal(r.stdout, "ok");
});

test("exec merges extra variables into the inherited environment", async () => {
  const before = process.env.FORGE_INHERITED;
  process.env.FORGE_INHERITED = "yes";
  try {
    const r = await createContext().exec(
      ["sh", "-c", "printf %s \"$FORGE_INHERITED/$FORGE_T\""], { env: { FORGE_T: "ok" } });
    assert.equal(r.stdout, "yes/ok");
  } finally {
    if (before === undefined) delete process.env.FORGE_INHERITED;
    else process.env.FORGE_INHERITED = before;
  }
});
