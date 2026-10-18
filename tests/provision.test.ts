import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { mirrorPath } from "../cli/lib/paths.ts";
import { provisionContainer } from "../cli/lib/commands/provision.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_MIRRORS;
});

// Quotes, spaces and a command substitution: the identity must reach git as
// it is, never through a shell.
const NAME = `Ada O'Brien "$(id)"`;
const EMAIL = "ada@example.com";
const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: `${NAME}\n` },
  { match: "git config --global --includes user.email", stdout: `${EMAIL}\n` },
];

// A working hook refuses the probe's forbidden command with exit code 2 and
// lets its harmless command through (the fake's default exit code is 0).
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED: sudo non autorisé.\n" }];

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
// A mirror left by a previous container, cloned from `url`.
function seedMirror(url: string): ExecRule {
  mkdirSync(mirrorPath("agent-x"), { recursive: true });
  return { match: "--get remote.origin.url", stdout: `${url}\n` };
}
const WORKSPACE = () => join(home, "workspaces", "agent-x");

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
test("provisioning proves the installed hook guards aiuser both ways", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const pushed = calls.findIndex((l) => l.includes("push") && l.includes("agent-x/home/aiuser/.claude/hooks/pre-bash.sh"));
  const deny = calls.findIndex((l) => l.includes("forge-hook-probe-deny"));
  const allow = calls.findIndex((l) => l.includes("forge-hook-probe-allow"));
  assert.ok(pushed >= 0 && deny > pushed && allow > pushed, calls.join("\n"));
  for (const probe of [calls[deny], calls[allow]]) assert.ok(probe.includes("--user 1001"), probe);
  assert.ok(calls[deny].includes("sudo"), calls[deny]);
});

