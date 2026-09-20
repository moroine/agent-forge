// tests/claude-dist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  versionsDir, currentLink, versionDir, listVersions, currentVersion,
  installArgv, switchCurrent,
} from "../scripts/lib/claude-dist.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-claude-"));
  process.env.FORGE_CLAUDE_DIST = dir;
  return dir;
}

test("the layout is versions/<v> plus a current symlink", () => {
  const dir = sandbox();
  assert.equal(versionsDir(), join(dir, "versions"));
  assert.equal(versionDir("2.0.14"), join(dir, "versions", "2.0.14"));
  assert.equal(currentLink(), join(dir, "current"));
});

test("listVersions is empty before anything is installed", () => {
  sandbox();
  assert.deepEqual(listVersions(), []);
});

test("listVersions lists directories only, sorted", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  writeFileSync(join(dir, "versions", "README"), "not a version");
  assert.deepEqual(listVersions(), ["2.0.14", "2.0.9"]);
});

test("currentVersion is null with no symlink, and the basename otherwise", () => {
  const dir = sandbox();
  assert.equal(currentVersion(), null);
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  symlinkSync(join(dir, "versions", "2.0.14"), join(dir, "current"));
  assert.equal(currentVersion(), "2.0.14");
});

test("installArgv installs into the version directory, pinned", () => {
  const dir = sandbox();
  assert.deepEqual(installArgv("2.0.14"), [
    "npm", "install", "--prefix", join(dir, "versions", "2.0.14"),
    "@anthropic-ai/claude-code@2.0.14",
  ]);
});

test("switchCurrent replaces an existing symlink atomically", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  switchCurrent("2.0.9");
  assert.equal(currentVersion(), "2.0.9");
  switchCurrent("2.0.14");
  assert.equal(currentVersion(), "2.0.14");
  assert.equal(readlinkSync(join(dir, "current")), join(dir, "versions", "2.0.14"));
});

test("switchCurrent refuses a version that is not installed", () => {
  sandbox();
  assert.throws(() => switchCurrent("9.9.9"), /9\.9\.9/);
});
