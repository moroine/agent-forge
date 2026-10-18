// Layer 2: real git. The dev machine's fetch goes through
// remote.<c>.uploadpack = "forge upload-pack <c>"; this proves git calls that
// program the way forge expects (argv: upload-pack <c> <url path>) and that
// the protocol flows through whatever the program execs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
const git = (args: string[], cwd: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

before(() => { root = mkdtempSync(join(tmpdir(), "forge-retrieval-")); });
after(() => rmSync(root, { recursive: true, force: true }));

test("git fetch runs the configured uploadpack program and reads the repository it serves", () => {
  // A clean "server" repository with one commit on agent/t.
  const server = join(root, "server");
  mkdirSync(server);
  git(["init", "-q", "-b", "agent/t", "."], server);
  git(["commit", "-q", "--allow-empty", "-m", "work"], server);

  // Stand-in for forge: record argv one per line, then serve the server repo.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const record = join(root, "argv.txt");
  const script = join(bin, "forge");
  writeFileSync(script,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\nexec git-upload-pack '${server}'\n`);
  chmodSync(script, 0o755);

  // Client: the remote URL is an existing empty directory.
  const client = join(root, "client");
  const url = join(root, "empty");
  mkdirSync(client);
  mkdirSync(url);
  git(["init", "-q", "."], client);
  git(["remote", "add", "agent-x", url], client);
  git(["config", "remote.agent-x.uploadpack", `${script} upload-pack agent-x`], client);

  git(["fetch", "-q", "agent-x"], client);

  git(["rev-parse", "--verify", "refs/remotes/agent-x/agent/t"], client);
  assert.deepEqual(readFileSync(record, "utf8").trimEnd().split("\n"), ["upload-pack", "agent-x", url]);
});
