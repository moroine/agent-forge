import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdResume } from "../cli/lib/commands/resume.ts";
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

test("resume outside herdr refuses while the task's agent already runs", async () => {
  const c = fakeContext({ rules: [
    { match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-moroine-agent-forge-cli\n" },
    ...BASE, { match: "test -e", code: 0 },
  ] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "cli"),
    /the agent for cli already runs in agent-moroine-agent-forge .*'forge stop moroine\/agent-forge'\./);
  assert.equal(c.attachCalls.length, 0);
});

test("resume outside herdr fails closed when the agent probe fails", async () => {
  const c = fakeContext({ rules: [
    { match: "ps -u 1001 -o args=", code: 1, stderr: "Error: Instance is not running" },
    ...BASE, { match: "test -e", code: 0 },
  ] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "cli"),
    /cannot check whether the agent for cli already runs in agent-moroine-agent-forge: ps failed: Error: Instance is not running/);
  assert.equal(c.attachCalls.length, 0);
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

test("resume --all outside herdr is refused", async () => {
  const c = fakeContext();
  await assert.rejects(() => cmdResume(c, undefined, undefined, true), /resume --all only works inside herdr/);
});

test("resume --all with a repo or a task is a usage error", async () => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/h/herdr";
  try {
    const c = fakeContext();
    await assert.rejects(() => cmdResume(c, "moroine/agent-forge", undefined, true), /Usage: forge resume/);
    await assert.rejects(() => cmdResume(c, undefined, "cli", true), /Usage: forge resume/);
  } finally {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_BIN_PATH;
  }
});

const j = (result: unknown) => JSON.stringify({ id: "x", result });
const HERDR_RULES = (fgArgv: string[]) => [
  { match: "/h/herdr workspace list", stdout: j({ workspaces: [{ workspace_id: "w1", label: "moroine/agent-forge" }] }) },
  { match: "/h/herdr tab list", stdout: j({ tabs: [{ tab_id: "w1:t1", label: "cli", workspace_id: "w1" }] }) },
  { match: "/h/herdr pane list", stdout: j({ panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] }) },
  { match: "/h/herdr pane process-info", stdout: j({ process_info: { foreground_processes: [{ argv: fgArgv }] } }) },
];

async function finishInHerdr(fgArgv: string[]) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/h/herdr";
  try {
    const c = fakeContext({ rules: [...HERDR_RULES(fgArgv), ...FINISH_RULES] });
    await cmdFinish(c, "moroine/agent-forge", "cli", false);
    return c;
  } finally {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_BIN_PATH;
  }
}

test("finish closes the task's tab when it is a bare shell, inside herdr", async () => {
  const c = await finishInHerdr(["-zsh"]);
  const aside = c.calls.findIndex((call) => call.includes("sh") && call.join(" ").includes(".finished-"));
  const close = c.calls.findIndex((call) => call.join(" ").includes("/h/herdr tab close w1:t1"));
  assert.ok(aside >= 0 && close > aside, `order: ${aside} ${close}`);
});

test("finish leaves a live tab open", async () => {
  const c = await finishInHerdr(["forge", "attach", "agent-moroine-agent-forge", "cli"]);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("tab close")));
});

test("finish only warns when the herdr cleanup fails", async () => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/h/herdr";
  try {
    const c = fakeContext({ rules: [
      { match: "/h/herdr workspace list", code: 1, stderr: "server down" },
      ...FINISH_RULES,
    ] });
    assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
    assert.ok(c.err_lines.some((l) => l.startsWith("WARNING: closing the herdr tab of cli failed:")), c.err_lines.join(" | "));
    assert.ok(c.out_lines.some((l) => l.includes("Finished task cli")));
  } finally {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_BIN_PATH;
  }
});

test("finish makes no herdr call outside herdr", async () => {
  const c = fakeContext({ rules: [...HERDR_RULES(["-zsh"]), ...FINISH_RULES] });
  await cmdFinish(c, "moroine/agent-forge", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("herdr")));
});