// The v1 hook without jq: everything got through.
test("a hook that lets a forbidden command through aborts provisioning", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe-deny", code: 0, stderr: "pre-bash.sh: line 9: jq: command not found\n" }] });
  await assert.rejects(run, (e: Error) => /let a forbidden command through/.test(e.message) && /jq: command not found/.test(e.message));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

// The fail-closed hook without jq: everything is refused, the agent cannot
// run anything — safe, but useless, and silent unless provisioning says so.
test("a hook that refuses a harmless command aborts provisioning", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe-allow", code: 2, stderr: "BLOCKED: jq introuvable, le hook ne peut pas lire la commande (fail-closed).\n" }] });
  // The hook's own sentence ends with a period: no ".." in the message. The
  // half-provisioned container has no forge metadata, so `forge delete` cannot
  // find it: the message gives the incus command (seen on a real host).
  await assert.rejects(run, (e: Error) => /refuses a harmless command/.test(e.message) && /jq introuvable/.test(e.message)
    && !e.message.includes("..") && e.message.includes("incus --project agent-forge delete --force agent-x"));
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

test("the retrieval hint goes through forge upload-pack, with no ssh:// path", async () => {
  const { ctx, run } = provision();
  await run();
  const at = ctx.err_lines.indexOf("Retrieve this container's work from your machine with:");
  assert.ok(at >= 0, ctx.err_lines.join("\n"));
  assert.deepEqual(ctx.err_lines.slice(at, at + 4), [
    "Retrieve this container's work from your machine with:",
    "  git remote add agent-x <forge-host>:agent-x",
    '  git config remote.agent-x.uploadpack "forge upload-pack agent-x"',
    "  git fetch agent-x",
  ]);
  assert.ok(!ctx.err_lines.join("\n").includes("ssh://"));
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


test("the mirror is created on the host before the launch", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const clone = calls.findIndex((l) => l.startsWith("git ") && l.includes("clone --bare"));
  const launch = calls.findIndex((l) => l.includes(" launch "));
  assert.ok(clone >= 0 && launch > clone, calls.join("\n"));
  assert.ok(calls[clone].endsWith(`git@github.com:o/r.git ${mirrorPath("agent-x")}`), calls[clone]);
});

test("the workspace is cloned inside the container, after both devices", async () => {
  const { fake, ctx, run } = provision();
  assert.deepEqual(await run(), { mirror: "created" });
  const devices = fake.instances.get("agent-forge")!.get("agent-x")!.devices;
  assert.deepEqual(devices.origin,
    { type: "disk", source: mirrorPath("agent-x"), path: "/forge/origin.git", readonly: "true" });
  assert.deepEqual(devices.workspace, { type: "disk", source: WORKSPACE(), path: "/workspace" });
  const calls = flat(ctx);
  const adds = calls.map((l, i) => (l.includes("device add") ? i : -1)).filter((i) => i >= 0);
  const clone = calls.findIndex((l) => l.endsWith("env GIT_LFS_SKIP_SMUDGE=1 git clone --no-local /forge/origin.git /workspace"));
  assert.equal(adds.length, 2, calls.join("\n"));
  assert.ok(clone > Math.max(...adds), calls.join("\n"));
});

test("no host git touches the workspace, new container or reuse", async () => {
  const fresh = provision();
  await fresh.run();
  assertNoHostGitIn(fresh.ctx.calls, WORKSPACE());

  seedWorkspace("README.md");
  const reuse = provision({ rules: [seedMirror("git@github.com:o/r.git")] });
  await reuse.run();
  assertNoHostGitIn(reuse.ctx.calls, WORKSPACE());
});

test("a workspace with a matching mirror is reused", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision({ rules: [seedMirror("git@github.com:o/r.git")] });
  assert.deepEqual(await run(), { mirror: "kept" });
  const calls = flat(ctx);
  assert.ok(!calls.some((l) => l.includes("clone")), calls.join("\n"));
  assert.equal(calls.filter((l) => l.endsWith("remote set-url origin /forge/origin.git")).length, 1);
});

test("a non-empty workspace without a mirror stops before the launch", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision();
  await assert.rejects(run, /no mirror of o\/r/);
  assert.equal(launched(ctx), false);
});

test("a mirror of another repo stops before the launch", async () => {
  const { ctx, run } = provision({ rules: [seedMirror("git@github.com:a/b.git")] });
  await assert.rejects(run, /mirror of a\/b/);
  assert.equal(launched(ctx), false);
});

test("a failing mirror clone stops before the launch", async () => {
  const { ctx, run } = provision({ rules: [{ match: "clone --bare", code: 128, stderr: "Permission denied (publickey)\n" }] });
  await assert.rejects(run, /create mirror failed: Permission denied/);
  assert.equal(launched(ctx), false);
});

// --- strict mode ---
import { proxyPlan } from "../cli/lib/ipv4.ts";
import { egressNames } from "../cli/lib/objects.ts";
import { strictLaunchArgs } from "../cli/lib/strict.ts";

// Default config (10.77.0.1/24): no config file under this XDG dir.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-prov-xdg-"));

function strictFake(opts: { acl?: boolean; proxy?: boolean; version?: string } = {}): FakeIncus {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  if (opts.version) fake.serverVersion = opts.version;
  if (opts.acl ?? true) {
    fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  }
  if (opts.proxy ?? true) fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  return fake;
}
const strictProvision = (opts: { rules?: ExecRule[]; fake?: FakeIncus } = {}) => {
  const fake = opts.fake ?? strictFake();
  const ctx = fakeContext({ incus: fake, rules: [...(opts.rules ?? []), ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionContainer(ctx, "agent-x", "o/r", { strict: true }) };
};

test("--strict launches with every override in the same call; there is no launch without them", async () => {
  const { ctx, run } = strictProvision();
  await run();
  const launches = ctx.calls.filter((c) => c.includes("launch"));
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], ["incus", "--project", "agent-forge", "launch", "agent-base", "agent-x", "--profile", "agent-forge",
    ...strictLaunchArgs(proxyPlan("10.77.0.1/24", 0), egressNames("agent-forge"))]);
});

test("--strict applies the settings right after waitReady, before the plugin install", async () => {
  const { ctx, run } = strictProvision();
  await run();
  const calls = flat(ctx);
  const ready = calls.findIndex((l) => l.includes("is-system-running --wait"));
  const settings = calls.findIndex((l) => l.includes("file push") && l.includes("agent-x/etc/profile.d/agent-forge-proxy.sh"));
  const plugin = calls.findIndex((l) => l.includes("claude plugin marketplace add"));
  assert.ok(ready >= 0 && settings > ready && settings < plugin, calls.join("\n"));
});

for (const [what, fake] of [
  ["the gate", () => strictFake({ version: "7.0.1" })],
  ["the ACL", () => strictFake({ acl: false })],
  ["the proxy", () => strictFake({ proxy: false })],
] as const) {
  test(`--strict refuses before creating anything when ${what} is missing`, async () => {
    const { ctx, run } = strictProvision({ fake: fake() });
    await assert.rejects(run, /forge setup|7\.0\.2/);
    assert.equal(launched(ctx), false);
  });
}

test("--strict: a failed plugin install is a warning naming the GitHub group", async () => {
  const { fake, ctx, run } = strictProvision({ rules: [{ match: "claude plugin", code: 1, stderr: "fetch failed\n" }] });
  await run();
  assert.ok(ctx.err_lines.some((l) => /WARNING: .*superpowers.*fetch failed.*egress-allowlist.*forge setup/.test(l)), ctx.err_lines.join("\n"));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], "o/r");
});

test("--strict: the Claude refresh reads only Anthropic's apt source", async () => {
  const { ctx, run } = strictProvision();
  await run();
  assert.ok(flat(ctx).some((l) => l.endsWith("-- apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources " +
    "-o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0")), flat(ctx).join("\n"));
  assert.ok(flat(ctx).some((l) => l.endsWith("-- apt-get install --only-upgrade -y claude-code")));
});

test("without --strict, provisioning is unchanged", async () => {
  const { ctx, run } = provision({ rules: [{ match: "claude plugin", code: 1, stderr: "fetch failed\n" }] });
  await assert.rejects(run, /install Claude plugins/);
  assert.ok(!flat(ctx).some((l) => l.includes(" launch ") && l.includes(" -d ")));
  assert.ok(!flat(ctx).some((l) => l.includes("agent-forge-proxy.sh")));
});
