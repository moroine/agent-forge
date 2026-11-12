import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import type { ExecOptions } from "../cli/lib/context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { cmdTeam } from "../cli/lib/commands/team.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-cmd-"));
  mkdirSync(join(home, "agent-forge"), { recursive: true });
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: { dev: { count: 2, capabilities: ["repo", "publish"] } } } },
  }));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.XDG_CONFIG_HOME = home;
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["XDG_CONFIG_HOME", "FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
});

const RULES: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
  { match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" },
];

function setup() {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules: RULES });
  return { fake, ctx };
}

test("assign reads the instruction from stdin and gives the task on behalf of the human", async () => {
  const { fake, ctx } = setup();
  const code = await cmdTeam(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "Corrige le login\n" });
  assert.equal(code, 0);
  const keys = fake.instances.get("agent-forge")!.get("agent-web-dev-1")!.config;
  assert.deepEqual([keys["user.forge.task"], keys["user.forge.assigned_by"]], ["fix-login", "human"]);
  assert.equal(fake.files.get("agent-forge/agent-web-dev-1/home/aiuser/.forge/instruction.md")!.content, "Corrige le login");
});

test("an empty instruction is refused before any Incus call", async () => {
  const { ctx } = setup();
  await assert.rejects(() => cmdTeam(ctx, ["assign", "agent-web-dev-1", "fix-login"], { stdin: async () => "  \n" }), /instruction is empty/);
  assert.deepEqual(ctx.calls, []);
});

test("converge launches only the missing members and reports a stray one without deleting it", async () => {
  const { fake, ctx } = setup();
  fake.addInstance("agent-forge", "agent-web-dev-9", { status: "Stopped", config: { "user.forge.team": "web" } });
  await cmdTeam(ctx, ["converge"]);
  const launches = ctx.calls.filter((c) => c.includes("launch")).map((c) => c[c.indexOf("launch") + 2]);
  assert.deepEqual(launches, ["agent-web-dev-2"]);
  assert.ok(ctx.out_lines.some((l) => l.startsWith("agent-web-dev-9") && l.includes("not in the config, left as is")), ctx.out_lines.join("\n"));
  assert.ok(fake.instances.get("agent-forge")!.has("agent-web-dev-9"));
  assert.ok(!ctx.calls.some((c) => c.includes("delete")));
});

test("converge starts the pilot's session again when it has exited", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-pilot", { status: "Running" });
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  // La session du pilote est morte jusqu'au `hc run` qui la relance, puis vivante.
  const base = fakeContext({ incus: fake, rules: RULES });
  let ran = false;
  const ctx = { ...base, exec: async (argv: string[], o?: ExecOptions) => {
    const line = argv.join(" ");
    if (line.includes("agent-pilot") && line.endsWith("-- hc get agent")) {
      return { code: 0, stderr: "", stdout: ran ? '{"state":"live","status":{"state":"idle"}}'
        : '{"state":"finished","reason":"exited","exit_code":1,"status":null}' };
    }
    if (line.includes("agent-pilot") && line.includes("-- hc run ")) ran = true;
    return base.exec(argv, o);
  } };
  await cmdTeam(ctx, ["converge"]);
  const runs = base.calls.map((c) => c.join(" ")).filter((c) => c.includes("hc run"));
  assert.equal(runs.length, 1, runs.join("\n"));
  assert.ok(runs[0].includes("agent-pilot") && runs[0].includes("--forge-task agent-pilot-session"), runs[0]);
});

test("converge starts the session of a pilot it has just created", async () => {
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
  }));
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running" });
  const ctx = fakeContext({ incus: fake, rules: [...RULES, { match: "-- hc get agent", code: 1 }] });
  await cmdTeam(ctx, ["converge"]);
  const calls = ctx.calls.map((c) => c.join(" "));
  const launch = calls.findIndex((c) => c.includes("launch") && c.includes("agent-pilot"));
  const run = calls.findIndex((c) => c.includes("hc run") && c.includes("--forge-task agent-pilot-session"));
  assert.ok(launch >= 0 && run > launch, calls.join("\n"));
});

test("status --json prints one JSON array and nothing else on stdout", async () => {
  const { ctx } = setup();
  await cmdTeam(ctx, ["status"], { json: true });
  assert.equal(ctx.out_lines.length, 1);
  const rows = JSON.parse(ctx.out_lines[0]) as { name: string; session: string; busy: unknown }[];
  assert.deepEqual(rows.map((r) => r.name), ["agent-web-dev-1", "agent-web-dev-2"]);
  assert.deepEqual(rows.map((r) => r.busy), [null, null]);
});

test("for-repo prints the team that holds the repository, and nothing (exit 1) for another", async () => {
  const { ctx } = setup();
  assert.equal(await cmdTeam(ctx, ["for-repo", "o/web"]), 0);
  assert.deepEqual(ctx.out_lines, ["web"]);
  const none = setup();
  assert.equal(await cmdTeam(none.ctx, ["for-repo", "o/none"]), 1);
  assert.deepEqual(none.ctx.out_lines, []);
});

test("task-base prints one sorted <task><TAB><base> line per owned task, dropping an unsafe ref", async () => {
  const { fake, ctx } = setup();
  const keys = (n: string) => fake.instances.get("agent-forge")!.get(n)!.config;
  Object.assign(keys("agent-web-dev-1"), { "user.forge.base.fix-login": "origin/main" });
  fake.addInstance("agent-forge", "agent-web-dev-2", {
    status: "Running", config: { "user.forge.base.export-csv": "origin/main", "user.forge.base.bad": "--upload-pack=x" },
  });
  assert.equal(await cmdTeam(ctx, ["task-base", "web"]), 0);
  assert.deepEqual(ctx.out_lines, ["export-csv\torigin/main", "fix-login\torigin/main"]);
});

test("upload-pack writes nothing to stdout, then attaches git upload-pack on the team mirror with hooks off", async () => {
  const { ctx } = setup();
  const code = await cmdTeam(ctx, ["upload-pack", "web", "/ignored/path"]);
  assert.equal(code, 0);
  assert.deepEqual(ctx.out_lines, []);
  assert.equal(ctx.attachCalls.length, 1);
  const argv = ctx.attachCalls[0].argv;
  assert.deepEqual(argv.slice(0, 4), ["git", "-c", "core.hooksPath=/dev/null", "upload-pack"]);
  assert.ok(argv[4].endsWith("team-web.agents.git") && argv.length === 5, argv.join(" "));
  await assert.rejects(() => cmdTeam(setup().ctx, ["upload-pack", "nope"]), /not a declared team/);
});
