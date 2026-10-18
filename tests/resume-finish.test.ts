import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdResume } from "../cli/lib/commands/resume.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { cmdFinish } from "../cli/lib/commands/finish.ts";

const BASE = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("resume attaches the task's agent", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  assert.equal(await cmdResume(c, "moroine/agent-forge", "cli"), 0);
  const attach = c.attachCalls[0]?.argv;
  assert.ok(attach, "no attach happened");
  const cwd = attach.indexOf("--cwd");
  assert.equal(attach[cwd + 1], "/workspace/.trees/cli");
  assert.match(attach.at(-1) ?? "", /^exec claude /);
});

test("resume never creates a worktree", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

test("resume runs no host git", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call[0] === "git"));
});

test("resume errors when the worktree is absent, pointing at start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "nope"), /forge start/);
});

test("resume asks for repo then task when both are missing", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], answers: [1, 2] });
  await cmdResume(c, undefined, undefined);
  const attach = c.attachCalls[0]?.argv;
  assert.equal(attach?.[(attach?.indexOf("--cwd") ?? -2) + 1], "/workspace/.trees/docs", `attached to the wrong session: ${attach?.join(" ")}`);
});

test("finish removes the worktree after the pre-flight", async () => {
  const c = fakeContext({
    rules: [
      ...BASE,
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: "" },
      { match: "user.forge.mode", stdout: "supervised" },
    ],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove .trees/cli")));
});

test("finish --force skips the pre-flight and forces the removal", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: " M x\n" }],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove --force .trees/cli")));
});

const FINISH_RULES = [
  ...BASE,
  { match: "test -e", code: 0 },
  { match: "status --porcelain", stdout: "" },
  { match: "user.forge.mode", stdout: "supervised" },
];
const CONTAINER_PREFIX = ["incus", "--project", "agent-forge", "exec", "agent-moroine-agent-forge",
  "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--"];

test("finish keeps the branch, stops the agent, removes the worktree, then moves the transcripts aside", async () => {
  const c = fakeContext({ rules: FINISH_RULES });
  await cmdFinish(c, "moroine/agent-forge", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("branch -D")));
  const pkill = c.calls.findIndex((call) => call.includes("pkill"));
  const remove = c.calls.findIndex((call) => call.join(" ").includes("worktree remove"));
  const aside = c.calls.findIndex((call) => call.includes("sh") && call.join(" ").includes(".finished-"));
  assert.ok(pkill >= 0 && pkill < remove && remove < aside, `order: ${pkill} ${remove} ${aside}`);
  assert.deepEqual(c.calls[pkill], [
    ...CONTAINER_PREFIX, "pkill", "-f", "--", "--remote-control agent-moroine-agent-forge-cli( |$)",
  ]);
  const move = c.calls[aside];
  assert.equal(move.at(-2), "/home/aiuser/.claude/projects/-workspace--trees-cli");
  assert.match(move.at(-1) ?? "", /^\d{8}T\d{6}Z$/);
  assert.ok(c.out_lines.some((l) => l.includes("branch agent/cli retained")));
  assertNoHostGitIn(c.calls, "/workspace");
  assert.ok(!c.calls.some((call) => call[0] === "git"));
});

test("finish succeeds when no agent process was running (pkill exit 1)", async () => {
  const c = fakeContext({ rules: [{ match: "pkill", code: 1 }, ...FINISH_RULES] });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
});

test("finish only warns when moving the transcripts aside fails", async () => {
  const c = fakeContext({ rules: [{ match: ".finished-", code: 1, stderr: "mv: denied" }, ...FINISH_RULES] });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
  assert.ok(c.err_lines.some((l) => /^WARNING: moving the transcripts of cli aside failed: mv: denied/.test(l)),
    `no warning: ${c.err_lines.join(" | ")}`);
  assert.ok(c.out_lines.some((l) => l.includes("Finished task cli")));
});

// Fail-fast : sans mustSucceed, `git worktree remove` pouvait échouer et
// finish annonçait quand même « Finished task cli » en rendant 0.
test("finish fails when the worktree removal fails, and claims nothing", async () => {
  const c = fakeContext({
    rules: [
      { match: "worktree remove", code: 1, stderr: "fatal: '.trees/cli' contains modified files\n" },
      ...BASE,
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: "" },
      { match: "user.forge.mode", stdout: "supervised" },
    ],
  });
  await assert.rejects(
    () => cmdFinish(c, "moroine/agent-forge", "cli", false),
    /git worktree remove failed: fatal: '\.trees\/cli' contains modified files/,
  );
  assert.ok(
    !c.out_lines.some((l) => l.includes("Finished task")),
    `success announced despite the failure: ${c.out_lines.join(" | ")}`,
  );
});

test("resume fails when the container refuses to start", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge start", code: 1, stderr: "Error: Failed to start device\n" },
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) },
      { match: "test -e", code: 0 },
    ],
  });
  await assert.rejects(
    () => cmdResume(c, "moroine/agent-forge", "cli"),
    /incus start failed: Error: Failed to start device/,
  );
  assert.equal(c.attachCalls.length, 0, "attaché malgré l'échec du démarrage");
});

// --- egress hooks ---
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-resume-xdg-"));
function egressFake(opts: { mode: string; version?: string; nic?: "strict" }): FakeIncus {
  const fake = FakeIncus.withRuntime();
  if (opts.version) fake.serverVersion = opts.version;
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  fake.addInstance("agent-forge", "agent-o-r", {
    status: "Stopped", config: { "user.forge.repo": "o/r", "user.forge.egress": opts.mode },
    // Un container strict l'est aussi par sa NIC, pas seulement par son marqueur.
    devices: opts.mode === "strict" || opts.nic === "strict" ? { eth0: STRICT_NIC } : {},
  });
  return fake;
}
const STRICT_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict",
  "security.acls.default.egress.action": "reject", "security.acls.default.ingress.action": "reject",
};
const EG = [{ match: "test -e /workspace/.trees/", code: 0 }];
const lines = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));

test("resume of a strict container checks the gate before starting it", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", version: "7.0.1" }), rules: EG });
  await assert.rejects(() => cmdResume(c, "o/r", "t"), /7\.0\.2/);
  assert.ok(!lines(c).some((l) => / start agent-o-r/.test(l)));
});

test("resume applies the strict settings before attaching", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict" }), rules: EG });
  await cmdResume(c, "o/r", "t");
  const l = lines(c);
  const push = l.findIndex((x) => x.includes("file push") && x.includes("agent-forge-proxy.sh"));
  assert.ok(push >= 0 && push < l.findIndex((x) => x.includes("exec claude")), l.join("\n"));
});

test("resume of a container marked open whose eth0 is still strict is refused before any start", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", nic: "strict" }), rules: EG });
  await assert.rejects(() => cmdResume(c, "o/r", "t"), /eth0 is strict.*forge egress o\/r strict/);
  assert.ok(!lines(c).some((l) => / start agent-o-r|rm -f|exec claude/.test(l)), lines(c).join("\n"));
});

test("resume of a container switched to open clears forge's files before attaching", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open" }), rules: EG });
  await cmdResume(c, "o/r", "t");
  const l = lines(c);
  const rm = l.findIndex((x) => x.includes("rm -f"));
  assert.ok(rm >= 0 && rm < l.findIndex((x) => x.includes("exec claude")), l.join("\n"));
});
