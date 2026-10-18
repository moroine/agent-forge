// Opening a task inside herdr: the spec's table, against canned herdr answers.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { attachCommand, findTaskTab, openTask, runTask, shellQuote } from "../cli/lib/tabs.ts";

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

test("runTask outside herdr makes no herdr call", async () => {
  const c = fakeContext();
  assert.equal(await runTask(c, T), 0);
  assert.ok(c.calls.every((a) => a[0] !== "/h/herdr"));
  assert.ok(c.err_lines.includes("outside herdr: the agent stops when this terminal closes"));
});
