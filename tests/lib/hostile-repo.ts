// Fixtures for the container-escape tests: a git repository set up the way a
// compromised agent could leave /workspace, i.e. every place where git runs a
// command found in the repository's own configuration or hooks. Each planted
// command touches `marker`, so a test can tell whether git ran any of them.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTILE_HOOKS = ["reference-transaction", "post-checkout", "pre-push"];

// POSIX single quoting, safe for any path.
const sq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

// Writes the marker whatever extra arguments git appends to the command.
const touchCommand = (marker: string): string => `sh -c ${sq(`touch ${sq(marker)}`)} --`;

export function hostileConfig(marker: string): [string, string][] {
  const cmd = touchCommand(marker);
  return [
    ["core.fsmonitor", cmd],
    ["core.sshCommand", cmd],
    ["core.askPass", cmd],
    ["credential.helper", `!${cmd}`],
    ["uploadpack.packObjectsHook", cmd],
  ];
}

export function hookScript(marker: string): string {
  return `#!/bin/sh\ntouch ${sq(marker)}\n`;
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

// Builds the repository at `dir` (which must not exist yet or be empty).
// `canary` is an existing file the repository's FETCH_HEAD points at: a git
// fetch run inside would write through the symlink and change it.
export function makeHostileRepo(dir: string, marker: string, canary: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", "init"]);

  for (const [key, value] of hostileConfig(marker)) git(dir, ["config", key, value]);

  const hooksPath = join(dir, ".hostile-hooks");
  for (const hooks of [hooksPath, join(dir, ".git", "hooks")]) {
    mkdirSync(hooks, { recursive: true });
    for (const name of HOSTILE_HOOKS) {
      const file = join(hooks, name);
      writeFileSync(file, hookScript(marker));
      chmodSync(file, 0o755);
    }
  }
  git(dir, ["config", "core.hooksPath", hooksPath]);

  // A local bare remote whose upload-pack is a wrapper that touches the marker.
  const remote = join(dir, ".hostile-remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
  git(dir, ["config", "remote.origin.url", remote]);
  git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(dir, ["config", "remote.origin.uploadpack",
    `sh -c ${sq(`touch ${sq(marker)}; exec git-upload-pack "$@"`)} --`]);

  symlinkSync(canary, join(dir, ".git", "FETCH_HEAD"));
}
