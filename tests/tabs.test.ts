// Opening a task inside herdr: the spec's table, against canned herdr answers.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { attachCommand, closeBareTab, findTaskTab, openTask, resumeAll, runTask, shellQuote } from "../cli/lib/tabs.ts";

const h = { bin: "/h/herdr", popup: false };
const T = { container: "agent-x", ownerRepo: "o/r", task: "cli" };
const CMD = "exec env HERDR_AGENT=claude '/usr/local/bin/forge' attach agent-x cli";

const saved = { as: process.env.FORGE_INVOKED_AS, home: process.env.FORGE_HOME };
process.env.FORGE_INVOKED_AS = "/usr/local/bin/forge";
process.env.FORGE_HOME = "/home/f";
afterEach(() => {
  process.env.FORGE_INVOKED_AS = "/usr/local/bin/forge";
  process.env.FORGE_HOME = "/home/f";
});
process.on("exit", () => {
  for (const [k, v] of [["FORGE_INVOKED_AS", saved.as], ["FORGE_HOME", saved.home]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const j = (result: unknown) => JSON.stringify({ id: "x", result });
const ws = (...w: [string, string][]) =>
  ({ match: "/h/herdr workspace list", stdout: j({ workspaces: w.map(([id, label]) => ({ workspace_id: id, label })) }) });
const tabs = (...t: [string, string, string][]) =>
  ({ match: "/h/herdr tab list", stdout: j({ tabs: t.map(([id, label, w]) => ({ tab_id: id, label, workspace_id: w })) }) });
const panes = (...p: [string, string][]) =>
  ({ match: "/h/herdr pane list", stdout: j({ panes: p.map(([id, tab]) => ({ pane_id: id, tab_id: tab })) }) });
const fg = (pane: string, ...argvs: string[][]): ExecRule =>
  ({ match: `/h/herdr pane process-info --pane ${pane}`, stdout: j({ process_info: { foreground_processes: argvs.map((argv) => ({ argv })) } }) });
const agent = (running: boolean): ExecRule =>
  ({ match: "ps -u 1001 -o args=", stdout: running ? "claude --remote-control agent-x-cli\n" : "" });

const herdrCalls = (c: { calls: string[][] }) => c.calls.filter((a) => a[0] === "/h/herdr").map((a) => a.slice(1).join(" "));
const has = (c: { calls: string[][] }, sub: string) => herdrCalls(c).some((l) => l.includes(sub));

test("the typed command is exact and quoted", () => {
  assert.equal(attachCommand("agent-x", "cli"), CMD);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("no agent, no workspace: creates the workspace, renames its tab, runs in its root pane", async () => {
  const c = fakeContext({ rules: [
    agent(false), ws(), tabs(), panes(),
    { match: "/h/herdr workspace create", stdout: j({ workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } }) },
  ] });
  assert.equal(await openTask(c, h, T), 0);
  assert.deepEqual(herdrCalls(c).slice(3), [
    "workspace create --label o/r --cwd /home/f --focus",
    "tab rename w2:t1 cli",
    `pane run w2:p1 ${CMD}`,
  ]);
  assert.ok(!has(c, "tab create"));
  assert.ok(c.err_lines.includes("Opened o/r cli in herdr.") || c.out_lines.includes("Opened o/r cli in herdr."));
});

test("no agent, workspace without the tab: creates the tab and runs in it", async () => {
  const c = fakeContext({ rules: [
    agent(false), ws(["w1", "o/r"]), tabs(["w1:t1", "other", "w1"]), panes(["w1:p1", "w1:t1"]),
    { match: "/h/herdr tab create", stdout: j({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }) },
  ] });
  assert.equal(await openTask(c, h, T), 0);
  assert.deepEqual(herdrCalls(c).slice(3), [
    "tab create --workspace w1 --label cli --cwd /home/f --focus",
    `pane run w1:p2 ${CMD}`,
  ]);
  assert.ok(!has(c, "workspace create"));
});

test("no agent, tab with a bare shell: runs in its pane then focuses it", async () => {
  const c = fakeContext({ rules: [
    agent(false), ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]), fg("w1:p1", ["-zsh"]),
  ] });
  assert.equal(await openTask(c, h, T), 0);
  const l = herdrCalls(c);
  assert.deepEqual(l.slice(-2), [`pane run w1:p1 ${CMD}`, "tab focus w1:t1"]);
  assert.ok(!has(c, "tab create"));
});

test("no agent, tab busy: refuses and runs nothing", async () => {
  const c = fakeContext({ rules: [
    agent(false), ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]), fg("w1:p1", ["vim", "x"]),
  ] });
  await assert.rejects(openTask(c, h, T), /herdr tab cli in o\/r is busy \(it runs vim\): close it or free its shell, then run this again\./);
  assert.ok(!has(c, "pane run"));
});

test("agent running, live tab: only focuses", async () => {
  const c = fakeContext({ rules: [
    agent(true), ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]),
    fg("w1:p1", ["forge", "attach", "agent-x", "cli"]),
  ] });
  assert.equal(await openTask(c, h, T), 0);
  assert.ok(!has(c, "pane run"));
  assert.equal(herdrCalls(c).at(-1), "tab focus w1:t1");
  assert.ok([...c.err_lines, ...c.out_lines].includes("Focused o/r cli in herdr."));
});

