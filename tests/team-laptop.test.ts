import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { cmdTeamLaptop } from "../cli/lib/commands/team-laptop.ts";
import { remoteAttachForwarding } from "../cli/lib/laptop/remote.ts";
import { viaCommand } from "../cli/lib/laptop/machines.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-team-laptop-"));
  process.env.FORGE_HOME = tmp;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  saveHost(host("forge-local"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
});

const host = (name: string, kind: LaptopHost["kind"] = "remote"): LaptopHost => ({
  name, kind, address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
  adminKey: "/keys/admin", exposure: "public", done: [],
});
const HC: ExecRule = { match: "hc --version", stdout: "hc 0.1.20\n" };

test("assign forwards the instruction as stdin, with the host's own command and no agent forwarding", async () => {
  const ctx = fakeContext({ rules: [{ match: "'forge' 'team' 'assign'", stdout: "Assigned fix-login to agent-web-dev-1.\n" }] });
  const code = await cmdTeamLaptop(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "X" });
  assert.equal(code, 0);
  assert.deepEqual(ctx.calls[0], ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-local", "--",
    "'forge' 'team' 'assign' 'agent-web-dev-1' 'fix-login'"]);
  assert.equal(ctx.execOptions[0]?.input, "X");
  assert.deepEqual(ctx.out_lines, ["Assigned fix-login to agent-web-dev-1."]);
});

test("up checks hc, converges with the agent forwarded, then registers the machines of every declared container", async () => {
  const rows = JSON.stringify([{ name: "agent-web-lead" }, { name: "agent-web-dev-1" }]);
  const ctx = fakeContext({ rules: [
    HC, { match: "'forge' 'team' 'status' '--json'", stdout: rows },
    { match: "hc machine ls --json", stdout: JSON.stringify({ machines: [] }) },
  ] });
  assert.equal(await cmdTeamLaptop(ctx, ["up"]), 0);
  // Hors de la connexion partagée : une connexion maître ouverte sans agent ne
  // transmettrait pas l'agent à cette session.
  assert.deepEqual(ctx.attachCalls[0].argv,
    ["ssh", "-A", "-o", "ControlPath=none", "forge-local", "--", "'forge' 'team' 'converge'"]);
  const adds = ctx.calls.filter((c) => c[0] === "hc" && c[2] === "add");
  assert.deepEqual(adds.map((c) => c[4]), ["forge-local-web-lead", "forge-local-web-dev-1"]);
  assert.equal(adds[0][6], viaCommand("forge-local", "agent-web-lead"));
});

test("a Mac whose hc is not the pinned version converges nothing", async () => {
  const ctx = fakeContext({ rules: [{ match: "hc --version", stdout: "hc 0.1.21\n" }] });
  await assert.rejects(() => cmdTeamLaptop(ctx, ["up"]), /hc 0\.1\.20/);
  assert.deepEqual(ctx.attachCalls, []);
});

test("a cloud host never gets the forwarded agent", () => {
  assert.throws(() => remoteAttachForwarding(fakeContext(), host("forge-dev", "cloud"), ["forge", "team", "sync", "web"]), /cloud host/);
});
