// shellQuote lives in its own tiny module, so herdr-config.ts does not pull
// in tabs.ts (and through it session, incus and worktrees).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shellQuote } from "../cli/lib/shell.ts";

test("shellQuote single-quotes a value and escapes its single quotes", () => {
  assert.equal(shellQuote("/usr/local/bin/forge"), "'/usr/local/bin/forge'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("herdr-config.ts takes shellQuote from shell.ts, not from tabs.ts", () => {
  const src = readFileSync("cli/lib/herdr-config.ts", "utf8");
  assert.match(src, /import \{ shellQuote \} from "\.\/shell\.ts";/);
  assert.doesNotMatch(src, /from "\.\/tabs\.ts"/);
});