test("agent running, no tab or a bare tab: refuses a second agent", async () => {
  const none = fakeContext({ rules: [agent(true), ws(["w1", "o/r"]), tabs(), panes()] });
  await assert.rejects(openTask(none, h, T), /already runs outside this herdr/);
  assert.ok(!has(none, "pane run") && !has(none, "tab create"));
  const bare = fakeContext({ rules: [
    agent(true), ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]), fg("w1:p1", ["bash"]),
  ] });
  await assert.rejects(openTask(bare, h, T), /the agent for cli already runs outside this herdr \(another terminal\?\): stop it there first\./);
  assert.ok(!has(bare, "pane run"));
});

test("a repo typed in another case reuses the existing workspace", async () => {
  const c = fakeContext({ rules: [
    agent(false), ws(["w1", "Moroine/Agent-Forge"]), tabs(), panes(),
    { match: "/h/herdr tab create", stdout: j({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }) },
  ] });
  await openTask(c, h, { ...T, ownerRepo: "moroine/agent-forge" });
  assert.ok(!has(c, "workspace create"));
  assert.ok(has(c, "tab create --workspace w1"));
});

test("several workspaces with the label: the first is used and stderr says so", async () => {
  const c = fakeContext({ rules: [
    ws(["w1", "o/r"], ["w2", "o/r"]), tabs(["w2:t1", "cli", "w2"]), panes(["w2:p1", "w2:t1"]),
  ] });
  const r = await findTaskTab(c, h, "o/r", "cli");
  assert.equal(r.workspace?.id, "w1");
  assert.equal(r.tab, null);
  assert.deepEqual(r.panes, []);
  assert.ok(c.err_lines.includes("several herdr workspaces are labelled o/r; using the first"));
});

test("findTaskTab returns the tab's panes", async () => {
  const c = fakeContext({ rules: [
    ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"], ["w1:p9", "w1:t9"]),
  ] });
  const r = await findTaskTab(c, h, "o/r", "cli");
  assert.equal(r.tab?.id, "w1:t1");
  assert.deepEqual(r.panes, [{ id: "w1:p1", tabId: "w1:t1" }]);
});

const wt = (...tasks: string[]) =>
  `worktree /workspace\n${tasks.map((t) => `worktree /workspace/.trees/${t}\n`).join("")}`;
const psOf = (container: string, stdout: string): ExecRule =>
  ({ match: `exec ${container} --user 1001 --group 1001 --env HOME=/home/aiuser -- ps -u 1001`, stdout });
const worktreesOf = (container: string, ...tasks: string[]): ExecRule =>
  ({ match: `exec ${container} -- su - aiuser -c cd /workspace && git worktree list`, stdout: wt(...tasks) });
