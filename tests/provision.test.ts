import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { provisionContainer } from "../cli/lib/commands/provision.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
});

// Quotes, spaces and a command substitution: the identity must reach git as
// it is, never through a shell.
const NAME = `Ada O'Brien "$(id)"`;
const EMAIL = "ada@example.com";
const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: `${NAME}\n` },
  { match: "git config --global --includes user.email", stdout: `${EMAIL}\n` },
];

// A working hook refuses the probe's forbidden command with exit code 2.
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe", code: 2, stderr: "BLOCKED: sudo non autorisé.\n" }];

function provision(opts: { rules?: ExecRule[]; fake?: FakeIncus } = {}) {
  const fake = opts.fake ?? FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...(opts.rules ?? []), ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionContainer(ctx, "agent-x", "o/r") };
}
const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));
const launched = (ctx: ReturnType<typeof fakeContext>) => flat(ctx).some((l) => l.includes(" launch "));

function seedWorkspace(...files: string[]) {
  const dir = join(home, "workspaces", "agent-x");
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}
const ORIGIN = (url: string): ExecRule => ({ match: "remote get-url", stdout: `${url}\n` });

test("a new container is launched from agent-base under the agent-forge profile, then waited for", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const launch = calls.indexOf("incus --project agent-forge launch agent-base agent-x --profile agent-forge");
  const ready = calls.indexOf("incus --project agent-forge exec agent-x -- systemctl is-system-running --wait");
  assert.ok(launch >= 0 && ready > launch, calls.join("\n"));
});

test("it refuses without host Claude credentials, before creating anything", async () => {
  rmSync(join(home, ".claude", ".credentials.json"));
  const { ctx, run } = provision();
  await assert.rejects(run, /credentials\.json not found/);
  assert.equal(launched(ctx), false);
});

test("it refuses without a host git identity, with the commands to run", async () => {
  const { ctx, run } = provision({ rules: [{ match: "git config --global --includes user.email", code: 1 }] });
  await assert.rejects(run, (e: Error) => {
    assert.match(e.message, /git config --global user\.name/);
    assert.match(e.message, /git config --global user\.email/);
    return true;
  });
  assert.equal(launched(ctx), false);
});

test("it names forge setup when the profile is missing", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge");
  fake.addImage("agent-forge", "agent-base");
  const { ctx, run } = provision({ fake });
  await assert.rejects(run, /Run 'forge setup' first/);
  assert.equal(launched(ctx), false);
});

test("it names forge image build when agent-base is missing", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge");
  fake.addProfile("agent-forge", "agent-forge");
  const { ctx, run } = provision({ fake });
  await assert.rejects(run, /Run 'forge image build' first/);
  assert.equal(launched(ctx), false);
});

test("the host identity reaches git as argv elements, and commits are unsigned", async () => {
  const { ctx, run } = provision();
  await run();
  const gitCalls = ctx.calls.filter((c) => c[0] === "incus" && c.includes("git") && c.includes("--global"));
  assert.deepEqual(gitCalls.map((c) => c.slice(c.indexOf("--") + 1)), [
    ["git", "config", "--global", "user.name", NAME],
    ["git", "config", "--global", "user.email", EMAIL],
    ["git", "config", "--global", "commit.gpgsign", "false"],
  ]);
  for (const c of gitCalls) {
    assert.deepEqual(c.slice(3, c.indexOf("--")),
      ["exec", "agent-x", "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser"]);
  }
});

test("no autonomous remnant: no prompt, no gh, no signing key, no cloud-init cleanup", async () => {
  const { ctx, run } = provision();
  await run();
  const all = flat(ctx).join("\n");
  for (const gone of ["gh auth", "signing", "gpg.format", "deluser", "sudoers", "https://github.com/o/r", "lxd init"]) {
    assert.ok(!all.includes(gone), gone);
  }
  assert.ok(!ctx.err_lines.some((l) => l.endsWith("> ") || l.endsWith(": ")), "no question is asked");
});

test("the clone happens on the host over SSH, before the metadata", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const clone = calls.indexOf(`git clone git@github.com:o/r.git ${join(home, "workspaces", "agent-x")}`);
  const meta = calls.findIndex((l) => l.includes("user.forge.repo"));
  assert.ok(clone >= 0 && meta > clone, calls.join("\n"));
});

test("the workspace is mounted without shift", async () => {
  const { fake, run } = provision();
  await run();
  assert.deepEqual(fake.instances.get("agent-forge")!.get("agent-x")!.devices.workspace,
    { type: "disk", source: join(home, "workspaces", "agent-x"), path: "/workspace" });
});

test("files come from container/; the hook and the settings belong to root", async () => {
  const { ctx, run } = provision();
  await run();
  const push = (dest: string) => ctx.calls.find((c) => c.includes("push") && c.includes(`agent-x${dest}`))!;
  const repo = (file: string) => join(process.cwd(), "container", file);
  assert.ok(push("/home/aiuser/.claude.json").includes(repo("claude.json")));
  assert.ok(push("/home/aiuser/.claude/CLAUDE.md").includes(repo("CLAUDE.md")));
  for (const [dest, file] of [["/home/aiuser/.claude/hooks/pre-bash.sh", "pre-bash.sh"], ["/home/aiuser/.claude/settings.json", "settings.json"]]) {
    const c = push(dest);
    assert.ok(c.includes(repo(file)), c.join(" "));
    assert.equal(c[c.indexOf("--uid") + 1], "0");
  }
});

