// Couche 2 : les parsers tournent sur la sortie d'un VRAI git. C'est ici que
// se détecte une dérive entre ce que le code croit et ce que git fait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktreeDirs, parseAgentBranches } from "../../scripts/lib/worktrees.ts";

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

// Le mécanisme NOUVEAU du modèle container-par-tâche : `finish` retire la
// worktree depuis le git host (souvent le template), c'est-à-dire depuis un
// processus dont le cwd n'est ni la worktree ni le clone principal. Le
// montage hôte est partagé, donc git voit les mêmes fichiers — mais rien ne
// le prouvait contre un vrai git. La commande exacte de finish.ts est
// `git -C /workspace worktree remove .trees/<task>` : le chemin est RELATIF
// et ne doit se résoudre que grâce à `-C`.
test("worktree remove works driven from a third directory, with a -C-relative path", () => {
  const outside = mkdtempSync(join(tmpdir(), "forge-contract-outside-"));
  try {
    git(["worktree", "add", "-q", ".trees/api", "-b", "agent/api"]);
    const tree = join(repo, ".trees", "api");
    const admin = join(repo, ".git", "worktrees", "api");
    assert.ok(existsSync(tree));
    assert.ok(existsSync(admin));

    // cwd = ni la worktree, ni le clone : exactement la position du template.
    execFileSync("git", ["-C", repo, "worktree", "remove", ".trees/api"], { cwd: outside });

    assert.equal(existsSync(tree), false, "le répertoire de la worktree doit disparaître");
    assert.equal(existsSync(admin), false, ".git/worktrees/api doit disparaître, sans prune");
    // La branche survit : `finish` la conserve délibérément.
    assert.ok(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/agent"]).includes("agent/api"));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
