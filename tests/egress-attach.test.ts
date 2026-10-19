// Sub-project 3's egress hooks on sub-project 4's paths to the agent. Every
// start goes through ensureRunning (the version gate, the marker/NIC check,
// the proxy), every agent through attachTask (the strict settings follow the
// mode): forge attach, herdr tabs and resume --all never pass through
// start/resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { attachTask, ensureRunning } from "../cli/lib/session.ts";
import { cmdAttach } from "../cli/lib/commands/attach.ts";
import { resumeAll } from "../cli/lib/tabs.ts";

// The proxy plan comes from the user's config: never the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-egress-attach-xdg-"));

const STRICT_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict",
  "security.acls.default.egress.action": "reject", "security.acls.default.ingress.action": "reject",
};

type Status = "Running" | "Stopped";

function egressFake(opts: {
  mode?: "strict" | "open"; status?: Status; version?: string; nic?: "strict"; proxy?: Status;
} = {}): FakeIncus {
  const fake = FakeIncus.withRuntime();
  if (opts.version) fake.serverVersion = opts.version;
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance("agent-forge", "forge-proxy", { status: opts.proxy ?? "Running", config: { "user.forge.proxy_recipe": "1" } });
  fake.addInstance("agent-forge", "agent-x", {
    status: opts.status ?? "Stopped",
    config: { "user.forge.repo": "o/x", ...(opts.mode ? { "user.forge.egress": opts.mode } : {}) },
    // Un container strict l'est aussi par sa NIC, pas seulement par son marqueur.
    devices: opts.mode === "strict" || opts.nic === "strict" ? { eth0: STRICT_NIC } : {},
  });
  return fake;
}

// No conversation yet, the worktree is there.
const AGENT_RULES: ExecRule[] = [{ match: ".jsonl", code: 1 }, { match: "test -e /workspace/.trees/", code: 0 }];
const lines = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));
const started = (c: ReturnType<typeof fakeContext>, name: string) =>
  lines(c).findIndex((l) => l.endsWith(` start ${name}`));
const proxyPush = (l: string) => l.includes("file push") && l.includes("agent-forge-proxy.sh");
const agentRun = (l: string) => l.includes("exec claude");

test("ensureRunning refuses a strict container on an Incus below the gate, before any start", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", version: "7.0.1" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /7\.0\.2/);
  assert.equal(started(c, "agent-x"), -1, lines(c).join("\n"));
});

test("ensureRunning checks the gate even on a running container", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running", version: "7.0.1" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /7\.0\.2/);
});

test("ensureRunning refuses a container whose marker and NIC disagree, naming forge egress", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", nic: "strict" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /refusing to start agent-x: .*eth0 is strict.*forge egress o\/x strict/);
  assert.equal(started(c, "agent-x"), -1, lines(c).join("\n"));
});

test("ensureRunning starts a strict container's stopped proxy first", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", proxy: "Stopped" }) });
  await ensureRunning(c, "agent-x");
  const proxy = started(c, "forge-proxy");
  assert.ok(proxy >= 0 && proxy < started(c, "agent-x"), lines(c).join("\n"));
});

test("attachTask applies the strict settings before running the agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running" }), rules: AGENT_RULES });
  assert.equal(await attachTask(c, "agent-x", "cli"), 0);
  const l = lines(c);
  const push = l.findIndex(proxyPush);
  assert.ok(push >= 0 && push < l.findIndex(agentRun), l.join("\n"));
});

test("attachTask removes forge's proxy files from an open container before running the agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", status: "Running" }), rules: AGENT_RULES });
  await attachTask(c, "agent-x", "cli");
  const l = lines(c);
  const rm = l.findIndex((x) => x.includes("rm -f"));
  assert.ok(rm >= 0 && rm < l.findIndex(agentRun), l.join("\n"));
});

test("attachTask leaves a container without an egress marker alone", async () => {
  const c = fakeContext({ incus: egressFake({ status: "Running" }), rules: AGENT_RULES });
  await attachTask(c, "agent-x", "cli");
  assert.ok(!lines(c).some((x) => proxyPush(x) || x.includes("rm -f")), lines(c).join("\n"));
  assert.equal(c.attachCalls.length, 1);
});

// What a herdr tab runs.
test("forge attach of a stopped strict container passes the gate, starts it, then applies the settings", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict" }), rules: AGENT_RULES });
  assert.equal(await cmdAttach(c, "agent-x", "cli"), 0);
  const l = lines(c);
  const start = started(c, "agent-x");
  const push = l.findIndex(proxyPush);
  assert.ok(start >= 0 && push > start && push < l.findIndex(agentRun), l.join("\n"));
});

test("forge attach of a strict container below the gate runs no agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running", version: "7.0.1" }), rules: AGENT_RULES });
  await assert.rejects(() => cmdAttach(c, "agent-x", "cli"), /7\.0\.2/);
  assert.equal(c.attachCalls.length, 0);
});

// After a herdr restart: the refused container is that repo's line, and no
// agent is typed into its tab.
test("resume --all skips a strict container the gate refuses", async () => {
  const j = (result: unknown) => JSON.stringify({ id: "x", result });
  const c = fakeContext({
    incus: egressFake({ mode: "strict", status: "Running", version: "7.0.1" }),
    rules: [
      { match: "/h/herdr workspace list", stdout: j({ workspaces: [{ workspace_id: "w1", label: "o/x" }] }) },
      { match: "/h/herdr tab list", stdout: j({ tabs: [{ tab_id: "w1:t1", label: "cli", workspace_id: "w1" }] }) },
      { match: "/h/herdr pane list", stdout: j({ panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] }) },
    ],
  });
  assert.equal(await resumeAll(c, { bin: "/h/herdr", popup: false }), 0);
  assert.equal(c.out_lines.length, 1, c.out_lines.join("\n"));
  assert.match(c.out_lines[0], /^o\/x: skipped \(container did not start: strict mode needs Incus 7\.0\.2/);
  assert.ok(!lines(c).some((l) => l.includes("pane run")), lines(c).join("\n"));
});