const resumeRules = (): ExecRule[] => [
  { match: "incus --project agent-forge list", stdout: JSON.stringify([
    { name: "agent-r", status: "Running" }, { name: "agent-s", status: "Stopped" },
  ]) },
  { match: "agent-r user.forge.repo", stdout: "o/r" },
  { match: "agent-s user.forge.repo", stdout: "o/s" },
  worktreesOf("agent-r", "cli", "docs", "api"), worktreesOf("agent-s", "x"),
  psOf("agent-r", "claude --remote-control agent-r-api\n"), psOf("agent-s", ""),
  ws(["w1", "o/r"], ["w2", "O/S"], ["w3", "misc"]),
  tabs(
    ["w1:t1", "cli", "w1"], ["w1:t2", "docs", "w1"], ["w1:t3", "api", "w1"], ["w1:t4", "notes", "w1"],
    ["w2:t1", "x", "w2"], ["w3:t1", "cli", "w3"],
  ),
  panes(["w1:p1", "w1:t1"], ["w1:p2", "w1:t2"], ["w1:p3", "w1:t3"], ["w1:p4", "w1:t4"], ["w2:p1", "w2:t1"], ["w3:p1", "w3:t1"]),
  fg("w1:p1", ["-zsh"]), fg("w1:p2", ["forge", "attach", "agent-r", "docs"]), fg("w1:p3", ["bash"]),
  fg("w2:p1", ["vim", "x"]),
];

test("resumeAll relaunches bare forge tabs and reports the others", async () => {
  const c = fakeContext({ rules: resumeRules() });
  assert.equal(await resumeAll(c, h), 0);
  assert.deepEqual(c.out_lines, [
    "o/r cli: resumed",
    "o/r docs: already running",
    "o/r api: skipped (agent runs outside this herdr)",
    "o/s x: skipped (tab is busy)",
  ]);
  const runs = herdrCalls(c).filter((l) => l.startsWith("pane run"));
  assert.deepEqual(runs, [`pane run w1:p1 ${attachCommand("agent-r", "cli")}`]);
  // a stopped container is started before its tasks are listed
  const start = c.calls.findIndex((a) => a.join(" ").includes("incus --project agent-forge start agent-s"));
  const list = c.calls.findIndex((a) => a.join(" ").includes("exec agent-s -- su - aiuser -c cd /workspace"));
  assert.ok(start >= 0 && start < list, `order: ${start} ${list}`);
  // the non-forge workspace and the non-task tab are never inspected
  assert.ok(!has(c, "pane process-info --pane w3:p1"));
  assert.ok(!has(c, "pane process-info --pane w1:p4"));
});

test("resumeAll says so when nothing is to resume", async () => {
  const c = fakeContext({ rules: [...resumeRules().slice(0, 2), ws(["w3", "misc"]), tabs(), panes()] });
  assert.equal(await resumeAll(c, h), 0);
  assert.deepEqual(c.out_lines, ["no forge tab to resume."]);
});

test("resumeAll keeps a herdr popup open on its result lines", async () => {
  const some = fakeContext({ rules: resumeRules() });
  await resumeAll(some, h);
  assert.equal(some.attentions, 1);
  const none = fakeContext({ rules: [...resumeRules().slice(0, 2), ws(["w3", "misc"]), tabs(), panes()] });
  await resumeAll(none, h);
  assert.equal(none.attentions, 1);
});

test("resumeAll reports a container that does not start and goes on", async () => {
  const c = fakeContext({ rules: [
    { match: "incus --project agent-forge start agent-s", code: 1, stderr: "Error: no space" },
    ...resumeRules(),
  ] });
  await resumeAll(c, h);
  assert.ok(c.out_lines.includes("o/s: skipped (container did not start: incus start failed: Error: no space)"),
    c.out_lines.join(" | "));
  assert.ok(c.out_lines.includes("o/r cli: resumed"));
});

// One agent per task at most, however many tabs carry its label.
const oneRepo = (...extra: ExecRule[]): ExecRule[] => [
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-r", status: "Running" }]) },
  { match: "agent-r user.forge.repo", stdout: "o/r" },
  worktreesOf("agent-r", "cli"), psOf("agent-r", ""),
  ...extra,
];
const runsOf = (c: { calls: string[][] }) => herdrCalls(c).filter((l) => l.startsWith("pane run"));

test("resumeAll launches one agent for two bare tabs with the same task label", async () => {
  const c = fakeContext({ rules: oneRepo(
    ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"], ["w1:t2", "cli", "w1"]),
    panes(["w1:p1", "w1:t1"], ["w1:p2", "w1:t2"]), fg("w1:p1", ["-zsh"]), fg("w1:p2", ["bash"]),
  ) });
  await resumeAll(c, h);
  assert.deepEqual(c.out_lines, ["o/r cli: resumed", "o/r cli: skipped (duplicate tab)"]);
  assert.deepEqual(runsOf(c), [`pane run w1:p1 ${attachCommand("agent-r", "cli")}`]);
});

