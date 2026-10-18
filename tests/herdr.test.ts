// Unit tests for the herdr CLI layer, against canned herdr 0.9.5 answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  herdrEnv, listWorkspaces, createWorkspace, listTabs, listPanes, createTab,
  renameTab, focusTab, closeTab, paneRun, paneForeground, classifyPane,
} from "../cli/lib/herdr.ts";

const h = { bin: "/x/herdr", popup: false };

test("herdrEnv reads the herdr session variables", () => {
  assert.deepEqual(herdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "/x" }), { bin: "/x", popup: true });
  assert.deepEqual(herdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "/x", HERDR_PANE_ID: "w1:p1" }), { bin: "/x", popup: false });
  assert.equal(herdrEnv({ HERDR_BIN_PATH: "/x" }), null);
  assert.equal(herdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "" }), null);
});

test("listWorkspaces", async () => {
  const ctx = fakeContext({ rules: [{ match: "workspace list", stdout: JSON.stringify({ id: "x", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "o/r", focused: true }] } }) }] });
  assert.deepEqual(await listWorkspaces(ctx, h), [{ id: "w1", label: "o/r" }]);
  assert.deepEqual(ctx.calls[0], ["/x/herdr", "workspace", "list"]);
});

test("createWorkspace", async () => {
  const ctx = fakeContext({ rules: [{ match: "workspace create", stdout: JSON.stringify({ result: { workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } } }) }] });
  assert.deepEqual(await createWorkspace(ctx, h, "o/r", "/home/f"), { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" });
  assert.deepEqual(ctx.calls[0], ["/x/herdr", "workspace", "create", "--label", "o/r", "--cwd", "/home/f", "--focus"]);
});

test("listTabs and listPanes", async () => {
  const ctx = fakeContext({ rules: [
    { match: "tab list", stdout: JSON.stringify({ result: { tabs: [{ tab_id: "w1:t1", label: "cli", workspace_id: "w1" }] } }) },
    { match: "pane list", stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] } }) },
  ] });
  assert.deepEqual(await listTabs(ctx, h), [{ id: "w1:t1", label: "cli", workspaceId: "w1" }]);
  assert.deepEqual(await listPanes(ctx, h), [{ id: "w1:p1", tabId: "w1:t1" }]);
  assert.deepEqual(ctx.calls, [["/x/herdr", "tab", "list"], ["/x/herdr", "pane", "list"]]);
});

test("createTab", async () => {
  const ctx = fakeContext({ rules: [{ match: "tab create", stdout: JSON.stringify({ result: { tab: { tab_id: "w2:t2" }, root_pane: { pane_id: "w2:p2" } } }) }] });
  assert.deepEqual(await createTab(ctx, h, "w2", "task", "/home/f"), { tabId: "w2:t2", paneId: "w2:p2" });
  assert.deepEqual(ctx.calls[0], ["/x/herdr", "tab", "create", "--workspace", "w2", "--label", "task", "--cwd", "/home/f", "--focus"]);
});

test("acks: rename, focus, close, pane run", async () => {
  const ctx = fakeContext({ rules: [{ match: "herdr", stdout: '{"id":"a","result":{"type":"ok"}}' }] });
  await renameTab(ctx, h, "w1:t1", "new");
  await focusTab(ctx, h, "w1:t1");
  await closeTab(ctx, h, "w1:t1");
  await paneRun(ctx, h, "w1:p1", "exec sleep 1");
  assert.deepEqual(ctx.calls, [
    ["/x/herdr", "tab", "rename", "w1:t1", "new"],
    ["/x/herdr", "tab", "focus", "w1:t1"],
    ["/x/herdr", "tab", "close", "w1:t1"],
    ["/x/herdr", "pane", "run", "w1:p1", "exec sleep 1"],
  ]);
});

test("an ack with an empty answer succeeds (real herdr prints nothing for pane run)", async () => {
  const ctx = fakeContext({ rules: [{ match: "pane run", stdout: "" }] });
  await paneRun(ctx, h, "w1:p1", "ls");
  const bad = fakeContext({ rules: [{ match: "pane run", stdout: '{"error":{"message":"no pane"}}' }] });
  await assert.rejects(paneRun(bad, h, "w1:p1", "ls"), /pane run w1:p1 ls failed: no pane/);
});

test("paneForeground", async () => {
  const ctx = fakeContext({ rules: [{ match: "process-info", stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ["sleep", "30"] }, { argv: ["-zsh"] }] } } }) }] });
  assert.deepEqual(await paneForeground(ctx, h, "w1:p1"), [["sleep", "30"], ["-zsh"]]);
  assert.deepEqual(ctx.calls[0], ["/x/herdr", "pane", "process-info", "--pane", "w1:p1"]);
});

test("a failing herdr call quotes stderr, or stdout when stderr is empty", async () => {
  const a = fakeContext({ rules: [{ match: "tab create", code: 1, stderr: " bad things \n" }] });
  await assert.rejects(createTab(a, h, "w", "l", "/c"), /herdr tab create --workspace w .* failed: bad things$/);
  const b = fakeContext({ rules: [{ match: "tab create", code: 1, stdout: "from stdout" }] });
  await assert.rejects(createTab(b, h, "w", "l", "/c"), /herdr tab create .* failed: from stdout$/);
});

test("an unreadable answer names the command and quotes the output", async () => {
  const ctx = fakeContext({ rules: [{ match: "workspace list", stdout: "not json\n" }] });
  await assert.rejects(listWorkspaces(ctx, h), /herdr workspace list: unreadable answer: not json/);
});

test("an error object fails with its message", async () => {
  const ctx = fakeContext({ rules: [{ match: "workspace list", stdout: '{"error":{"code":"x","message":"boom"}}' }] });
  await assert.rejects(listWorkspaces(ctx, h), /herdr workspace list failed: boom/);
});

test("a missing field is an unreadable answer, not a TypeError", async () => {
  const ctx = fakeContext({ rules: [{ match: "workspace list", stdout: '{"result":{"workspaces":[{"label":"x"}]}}' }] });
  await assert.rejects(listWorkspaces(ctx, h), /unreadable answer/);
  const ctx2 = fakeContext({ rules: [{ match: "workspace list", stdout: '{"result":{}}' }] });
  await assert.rejects(listWorkspaces(ctx2, h), /unreadable answer/);
});

test("classifyPane", () => {
  const live = [["node", "/opt/agent-forge/current/cli/forge.ts", "attach", "agent-x", "cli"]];
  assert.equal(classifyPane(live, "agent-x", "cli"), "live");
  assert.equal(classifyPane(live, "agent-x", "docs"), "busy");
  assert.equal(classifyPane([["-bash"]], "agent-x", "cli"), "shell");
  assert.equal(classifyPane([["/usr/bin/zsh"]], "agent-x", "cli"), "shell");
  assert.equal(classifyPane([["vim", "x"]], "agent-x", "cli"), "busy");
  assert.equal(classifyPane([], "agent-x", "cli"), "busy");
});
