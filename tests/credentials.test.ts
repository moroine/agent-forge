// tests/credentials.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialPath, readToken, writeToken, removeToken } from "../scripts/lib/credentials.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-cred-"));
  process.env.FORGE_CONFIG_HOME = dir;
  return dir;
}

test("credentialPath flattens owner/repo into one file name", () => {
  const dir = sandbox();
  assert.equal(credentialPath("moroine/agent-forge"), join(dir, "credentials", "moroine-agent-forge"));
});

test("readToken returns null when nothing is stored", () => {
  sandbox();
  assert.equal(readToken("moroine/agent-forge"), null);
});

test("writeToken creates a 0700 directory holding a 0600 file", () => {
  const dir = sandbox();
  writeToken("moroine/agent-forge", "ghp_secret");
  assert.equal(statSync(join(dir, "credentials")).mode & 0o777, 0o700);
  assert.equal(statSync(credentialPath("moroine/agent-forge")).mode & 0o777, 0o600);
  assert.equal(readFileSync(credentialPath("moroine/agent-forge"), "utf8"), "ghp_secret");
});

test("readToken trims the trailing newline an editor would add", () => {
  sandbox();
  writeToken("o/r", "  ghp_secret\n");
  assert.equal(readToken("o/r"), "ghp_secret");
});

test("writeToken overwrites and keeps the mode", () => {
  sandbox();
  writeToken("o/r", "first");
  writeToken("o/r", "second");
  assert.equal(readToken("o/r"), "second");
  assert.equal(statSync(credentialPath("o/r")).mode & 0o777, 0o600);
});

test("removeToken reports whether there was anything to remove", () => {
  sandbox();
  assert.equal(removeToken("o/r"), false);
  writeToken("o/r", "x");
  assert.equal(removeToken("o/r"), true);
  assert.equal(existsSync(credentialPath("o/r")), false);
});