test("resumeAll launches one agent when two workspaces differ only by case", async () => {
  const c = fakeContext({ rules: oneRepo(
    ws(["w1", "o/r"], ["w2", "O/R"]), tabs(["w1:t1", "cli", "w1"], ["w2:t1", "cli", "w2"]),
    panes(["w1:p1", "w1:t1"], ["w2:p1", "w2:t1"]), fg("w1:p1", ["-zsh"]), fg("w2:p1", ["-zsh"]),
  ) });
  await resumeAll(c, h);
  assert.equal(runsOf(c).length, 1, runsOf(c).join(" | "));
  assert.deepEqual(c.out_lines, ["o/r cli: resumed", "o/r cli: skipped (duplicate tab)"]);
});

test("resumeAll never types into a second tab of a task already live", async () => {
  const c = fakeContext({ rules: oneRepo(
    ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"], ["w1:t2", "cli", "w1"]),
    panes(["w1:p1", "w1:t1"], ["w1:p2", "w1:t2"]),
    fg("w1:p1", ["forge", "attach", "agent-r", "cli"]), fg("w1:p2", ["-zsh"]),
  ) });
  await resumeAll(c, h);
  assert.deepEqual(c.out_lines, ["o/r cli: already running", "o/r cli: skipped (duplicate tab)"]);
  assert.deepEqual(runsOf(c), []);
});

test("closeBareTab closes a bare tab only", async () => {
  const bare = fakeContext({ rules: [ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]), fg("w1:p1", ["-zsh"])] });
  await closeBareTab(bare, h, T);
  assert.equal(herdrCalls(bare).at(-1), "tab close w1:t1");
  for (const argv of [["forge", "attach", "agent-x", "cli"], ["vim", "x"]]) {
    const c = fakeContext({ rules: [ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"]), fg("w1:p1", argv)] });
    await closeBareTab(c, h, T);
    assert.ok(!has(c, "tab close"));
  }
  const none = fakeContext({ rules: [ws(["w1", "o/r"]), tabs(), panes()] });
  await closeBareTab(none, h, T);
  assert.ok(!has(none, "tab close"));
});

test("closeBareTab on a split tab closes it only when every pane is a bare shell", async () => {
  const split = (second: string[]) => fakeContext({ rules: [
    ws(["w1", "o/r"]), tabs(["w1:t1", "cli", "w1"]), panes(["w1:p1", "w1:t1"], ["w1:p2", "w1:t1"]),
    fg("w1:p1", ["-zsh"]), fg("w1:p2", second),
  ] });
  const live = split(["forge", "attach", "agent-x", "cli"]);
  await closeBareTab(live, h, T);
  assert.ok(!has(live, "tab close"));
  const busy = split(["vim", "x"]);
  await closeBareTab(busy, h, T);
  assert.ok(!has(busy, "tab close"));
  const shells = split(["bash"]);
  await closeBareTab(shells, h, T);
  assert.equal(herdrCalls(shells).at(-1), "tab close w1:t1");
});

test("runTask outside herdr refuses a second agent and attaches nothing", async () => {
  const c = fakeContext({ rules: [agent(true)] });
  await assert.rejects(runTask(c, T),
    /the agent for cli already runs in agent-x \(in a herdr tab, or another terminal\): attach to it there, or stop it first with 'forge stop o\/r'\./);
  assert.equal(c.attachCalls.length, 0);
});

test("runTask outside herdr fails closed when the probe fails", async () => {
  const c = fakeContext({ rules: [{ match: "ps -u 1001 -o args=", code: 1, stderr: "boom" }] });
  await assert.rejects(runTask(c, T), /cannot check whether the agent for cli already runs in agent-x: ps failed: boom/);
  assert.equal(c.attachCalls.length, 0);
});

test("runTask outside herdr makes no herdr call", async () => {
  const c = fakeContext();
  assert.equal(await runTask(c, T), 0);
  assert.ok(c.calls.every((a) => a[0] !== "/h/herdr"));
  assert.ok(c.err_lines.includes("outside herdr: the agent stops when this terminal closes"));
});
