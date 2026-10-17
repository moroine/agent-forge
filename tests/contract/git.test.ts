// Couche 2 : les parsers tournent sur la sortie d'un VRAI git. C'est ici que
// se détecte une dérive entre ce que le code croit et ce que git fait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktreeDirs, parseAgentBranches } from "../../cli/lib/worktrees.ts";

let repo: string;
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

before(() => {
  repo = mkdtempSync(join(tmpdir(), "forge-contract-"));
  git(["init", "-q", "-b", "main", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  git(["branch", "agent/docs"]);
  git(["worktree", "add", "-q", ".trees/cli", "-b", "agent/cli"]);
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("parseWorktreeDirs handles real porcelain stanzas", () => {
  const dirs = parseWorktreeDirs(git(["worktree", "list", "--porcelain"]));
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].endsWith("/.trees/cli"), `got ${dirs[0]}`);
});

test("for-each-ref yields short names, so the strip is correct", () => {
  const raw = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/agent"]);
  // Le contrat exact : `agent/cli`, pas `refs/heads/agent/cli`.
  assert.ok(raw.includes("agent/cli"), `got: ${raw}`);
  assert.ok(!raw.includes("refs/heads/"), `got: ${raw}`);
  assert.deepEqual(parseAgentBranches(raw).sort(), ["cli", "docs"]);
});

test("show-ref --verify --quiet is a usable boolean probe", () => {
  const exists = (ref: string) => {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(exists("refs/heads/agent/cli"), true);
  assert.equal(exists("refs/heads/agent/nope"), false);
});
