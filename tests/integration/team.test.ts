// Layer 3 for the teams (DX 5, part 1b): a small team on a real Incus,
// opt-in, on a disposable Incus.
//
//   FORGE_INTEGRATION=1 node --test tests/integration/team.test.ts
//
// Like provisioning.test.ts it runs against the real `agent-forge` project
// (the team's containers are ordinary forge containers) and needs agent-base
// there. Nothing talks to GitHub: the team's origin mirror is seeded from a
// local repository, and the token is a throwaway string, so a session starts
// (its hc terminal exists) without a model ever answering.
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hcArgv } from "../../cli/lib/hc-session.ts";
import { ENABLED, FORGE, PREFIX, SENTINEL, asAgent, incus, must, raw, run, throwawayXdg } from "./lib.ts";

const PROJECT = "agent-forge";
// `agent-forge-selftest-t-…`: the name prefix the teardown guard recognises.
const TEAM = "forge-selftest-t";
const DEV1 = `agent-${TEAM}-dev-1`;
const DEV2 = `agent-${TEAM}-dev-2`;
const REVIEWER = `agent-${TEAM}-reviewer`;
const NAMES = [DEV1, DEV2, REVIEWER];

const root = ENABLED ? mkdtempSync(join(tmpdir(), "forge-selftest-team-")) : "";
const xdg = ENABLED ? throwawayXdg("forge-selftest-team-xdg-") : "";
const env = {
  FORGE_INCUS_PROJECT: PROJECT,
  FORGE_HOME: join(root, "home"),
  XDG_CONFIG_HOME: xdg,
  FORGE_MIRRORS: join(root, "mirrors"),
  FORGE_WORKSPACES: join(root, "workspaces"),
};
const team = (args: string[], input = "") => run(FORGE, ["team", ...args], { env: { ...env, FORGE_SIDE: "host" }, input, timeout: 1_800_000 });
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hasImage = () => ENABLED && incus(PROJECT, ["image", "info", "agent-base"]).status === 0;

after(() => {
  if (!ENABLED) return;
  // Only ours: the name prefix and the sentinel repository, as the other suites.
  for (const name of NAMES) {
    const repo = incus(PROJECT, ["config", "get", name, "user.forge.repo"]).stdout.trim();
    if (name.startsWith(PREFIX) && repo === SENTINEL) incus(PROJECT, ["delete", name, "--force"]);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
});

test("a small team: converge, assign, publish through the team mirror, read it, refuse a duplicate", { skip: !ENABLED }, (t: TestContext) => {
  if (!hasImage()) return t.skip(`no agent-base in project ${PROJECT} (run 'forge image build')`);

  // The config: the user's own (network address) plus the team.
  const configFile = join(xdg, "agent-forge", "config.json");
  let base: Record<string, unknown> = {};
  try { base = JSON.parse(readFileSync(configFile, "utf8")); } catch { /* no config: the defaults */ }
  writeFileSync(configFile, JSON.stringify({
    ...base,
    teams: {
      [TEAM]: {
        repo: SENTINEL,
        roles: {
          dev: { count: 2, capabilities: ["repo", "publish"] },
          reviewer: { capabilities: ["repo", "read-team"] },
        },
      },
    },
  }));

  // The host: a throwaway token, and the team's origin mirror seeded locally.
  mkdirSync(join(env.FORGE_HOME, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(env.FORGE_HOME, ".config", "agent-forge", "claude-token"), "throwaway-token\n", { mode: 0o600 });
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(["init", "-q", "-b", "main", "."], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "."], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"], seed);
  // The paths forge computes from the environment it is given (this process keeps its own).
  const origin = join(env.FORGE_MIRRORS, `team-${TEAM}.git`);
  const teamMirror = join(env.FORGE_MIRRORS, `team-${TEAM}.agents.git`);
  mkdirSync(env.FORGE_MIRRORS, { recursive: true });
  git(["clone", "-q", "--bare", seed, origin], root);
  git(["--git-dir", origin, "remote", "set-url", "origin", `git@github.com:${SENTINEL}.git`], root);

  must("team converge", team(["converge"]));
  for (const name of NAMES) {
    const keys = incus(PROJECT, ["config", "get", name, "user.forge.team"]).stdout.trim();
    assert.equal(keys, TEAM, `${name} has no team key`);
  }

  // An assignment: a new branch, the keys, a session in the container's own hc.
  must("assign dev-1", team(["assign", DEV1, "it-task"], "Réponds ok."));
  const state = incus(PROJECT, ["config", "get", DEV1, "user.forge.task"]).stdout.trim();
  assert.equal(state, "it-task");
  const session = run("incus", hcArgv(DEV1, ["get", "agent"]).slice(1));
  assert.equal(session.status, 0, raw("hc get agent in dev-1", session));

  // Herdr App's transport, host end: `su - aiuser -c <line>` must reach the same
  // core as the session forge started through `hc run`.
  const viaExec = run(FORGE, ["hc-exec", DEV1, "hc get agent"], { env: { ...env, FORGE_SIDE: "host" } });
  assert.equal(viaExec.status, 0, raw("hc get agent through forge hc-exec", viaExec));
  assert.match(viaExec.stdout, /"agent"|claude/);

  // The developer commits; forge team status brings the branch into the team mirror.
  must("commit in dev-1", asAgent(PROJECT, DEV1, "git -C /workspace commit --allow-empty -q -m integration"));
  must("team status", team(["status"]));
  const published = git(["--git-dir", teamMirror, "rev-parse", "refs/heads/agent/it-task"], root);
  const owned = incus(PROJECT, ["exec", DEV1, "--user", "1001", "--", "git", "-C", "/workspace", "rev-parse", "HEAD"]).stdout.trim();
  assert.equal(published, owned, "the team mirror does not hold the developer's commit");

  // The reviewer reads it, read-only.
  must("reviewer fetches the team", asAgent(PROJECT, REVIEWER, "git -C /workspace fetch team"));
  const remote = must("reviewer's remote branches", asAgent(PROJECT, REVIEWER, "git -C /workspace branch -r")).stdout;
  assert.match(remote, /team\/agent\/it-task/);
  assert.notEqual(asAgent(PROJECT, REVIEWER, "git -C /workspace push team HEAD:refs/heads/x").status, 0, "the team remote must be read-only");

  // One task name, one developer.
  const duplicate = team(["assign", DEV2, "it-task"], "Même nom.");
  assert.notEqual(duplicate.status, 0, raw("the duplicate was accepted", duplicate));
  assert.match(duplicate.stderr, new RegExp(`owned by ${DEV1}`));

  // Release, then assign again: the branch is checked out again.
  must("release dev-1", team(["release", DEV1]));
  must("move away", asAgent(PROJECT, DEV1, "git -C /workspace switch -q --detach"));
  must("assign dev-1 again", team(["assign", DEV1, "it-task"], "Reprends."));
  const head = must("branch of dev-1", asAgent(PROJECT, DEV1, "git -C /workspace rev-parse --abbrev-ref HEAD")).stdout.trim();
  assert.equal(head, "agent/it-task");
});