// The hook is the agent's guardrail: a hook that cannot read its input (no
// jq in the image, 2026-10-17) let every command through, silently.
test("provisioning proves the installed hook blocks a forbidden command, as aiuser", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const pushed = calls.findIndex((l) => l.includes("push") && l.includes("agent-x/home/aiuser/.claude/hooks/pre-bash.sh"));
  const probe = calls.findIndex((l) => l.includes("forge-hook-probe"));
  assert.ok(pushed >= 0 && probe > pushed, calls.join("\n"));
  assert.ok(calls[probe].includes("--user 1001"), calls[probe]);
  assert.ok(calls[probe].includes("sudo"), calls[probe]);
});

test("a hook that lets a forbidden command through aborts provisioning", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe", code: 0, stderr: "pre-bash.sh: line 9: jq: command not found\n" }] });
  await assert.rejects(run, (e: Error) => /hook/.test(e.message) && /jq: command not found/.test(e.message));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

test("the mode is supervised, in the marker and in the metadata", async () => {
  const { fake, ctx, run } = provision();
  await run();
  assert.ok(flat(ctx).some((l) => l.includes("echo 'supervised' > /home/aiuser/.claude/forge-mode")));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.mode"], "supervised");
});

test("the metadata records the repo and the image's commit", async () => {
  const { fake, run } = provision();
  await run();
  const config = fake.instances.get("agent-forge")!.get("agent-x")!.config;
  assert.equal(config["user.forge.repo"], "o/r");
  assert.equal(config["user.forge.image_commit"], "IMGSHA");
});

test("Claude Code is refreshed from apt; a failure only warns", async () => {
  const { fake, ctx, run } = provision({ rules: [{ match: "apt-get update", code: 100, stderr: "E: network down\n" }] });
  await run();
  assert.ok(ctx.err_lines.some((l) => l.startsWith("WARNING") && l.includes("E: network down")), ctx.err_lines.join("\n"));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], "o/r");
});

test("Claude Code is upgraded only when the package lists were refreshed", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const update = calls.findIndex((l) => l.endsWith("-- apt-get update"));
  const upgrade = calls.findIndex((l) => l.endsWith("-- apt-get install --only-upgrade -y claude-code"));
  assert.ok(update >= 0 && upgrade > update, calls.join("\n"));
});

test("the retrieval hint names the host user and no fixed port", async () => {
  const { ctx, run } = provision();
  await run();
  const hint = `  git remote add agent-x ssh://${userInfo().username}@<forge-host>${join(home, "workspaces", "agent-x")}`;
  assert.ok(ctx.err_lines.includes(hint), ctx.err_lines.join("\n"));
  assert.ok(!ctx.err_lines.join("\n").includes(":2222"));
});

test("the plugin marketplace is added over HTTPS, never over SSH", async () => {
  const { ctx, run } = provision();
  await run();
  const add = flat(ctx).find((l) => l.includes("plugin marketplace add"));
  assert.ok(add?.includes("https://github.com/anthropics/claude-plugins-official"), add);
  assert.ok(!add?.includes("git@github.com"), add);
});

// Kept from v1: the LFS filters are fatal, the repo's own hooks best-effort,
// the .trees/ exclude a step of its own.
test("failing to install the LFS filters aborts provisioning, with git's message", async () => {
  const { run } = provision({ rules: [{ match: "lfs install --skip-repo", code: 1, stderr: "fatal: not in a git directory\n" }] });
  await assert.rejects(run, /git-lfs filters in agent-x failed: fatal: not in a git directory/);
});

const HOOKS_CONFLICT: ExecRule = {
  match: "cd /workspace && git lfs install",
  code: 2,
  stderr: "Hook already exists: pre-push\n\nTo resolve this, either:\n  1: run `git lfs update --manual`\n",
};

test("a repo that manages its own hooks does not abort provisioning", async () => {
  const { fake, ctx, run } = provision({ rules: [HOOKS_CONFLICT] });
  await run();
  assert.match(ctx.err_lines.join("\n"), /Hook already exists: pre-push/);
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], "o/r");
});

test("the worktree exclude is its own step, written even when the hooks step fails", async () => {
  const { ctx, run } = provision({ rules: [HOOKS_CONFLICT] });
  await run();
  const calls = flat(ctx);
  assert.ok(calls.some((l) => l.includes("info/exclude")));
  assert.ok(!calls.some((l) => l.includes("lfs install") && l.includes("info/exclude")));
});

test("a failing clone aborts provisioning before the metadata", async () => {
  const { ctx, run } = provision({ rules: [{ match: "git clone git@github.com", code: 1, stderr: "Permission denied (publickey)\n" }] });
  await assert.rejects(run, /clone repository failed: Permission denied/);
  assert.ok(!flat(ctx).some((l) => l.includes("user.forge.repo")));
  assert.ok(!flat(ctx).some((l) => l.includes("git lfs install")));
});

test("a workspace left by a deleted container is reused, its origin realigned", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision({ rules: [ORIGIN("https://github.com/o/r.git")] });
  await run();
  const calls = flat(ctx);
  assert.ok(!calls.some((l) => l.includes("git clone")));
  assert.ok(calls.some((l) => l.includes("remote set-url origin git@github.com:o/r.git")));
});

test("a non-empty workspace of another repo stops everything before the launch", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision({ rules: [ORIGIN("git@github.com:someone/else.git")] });
  await assert.rejects(run, /not a clone of o\/r/);
  assert.equal(launched(ctx), false);
});

test("a non-empty workspace that is not a git repository stops everything before the launch", async () => {
  seedWorkspace("notes.txt");
  const { ctx, run } = provision({ rules: [{ match: "remote get-url", code: 128 }] });
  await assert.rejects(run, /not a clone of o\/r/);
  assert.equal(launched(ctx), false);
});

test("an empty workspace directory is cloned into", async () => {
  seedWorkspace();
  const { ctx, run } = provision();
  await run();
  assert.ok(flat(ctx).some((l) => l.startsWith("git clone git@github.com:o/r.git")));
});
