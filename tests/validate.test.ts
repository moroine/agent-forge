import { test } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "../cli/lib/context.ts";
import { validateRepo, validateTaskName, validateGitRef, sanitizeContainerName } from "../cli/lib/validate.ts";

test("validateRepo accepts owner/repo and rejects anything else", () => {
  validateRepo("moroine/agent-forge");
  validateRepo("my.org/my_repo-2");
  for (const bad of ["noslash", "a/b/c", "a b/c", "owner/", "/repo", "a;id/b"]) {
    assert.throws(() => validateRepo(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("validateTaskName allows [A-Za-z0-9._-] only", () => {
  validateTaskName("cli");
  validateTaskName("terminal-resize.fix_2");
  for (const bad of ["with space", "a/b", "semi;colon", "$(whoami)", "tick`x`", ""]) {
    assert.throws(() => validateTaskName(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("validateGitRef allows slashes but refuses a leading dash", () => {
  validateGitRef("origin/feature/thing");
  validateGitRef("v1.2.3");
  for (const bad of ["--upload-pack=evil", "-x", "a b", "a;b", "$(id)"]) {
    assert.throws(() => validateGitRef(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("the error message names the offending value", () => {
  assert.throws(() => validateTaskName("bad name"), /bad name/);
});

test("sanitizeContainerName lowercases and collapses non-charset runs", () => {
  assert.equal(sanitizeContainerName("moroine/agent-forge"), "agent-moroine-agent-forge");
  assert.equal(sanitizeContainerName("Moroine/Agent-Forge"), "agent-moroine-agent-forge");
  assert.equal(sanitizeContainerName("my.org/my.repo"), "agent-my-org-my-repo");
});
