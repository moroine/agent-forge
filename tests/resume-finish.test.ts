import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdResume } from "../cli/lib/commands/resume.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdFinish } from "../cli/lib/commands/finish.ts";

const BASE = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("resume attaches the task's tmux session", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  assert.equal(await cmdResume(c, "moroine/agent-forge", "cli"), 0);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach, "no attach happened");
  assert.ok(attach.includes("new-session") && attach.includes("cli"));
});

test("resume never creates a worktree", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

test("resume errors when the worktree is absent, pointing at start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "nope"), /forge start/);
});

test("resume asks for repo then task when both are missing", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], answers: [1, 2] });
  await cmdResume(c, undefined, undefined);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach?.includes("docs"), `attached to the wrong session: ${attach?.join(" ")}`);
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

test("finish keeps the branch and kills the session", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: "" }, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await cmdFinish(c, "moroine/agent-forge", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("branch -D")));
  assert.ok(c.calls.some((call) => call.join(" ").includes("kill-session -t cli")));
  assert.ok(c.out_lines.some((l) => l.includes("branch agent/cli retained")));
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
  assert.ok(!c.calls.some((call) => call.includes("tmux")), "attaché malgré l'échec du démarrage");
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
  assert.ok(push >= 0 && push < l.findIndex((x) => x.includes("tmux")), l.join("\n"));
});

test("resume d'un container marqué open dont la NIC est restée stricte : refusé avant tout démarrage", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", nic: "strict" }), rules: EG });
  await assert.rejects(() => cmdResume(c, "o/r", "t"), /eth0 is strict.*forge egress o\/r strict/);
  assert.ok(!lines(c).some((l) => / start agent-o-r|rm -f|tmux/.test(l)), lines(c).join("\n"));
});

test("resume of a container switched to open clears forge's files before attaching", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open" }), rules: EG });
  await cmdResume(c, "o/r", "t");
  const l = lines(c);
  const rm = l.findIndex((x) => x.includes("rm -f"));
  assert.ok(rm >= 0 && rm < l.findIndex((x) => x.includes("tmux")), l.join("\n"));
});
