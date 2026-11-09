import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cmdInstall } from "../cli/lib/commands/install.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { renderLaptopBlock } from "../cli/lib/herdr-config.ts";
import { loadCloudSettings, saveCloudSettings, type CloudSettings } from "../cli/lib/laptop/cloud.ts";
import {
  forgeKeyPath, hostDir, inventoryPath, knownHostsPath, loadHosts, relayClientKeyPath, relayInventoryPath, relayLinkPath,
  saveHost, type InstallStep, type LaptopHost,
} from "../cli/lib/laptop/state.ts";
import { fakeContext, type ExecRule, type FakeContext } from "./lib/fake-context.ts";
import { hostKeyOf, withKnownHosts } from "./lib/fake-known-hosts.ts";

// Every laptop path lives in a temporary home: never the real one, never the
// real ~/.ssh or herdr config, never a real VM.
const ENV: Record<string, string> = {
  FORGE_HOME: "", XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", FORGE_SSH_DIR: ".ssh", LIMA_HOME: ".lima",
  HERDR_CONFIG_PATH: ".config/herdr/config.toml",
};
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-install-"));
  for (const [k, rel] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = join(home, rel); }
  // A laptop's usual directories exist already.
  for (const d of [".config", ".local/share", ".ssh"]) mkdirSync(join(home, d), { recursive: true });
});
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

const CHECKOUT = "/src/agent-forge";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyOne alice@laptop";
const KEY2 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyTwo alice@work";
const OPTS = { checkout: CHECKOUT, lima: { sleep: async () => {}, freePort: async () => 60022 } };
const REMOTE = { ...OPTS, remote: "203.0.113.10" };
const ALL: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "identity", "claude", "setup", "image"];
const HERDR_LOCAL = ["herdr", "--remote", "forge-local", "--remote-keybindings", "server"];
const INCLUDE = "Add `Include config.d/agent-forge.config` at the top of ~/.ssh/config?";
const LINK = `Link ~/.local/bin/forge to ${CHECKOUT}/cli/forge?`;
const RETRY = "forge-acme: the first connection never succeeded";
const WHICH = "Install or update which host?";
// The laptop's herdr config, in the temporary home, and the question about it.
const herdrConfig = () => join(home, ".config/herdr/config.toml");
const TOASTS = () => `Turn herdr's notifications on in ${herdrConfig()}?`;
// The checkout's commit, which the playbook deploys.
const HEAD = "1111111111111111111111111111111111111111";
const HEAD2 = "2222222222222222222222222222222222222222";

const BASE: ExecRule[] = [
  { match: "limactl --version", stdout: "limactl version 2.1.2\n" },
  { match: "ansible-playbook --version", stdout: "ansible-playbook [core 2.20.1]\n" },
  { match: "ssh-add -L", stdout: `${KEY}\n` },
  { match: "git config --global user.name", stdout: "Alice Example\n" },
  { match: "git config --global user.email", stdout: "alice@example.com\n" },
  { match: `git -C ${CHECKOUT} rev-parse HEAD`, stdout: `${HEAD}\n` },
];
const NO_LOGIN: ExecRule = { match: "'test' '-e' '.claude/.credentials.json'", code: 1 };

// The Lima VM outlives a run: `limactl list` answers from this world, which
// `limactl create` and `limactl start` change.
type World = { vm: { status: string; port: number; user: string } | null };

// `ssh -G <alias>` as ssh answers it when forge's values are in effect: the
// alias's block in forge's file (its current name, else the old one), or the
// alias itself when no block names it. A test's own rule comes first.
function sshG(name: string): string {
  for (const file of [".ssh/config.d/agent-forge.config", ".ssh/config.d/agent-forge"]) {
    let text: string;
    try { text = readFileSync(join(home, file), "utf8"); } catch { continue; }
    const block = text.split(/\n(?=Host )/).find((b) => b.startsWith(`Host ${name}\n`));
    if (!block) continue;
    return block.split("\n").slice(1).flatMap((l) => {
      const m = /^\s+(\S+)\s+(.*)$/.exec(l);
      if (!m) return [];
      const v = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(["\\])/g, "$1") : m[2];
      return [`${m[1].toLowerCase()} ${m[1] === "HostName" ? v.toLowerCase() : v}`];
    }).join("\n") + "\n";
  }
  return `hostname ${name}\nport 22\nuser alice\n`;
}

function laptop(
  world: World,
  o: { rules?: ExecRule[]; answers?: (number | string | null)[]; attachRules?: ExecRule[] } = {},
): FakeContext {
  const ctx = fakeContext({ rules: [...(o.rules ?? []), ...BASE], answers: o.answers, attachRules: o.attachRules });
  const { exec, attach } = ctx;
  ctx.exec = async (argv, opts) => {
    if (argv[0] === "ssh" && argv[1] === "-G" && !(o.rules ?? []).some((r) => argv.join(" ").includes(r.match))) {
      ctx.calls.push(argv);
      ctx.execOptions.push(opts);
      return { code: 0, stdout: sshG(argv[2]), stderr: "" };
    }
    if (argv[0] === "limactl" && argv[1] === "list") {
      ctx.calls.push(argv);
      ctx.execOptions.push(opts);
      if (!world.vm) return { code: 1, stdout: "", stderr: 'level=warning msg="No instance matching forge-local found."' };
      const { status, port, user } = world.vm;
      return { code: 0, stdout: JSON.stringify({ name: "forge-local", status, sshLocalPort: port, config: { user: { name: user } } }) + "\n", stderr: "" };
    }
    return exec(argv, opts);
  };
  ctx.attach = async (argv, opts) => {
    const code = await attach(argv, opts);
    if (code === 0 && argv[0] === "limactl" && argv[1] === "create") {
      const port = Number(argv[argv.indexOf("--set") + 1].split("= ")[1]);
      world.vm = { status: "Stopped", port, user: "alice" };
    }
    if (code === 0 && argv[0] === "limactl" && argv[1] === "start" && world.vm) world.vm.status = "Running";
    return code;
  };
  return ctx;
}

const attached = (ctx: FakeContext) => ctx.attachCalls.map((a) => a.argv.join(" "));
const called = (ctx: FakeContext) => ctx.calls.map((c) => c.join(" "));
// The labels of the questions asked (the fake prompt logs `label> ` or `label> [items]`).
const asked = (ctx: FakeContext) =>
  ctx.err_lines.filter((l) => /> (\[.*\])?$/.test(l)).map((l) => l.replace(/> (\[.*\])?$/, ""));
const firstIndex = (ctx: FakeContext, part: string) => called(ctx).findIndex((c) => c.includes(part));

async function finishedLocal(world: World): Promise<void> {
  const ctx = laptop(world, { answers: [1, 1, 1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(loadHosts()[0].done, ALL);
}

test("a first local install runs every step in order and ends in herdr", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world, { rules: [NO_LOGIN], answers: [1, 1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);

  const collections = join(home, ".local/share/agent-forge/collections");
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [
    ["limactl", "create", "--tty=false", "--name", "forge-local", "--set", ".ssh.localPort = 60022", `${CHECKOUT}/ansible/lima/forge.yaml`],
    ["limactl", "start", "--tty=false", "forge-local"],
    ["ansible-galaxy", "collection", "install", "-r", `${CHECKOUT}/ansible/requirements.yml`, "-p", collections],
    ["ansible-playbook", "-i", inventoryPath("forge-local"), `${CHECKOUT}/ansible/site.yml`],
    ["ssh", "-o", "ForwardAgent=no", "-t", "forge-local", "--", "'claude' 'auth' 'login'"],
    ["ssh", "-o", "ForwardAgent=no", "forge-local", "--", "'forge' 'setup'"],
    ["ssh", "-o", "ForwardAgent=no", "-t", "forge-local", "--", "'forge' 'image' 'build'"],
    HERDR_LOCAL,
  ]);
  // From the checkout: an ansible.cfg in the developer's current directory is never read.
  for (const a of ctx.attachCalls.filter((c) => c.argv[0].startsWith("ansible"))) {
    assert.deepEqual(a.opts, { env: { ANSIBLE_COLLECTIONS_PATH: collections }, cwd: CHECKOUT });
  }
  // A hand-defined Host is looked for before anything is created, and again
  // at the SSH step, after the playbook, before the host's account steps.
  const sshChecks = called(ctx).flatMap((c, i) => (c === "ssh -G forge-local" ? [i] : []));
  const create = firstIndex(ctx, "limactl create");
  const playbook = firstIndex(ctx, "ansible-playbook -i");
  const identity = firstIndex(ctx, "forge-local -- 'git' 'config'");
  assert.equal(sshChecks.length, 2, called(ctx).join("\n"));
  assert.ok(sshChecks[0] < create && playbook < sshChecks[1] && sshChecks[1] < identity, called(ctx).join("\n"));
  assert.ok(called(ctx).some((c) => c.includes("forge-local -- 'git' 'config' '--global' 'user.name' 'Alice Example'")));

  const [h] = loadHosts();
  assert.deepEqual(h, {
    name: "forge-local", kind: "lima", address: "127.0.0.1", port: 60022, user: "forge", admin: "alice",
    adminKey: join(home, ".lima/_config/user"), exposure: "local", done: ALL, deployed: HEAD,
  });
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY}\n`);
  assert.equal(statSync(forgeKeyPath("forge-local")).mode & 0o777, 0o644);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");
  assert.match(inventory, /ansible_port: 60022/);
  assert.match(inventory, /ansible_user: "alice"/);
  assert.ok(inventory.includes(`- "${KEY}"`), inventory);
  assert.match(readFileSync(join(home, ".ssh/config.d/agent-forge.config"), "utf8"), /^Host forge-local$/m);
  assert.equal(readFileSync(join(home, ".ssh/config"), "utf8"), "Include config.d/agent-forge.config\n");
  assert.equal(statSync(join(home, ".ssh/config")).mode & 0o777, 0o600);
  assert.equal(readlinkSync(join(home, ".local/bin/forge")), `${CHECKOUT}/cli/forge`);
  assert.ok(ctx.out_lines.includes('export PATH="$HOME/.local/bin:$PATH"'), ctx.out_lines.join("\n"));
  assert.deepEqual(asked(ctx), [INCLUDE, LINK, TOASTS()]);
  // The summary: the host, then one line per step.
  assert.ok(ctx.out_lines.includes("forge-local:"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  VM: done"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  Claude login: done"), ctx.out_lines.join("\n"));
});

test("a re-run after a failed playbook resumes at the playbook with the saved answers", async () => {
  const world: World = { vm: null };
  const keys: ExecRule = { match: "ssh-add -L", stdout: `${KEY}\n${KEY2}\n` };
  const first = laptop(world, { rules: [keys], answers: [2], attachRules: [{ match: "ansible-playbook -i", code: 2 }] });
  await assert.rejects(cmdInstall(first, OPTS), (e: Error) =>
    e instanceof ForgeError && /ansible-playbook/.test(e.message) && /playbook/.test(e.message) &&
    /The playbook step failed: run forge install to resume there\./.test(e.message));
  assert.deepEqual(asked(first), ["Key GitHub accepts"]);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory"]);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");

  const second = laptop(world, { rules: [keys], answers: [1, 2] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(!attached(second).some((a) => a.startsWith("limactl")), attached(second).join("\n"));
  // Only what comes after the playbook is asked: the Include, the link, herdr.
  assert.deepEqual(asked(second), [INCLUDE, LINK, TOASTS()]);
  assert.ok(attached(second).some((a) => a.startsWith("ansible-playbook -i")));
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY2}\n`);
  assert.equal(readFileSync(inventoryPath("forge-local"), "utf8"), inventory);
  assert.deepEqual(loadHosts()[0].done, ALL);
});

test("a re-run after an interrupted claude login resumes at the login", async () => {
  const world: World = { vm: null };
  const first = laptop(world, { rules: [NO_LOGIN], answers: [1], attachRules: [{ match: "'claude' 'auth' 'login'", code: 130 }] });
  await assert.rejects(cmdInstall(first, OPTS), /claude auth login[\s\S]*The Claude login step failed: run forge install to resume there\./);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook", "ssh", "identity"]);

  const second = laptop(world, { rules: [NO_LOGIN], answers: [2] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(!attached(second).some((a) => a.startsWith("ansible")));
  assert.deepEqual(asked(second), [LINK, TOASTS()]);
  assert.deepEqual(attached(second), [
    "ssh -o ForwardAgent=no -t forge-local -- 'claude' 'auth' 'login'",
    "ssh -o ForwardAgent=no forge-local -- 'forge' 'setup'",
    "ssh -o ForwardAgent=no -t forge-local -- 'forge' 'image' 'build'",
    HERDR_LOCAL.join(" "),
  ]);
});

test("a Lima VM whose creation failed is created again without asking", async () => {
  const world: World = { vm: null };
  const first = laptop(world, { attachRules: [{ match: "limactl create", code: 1 }] });
  await assert.rejects(cmdInstall(first, OPTS), /limactl create failed[\s\S]*The VM step failed: run forge install to resume there\./);
  assert.deepEqual(loadHosts()[0].done, []);

  const second = laptop(world, { answers: [1, 2] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(attached(second).some((a) => a.startsWith("limactl create")));
  assert.deepEqual(asked(second), [INCLUDE, LINK, TOASTS()]);
});

test("a re-run of a finished host updates it", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");

  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(attached(ctx), [
    `ansible-galaxy collection install -r ${CHECKOUT}/ansible/requirements.yml -p ${join(home, ".local/share/agent-forge/collections")}`,
    `ansible-playbook -i ${inventoryPath("forge-local")} ${CHECKOUT}/ansible/site.yml`,
    "ssh -o ForwardAgent=no forge-local -- 'forge' 'setup'",
    "ssh -o ForwardAgent=no -t forge-local -- 'forge' 'image' 'build'",
    HERDR_LOCAL.join(" "),
  ]);
  assert.ok(called(ctx).some((c) => c.includes("forge-local -- 'forge' 'image' 'commit'")));
  // VM, inventory, identity and login are skipped.
  assert.ok(!called(ctx).some((c) => c.startsWith("ssh -o BatchMode=yes -o ConnectTimeout=5")));
  assert.ok(!called(ctx).some((c) => c.includes("'git' 'config'") || c.includes("git config --global")));
  assert.ok(!called(ctx).some((c) => c.includes("'test' '-e'")));
  assert.equal(readFileSync(inventoryPath("forge-local"), "utf8"), inventory);
  assert.deepEqual(asked(ctx), []);
  assert.deepEqual(loadHosts()[0].done, ALL);
  assert.ok(ctx.out_lines.includes("  VM: already there"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  playbook: done"), ctx.out_lines.join("\n"));
});

test("an update that fails resumes at the failed step", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const failed = laptop(world, { attachRules: [{ match: "'forge' 'setup'", code: 1 }] });
  await assert.rejects(cmdInstall(failed, OPTS), /forge setup/);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook", "ssh", "identity", "claude"]);

  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.ok(!attached(ctx).some((a) => a.startsWith("ansible")));
  assert.ok(attached(ctx).includes("ssh -o ForwardAgent=no forge-local -- 'forge' 'setup'"));
});

// An inventory deleted by hand would let ansible-playbook -i <missing> exit 0
// having deployed nothing.
test("a deleted inventory is written again on the next run", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");
  rmSync(inventoryPath("forge-local"));
  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.equal(readFileSync(inventoryPath("forge-local"), "utf8"), inventory);
  assert.ok(ctx.out_lines.includes("  inventory: done"), ctx.out_lines.join("\n"));
  const again = laptop(world);
  assert.equal(await cmdInstall(again, OPTS), 0);
  assert.ok(again.out_lines.includes("  inventory: already there"), again.out_lines.join("\n"));
});

// After `git pull`, a resume deploys the new forge, not only the failed step.
async function failedAtSetup(world: World): Promise<void> {
  const first = laptop(world, { answers: [1, 1], attachRules: [{ match: "'forge' 'setup'", code: 1 }] });
  await assert.rejects(cmdInstall(first, OPTS), /forge setup/);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook", "ssh", "identity", "claude"]);
  assert.equal(loadHosts()[0].deployed, HEAD);
}

test("a resume after a setup failure with the same checkout skips the playbook", async () => {
  const world: World = { vm: null };
  await failedAtSetup(world);
  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(attached(ctx), [
    "ssh -o ForwardAgent=no forge-local -- 'forge' 'setup'",
    "ssh -o ForwardAgent=no -t forge-local -- 'forge' 'image' 'build'",
    HERDR_LOCAL.join(" "),
  ]);
});

test("a resume after a setup failure with a new checkout commit re-runs playbook, setup and image", async () => {
  // A new commit, or a HEAD that cannot be read: either way, deployed again.
  for (const rule of [
    { match: "rev-parse HEAD", stdout: `${HEAD2}\n` },
    { match: "rev-parse HEAD", code: 128, stderr: "fatal: not a git repository" },
  ]) {
    const world: World = { vm: null };
    await failedAtSetup(world);
    const ctx = laptop(world, { rules: [rule] });
    assert.equal(await cmdInstall(ctx, OPTS), 0);
    assert.deepEqual(attached(ctx), [
      `ansible-galaxy collection install -r ${CHECKOUT}/ansible/requirements.yml -p ${join(home, ".local/share/agent-forge/collections")}`,
      `ansible-playbook -i ${inventoryPath("forge-local")} ${CHECKOUT}/ansible/site.yml`,
      "ssh -o ForwardAgent=no forge-local -- 'forge' 'setup'",
      "ssh -o ForwardAgent=no -t forge-local -- 'forge' 'image' 'build'",
      HERDR_LOCAL.join(" "),
    ], rule.stdout ?? rule.stderr);
    assert.ok(!called(ctx).some((c) => c.includes("'git' 'config'") || c.includes("'test' '-e'")));
    const h = loadHosts()[0];
    assert.deepEqual(h.done, ALL);
    assert.equal(h.deployed, rule.code ? undefined : HEAD2);
    rmSync(join(home, ".config/agent-forge"), { recursive: true, force: true });
    rmSync(join(home, ".ssh/config.d"), { recursive: true, force: true });
    rmSync(join(home, ".ssh/config"), { force: true });
    rmSync(join(home, ".local/bin"), { recursive: true, force: true });
  }
});

// A first install stopped after the SSH wait (the VM's key is stored), then
// the VM deleted by hand: the new VM's key must not meet the old one.
test("a VM created again after a failed first install is not refused for its new host key", async () => {
  const world: World = { vm: null };
  const first = laptop(world, { rules: [{ match: "cloud-init status --wait", code: 1 }] });
  await assert.rejects(cmdInstall(first, OPTS), /cloud-init/);
  assert.deepEqual(loadHosts()[0].done, []);
  writeFileSync(knownHostsPath(), "forge-local-admin ssh-ed25519 AAAAold\n");
  world.vm = null;
  const ctx = laptop(world, { answers: [1, 2] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  const kh = knownHostsPath();
  const create = firstIndex(ctx, "limactl create");
  assert.deepEqual(called(ctx).slice(create - 2, create), [
    `ssh-keygen -R forge-local -f ${kh}`, `ssh-keygen -R forge-local-admin -f ${kh}`,
  ]);
});

test("a stopped Lima VM is started on a re-run, not recreated", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  world.vm!.status = "Stopped";
  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.equal(attached(ctx)[0], "limactl start --tty=false forge-local");
  assert.ok(!attached(ctx).some((a) => a.startsWith("limactl create")));
});

test("a forge-local instance forge did not create is refused", async () => {
  const world: World = { vm: { status: "Running", port: 60022, user: "alice" } };
  const ctx = laptop(world);
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /forge-local/.test(e.message) && /limactl delete forge-local/.test(e.message) &&
    /work/.test(e.message));
  assert.deepEqual(loadHosts(), []);
  assert.deepEqual(ctx.attachCalls, []);
  assert.equal(existsSync(join(home, ".config/agent-forge/hosts")), false);
});

test("a listed Lima VM that is gone is offered to be forgotten", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  writeFileSync(knownHostsPath(), "forge-local ssh-ed25519 AAAAold\n");
  appendFileSync(inventoryPath("forge-local"), "# an edit for the old VM\n");
  world.vm = null; // deleted by hand

  const ctx = laptop(world, { answers: [1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.match(asked(ctx)[0], /forge-local.*gone/);
  const kh = knownHostsPath();
  const forget = ctx.calls.filter((c) => c[0] === "ssh-keygen");
  // Forgetting the VM, then (as before any creation) the VM's aliases again.
  assert.deepEqual(forget, [
    ["ssh-keygen", "-R", "forge-local", "-f", kh],
    ["ssh-keygen", "-R", "forge-local-admin", "-f", kh],
    ["ssh-keygen", "-R", "[127.0.0.1]:60022", "-f", kh],
    ["ssh-keygen", "-R", "forge-local", "-f", kh],
    ["ssh-keygen", "-R", "forge-local-admin", "-f", kh],
  ]);
  // Then a fresh install: a new VM and a new inventory, nothing else asked.
  assert.ok(called(ctx).findLastIndex((c) => c.startsWith("ssh-keygen")) < firstIndex(ctx, "limactl create"));
  assert.deepEqual(asked(ctx).length, 1);
  assert.doesNotMatch(readFileSync(inventoryPath("forge-local"), "utf8"), /an edit for the old VM/);
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY}\n`);
  assert.deepEqual(loadHosts().map((h) => [h.name, h.done]), [["forge-local", ALL]]);
});

test("a failed known_hosts cleanup keeps the gone Lima VM listed", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  writeFileSync(knownHostsPath(), "forge-local ssh-ed25519 AAAAold\n");
  world.vm = null;
  const ctx = laptop(world, { rules: [{ match: "ssh-keygen -R", code: 1, stderr: "boom" }], answers: [1] });
  await assert.rejects(cmdInstall(ctx, OPTS), /ssh-keygen -R forge-local failed: boom/);
  assert.deepEqual(loadHosts().map((h) => h.name), ["forge-local"]);
  assert.ok(existsSync(inventoryPath("forge-local")));
  assert.deepEqual(ctx.attachCalls, []);
});

test("stopping at a gone Lima VM keeps it listed", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const before = readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8");
  world.vm = null;
  const ctx = laptop(world, { answers: [2] });
  await assert.rejects(cmdInstall(ctx, OPTS), ForgeError);
  assert.equal(readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8"), before);
  assert.ok(existsSync(inventoryPath("forge-local")));
  assert.ok(!ctx.calls.some((c) => c[0] === "ssh-keygen"));
  assert.deepEqual(ctx.attachCalls, []);
});

test("a Lima admin named like the forge user is refused", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world);
  const attach = ctx.attach;
  // Lima names its admin after the laptop login: here, forge.
  ctx.attach = async (argv, o) => { const c = await attach(argv, o); if (world.vm) world.vm.user = "forge"; return c; };
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) => e instanceof ForgeError && /forge/.test(e.message) && /admin/.test(e.message));
  assert.deepEqual(loadHosts()[0].done, []);
});

test("a remote install asks its questions once and saves them first", async () => {
  const world: World = { vm: null };
  mkdirSync(join(home, "keys"));
  writeFileSync(join(home, "keys/admin"), "PRIVATE KEY\n", { mode: 0o600 });
  const rules: ExecRule[] = [{ match: "ssh -G github.com", stdout: "user git\nidentityagent /run/agent.sock\n" }];
  // The first connection fails: the answers are saved already.
  const first = laptop(world, {
    rules, answers: ["acme", "", 2, "alice", 2, "~/keys/admin"],
    attachRules: [{ match: "ubuntu@203.0.113.10", code: 255 }],
  });
  await assert.rejects(cmdInstall(first, REMOTE),
    /The first SSH connection step failed: the next forge install --host forge-acme offers to try again or to change these answers\./);
  assert.deepEqual(asked(first), [
    "Host name: forge-<name>", "Admin account (default ubuntu)", "Exposure",
    asked(first)[3], "Key the admin account accepts", "Private key file",
  ]);
  assert.match(asked(first)[3], /^Forge user name \(default .+\)$/);
  assert.deepEqual(first.attachCalls.map((a) => a.argv), [[
    "ssh", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=/run/agent.sock", "-i", join(home, "keys/admin"), "ubuntu@203.0.113.10", "true",
  ]]);
  assert.deepEqual(loadHosts(), [{
    name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
    adminKey: join(home, "keys/admin"), exposure: "lan", identityAgent: "/run/agent.sock", done: [],
  }]);
  assert.equal(readFileSync(forgeKeyPath("forge-acme"), "utf8"), `${KEY}\n`);

  // Tried again with the saved answers: nothing of them is asked again.
  const second = laptop(world, { rules, answers: [1, 1, 2] });
  assert.equal(await cmdInstall(second, REMOTE), 0);
  assert.deepEqual(asked(second), [RETRY, INCLUDE, LINK, TOASTS()]);
  assert.ok(!called(second).some((c) => c.startsWith("limactl")));
  assert.deepEqual(second.attachCalls.at(-1)?.argv, ["herdr", "--remote", "forge-acme", "--remote-keybindings", "server"]);
  // The agent and the admin key reach the inventory, the agent the SSH block.
  const inventory = readFileSync(inventoryPath("forge-acme"), "utf8");
  assert.match(inventory, /-o 'IdentityAgent=\/run\/agent.sock'/);
  assert.ok(inventory.includes(`ansible_ssh_private_key_file: "${join(home, "keys/admin")}"`), inventory);
  assert.match(inventory, /forge_exposure: "lan"/);
  assert.match(inventory, /- name: "alice"/);
  const block = readFileSync(join(home, ".ssh/config.d/agent-forge.config"), "utf8");
  assert.match(block, /Host forge-acme\n[\s\S]*IdentityAgent \/run\/agent.sock/);
  assert.deepEqual(loadHosts()[0].done, ALL);
});

// The first connection is where a wrong admin or key shows: its answers can be
// tried again or forgotten, until it has succeeded once.
const FAILED_FIRST = { match: "ubuntu@203.0.113.10", code: 255 };

async function remoteFailedAtFirstConnection(world: World, listed = ["forge-acme"]): Promise<void> {
  const first = laptop(world, { answers: ["acme", "ubuntu", 1, "alice", null], attachRules: [FAILED_FIRST] });
  await assert.rejects(cmdInstall(first, REMOTE), ForgeError);
  assert.deepEqual(loadHosts().map((h) => h.name), listed);
  assert.deepEqual(loadHosts().find((h) => h.name === "forge-acme")?.done, []);
}

test("the retry offer comes only for a remote whose first connection never succeeded", async () => {
  // A remote that failed later, at the playbook: its first connection succeeded.
  const world: World = { vm: null };
  const failed = laptop(world, { answers: ["acme", "ubuntu", 1, "alice", null], attachRules: [{ match: "ansible-playbook -i", code: 2 }] });
  await assert.rejects(cmdInstall(failed, REMOTE), ForgeError);
  const again = laptop(world, { answers: [1, 2] });
  assert.equal(await cmdInstall(again, { ...OPTS, host: "forge-acme" }), 0);
  assert.deepEqual(asked(again), [INCLUDE, LINK, TOASTS()]);
  // A new remote is not offered it either: its questions come instead.
  assert.ok(!asked(failed).includes(RETRY));
});

test("trying again re-runs the first connection with the saved answers and asks nothing else", async () => {
  const world: World = { vm: null };
  await remoteFailedAtFirstConnection(world);
  const saved = readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8");
  // null (no answer) also tries again.
  for (const answer of [1, null]) {
    const ctx = laptop(world, { answers: [answer], attachRules: [FAILED_FIRST] });
    await assert.rejects(cmdInstall(ctx, { ...OPTS, host: "forge-acme" }), /offers to try again or to change these answers/);
    assert.deepEqual(ctx.err_lines.find((l) => l.startsWith(RETRY)),
      `${RETRY}> [try again with the saved answers (admin ubuntu, key ${forgeKeyPath("forge-acme")}) | forget these answers]`);
    assert.deepEqual(asked(ctx), [RETRY]);
    assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [[
      "ssh", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "IdentitiesOnly=yes",
      "-i", forgeKeyPath("forge-acme"), "ubuntu@203.0.113.10", "true",
    ]]);
    assert.equal(readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8"), saved);
  }
});

test("forgetting the answers removes the host and lets --remote ask again", async () => {
  const world: World = { vm: null };
  await remoteFailedAtFirstConnection(world);
  const before = snapshot(home);
  const ctx = laptop(world, { answers: [2] });
  await assert.rejects(cmdInstall(ctx, REMOTE), (e: Error) =>
    e instanceof ForgeError && /forge install --remote 203\.0\.113\.10/.test(e.message));
  assert.deepEqual(asked(ctx), [RETRY]);
  assert.deepEqual(ctx.attachCalls, []);
  assert.deepEqual(loadHosts(), []);
  assert.equal(existsSync(join(home, ".config/agent-forge/hosts/forge-acme")), false);
  assert.deepEqual(changedOutsideForge(before, snapshot(home)).changed, [
    ".config/agent-forge/hosts.json",
    ".config/agent-forge/hosts/forge-acme",
    ".config/agent-forge/hosts/forge-acme/forge-key.pub",
  ]);

  // Answered again, with the admin account that works.
  const fresh = laptop(world, { answers: ["acme", "debian", 1, "alice", null, 1, 2] });
  assert.equal(await cmdInstall(fresh, REMOTE), 0);
  assert.equal(asked(fresh)[0], "Host name: forge-<name>");
  assert.ok(!asked(fresh).includes(RETRY));
  assert.equal(loadHosts()[0].admin, "debian");
  assert.equal(fresh.attachCalls[0].argv.at(-2), "debian@203.0.113.10");
});

test("a remote admin that accepts the GitHub key uses its public half", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world, { answers: ["forge-acme", "ubuntu", 1, "alice", null, 1, 2] });
  assert.equal(await cmdInstall(ctx, REMOTE), 0);
  const [h] = loadHosts();
  assert.equal(h.adminKey, forgeKeyPath("forge-acme"));
  assert.equal(h.exposure, "public");
  assert.ok(readFileSync(inventoryPath("forge-acme"), "utf8")
    .includes(`ansible_ssh_private_key_file: "${forgeKeyPath("forge-acme")}"`));
  assert.deepEqual(ctx.attachCalls[0].argv, [
    "ssh", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "IdentitiesOnly=yes",
    "-i", forgeKeyPath("forge-acme"), "ubuntu@203.0.113.10", "true",
  ]);
});

test("a remote re-run finds its host by address or by name", async () => {
  const world: World = { vm: null };
  assert.equal(await cmdInstall(laptop(world, { answers: ["acme", "", 1, "alice", null, 1, 1, 1] }), REMOTE), 0);
  for (const opts of [REMOTE, { ...OPTS, host: "forge-acme" }]) {
    const ctx = laptop(world);
    assert.equal(await cmdInstall(ctx, opts), 0);
    assert.deepEqual(asked(ctx), []);
    assert.equal(ctx.attachCalls.at(-1)?.argv[2], "forge-acme");
  }
  assert.equal(loadHosts().length, 1);
});

test("the remote questions are checked and nothing is saved on a bad answer", async () => {
  saveHost({
    name: "forge-beta", kind: "remote", address: "198.51.100.7", port: 22, user: "alice", admin: "ubuntu",
    adminKey: "/keys/admin", exposure: "public", done: [],
  });
  const cases: [string, (number | string | null)[], RegExp][] = [
    ["no name", [null], /name/],
    ["an invalid name", ["Acme_Corp"], /forge-Acme_Corp/],
    ["the Lima name", ["local"], /forge-local/],
    ["a listed name", ["beta"], /forge-beta/],
    ["no exposure", ["acme", "ubuntu", null], /exposure/i],
    ["an invalid user", ["acme", "ubuntu", 1, "Alice Smith"], /Alice Smith/],
    ["the admin as user", ["acme", "ubuntu", 1, "ubuntu"], /ubuntu/],
    ["a missing key file", ["acme", "ubuntu", 1, "alice", 2, "/nowhere/key"], /\/nowhere\/key/],
  ];
  for (const [what, answers, re] of cases) {
    const ctx = laptop({ vm: null }, { answers });
    await assert.rejects(cmdInstall(ctx, REMOTE), (e: Error) => e instanceof ForgeError && re.test(e.message), what);
    assert.deepEqual(loadHosts().map((h) => h.name), ["forge-beta"], what);
    assert.deepEqual(ctx.attachCalls, [], what);
  }
});

test("--remote and --host together are refused", async () => {
  await assert.rejects(cmdInstall(laptop({ vm: null }), { ...REMOTE, host: "forge-acme" }), ForgeError);
});

// With no option, forge install never creates a VM nobody asked for.
async function finishedRemote(world: World): Promise<void> {
  assert.equal(await cmdInstall(laptop(world, { answers: ["acme", "", 1, "alice", null, 1, 2] }), REMOTE), 0);
}

test("no option updates forge-local when it is listed, without asking", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  await finishedRemote(world);
  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.ok(!asked(ctx).includes(WHICH));
  assert.deepEqual(ctx.attachCalls.at(-1)?.argv, HERDR_LOCAL);
});

test("no option and only remote hosts listed asks which host", async () => {
  const world: World = { vm: null };
  await finishedRemote(world);
  const update = laptop(world, { answers: [1] });
  assert.equal(await cmdInstall(update, OPTS), 0);
  assert.equal(update.err_lines.find((l) => l.startsWith(WHICH)), `${WHICH}> [forge-acme | a new local VM (forge-local)]`);
  assert.ok(!called(update).some((c) => c.startsWith("limactl")));
  assert.equal(update.attachCalls.at(-1)?.argv[2], "forge-acme");

  const local = laptop(world, { answers: [2, 2] });
  assert.equal(await cmdInstall(local, OPTS), 0);
  assert.ok(attached(local).some((a) => a.startsWith("limactl create")));
  assert.deepEqual(loadHosts().map((h) => h.name), ["forge-acme", "forge-local"]);
});

test("no option, only remote hosts and no answer stops and names --host and --remote", async () => {
  const world: World = { vm: null };
  await finishedRemote(world);
  const before = readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8");
  const ctx = laptop(world, { answers: [null] });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /--host <name>/.test(e.message) && /--remote <address>/.test(e.message));
  assert.deepEqual(ctx.attachCalls, []);
  assert.equal(readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8"), before);
});

const forgeSshFile = () => readFileSync(join(home, ".ssh/config.d/agent-forge.config"), "utf8");

test("forge's SSH file lists only the hosts whose machine was reached", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  await remoteFailedAtFirstConnection(world, ["forge-local", "forge-acme"]);
  assert.equal(await cmdInstall(laptop(world), OPTS), 0);
  assert.match(forgeSshFile(), /^Host forge-local$/m);
  assert.doesNotMatch(forgeSshFile(), /^Host forge-acme$/m);
});

test("forgetting a gone Lima VM rewrites forge's SSH file", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  world.vm = null;
  // The new VM's creation fails: the run stops after the forget.
  const ctx = laptop(world, { answers: [1], attachRules: [{ match: "limactl create", code: 1 }] });
  await assert.rejects(cmdInstall(ctx, OPTS), /limactl create failed/);
  assert.doesNotMatch(forgeSshFile(), /^Host forge-local$/m);
});

test("forgetting a remote's answers rewrites forge's SSH file", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  await remoteFailedAtFirstConnection(world, ["forge-local", "forge-acme"]);
  // A block left by an earlier run.
  appendFileSync(join(home, ".ssh/config.d/agent-forge.config"), "\nHost forge-acme\n  HostName 203.0.113.10\n");
  await assert.rejects(cmdInstall(laptop(world, { answers: [2] }), REMOTE), /forgotten/);
  assert.match(forgeSshFile(), /^Host forge-local$/m);
  assert.doesNotMatch(forgeSshFile(), /^Host forge-acme$/m);
});

// forge never touches a host it did not create: the check comes as soon as the
// name is known, before anything is saved or connected to.
test("a remote host defined by hand in ~/.ssh/config stops the install", async () => {
  const world: World = { vm: null };
  const rules: ExecRule[] = [{ match: "ssh -G forge-acme", stdout: "host forge-acme\nhostname 198.51.100.7\nport 22\n" }];
  const ctx = laptop(world, { rules, answers: ["acme", "ubuntu", 1, "alice", null] });
  await assert.rejects(cmdInstall(ctx, REMOTE), (e: Error) =>
    e instanceof ForgeError && /Host forge-acme/.test(e.message) && /remove/.test(e.message));
  assert.deepEqual(asked(ctx), ["Host name: forge-<name>"]);
  assert.deepEqual(loadHosts(), []);
  assert.equal(existsSync(join(home, ".config/agent-forge/hosts")), false);
  assert.deepEqual(ctx.attachCalls, []);
  assert.equal(existsSync(join(home, ".ssh/config.d/agent-forge.config")), false);
  assert.equal(existsSync(join(home, ".ssh/config")), false);
});

test("a forge-local defined by hand in ~/.ssh/config stops the install before the VM", async () => {
  const rules: ExecRule[] = [{ match: "ssh -G forge-local", stdout: "host forge-local\nhostname 192.0.2.5\nport 22\n" }];
  const ctx = laptop({ vm: null }, { rules });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) => e instanceof ForgeError && /Host forge-local/.test(e.message));
  assert.deepEqual(loadHosts(), []);
  assert.equal(existsSync(join(home, ".config/agent-forge/hosts")), false);
  assert.deepEqual(ctx.attachCalls, []);
});

test("a host defined by hand after its install still stops at the SSH step", async () => {
  const world: World = { vm: null };
  const failed = laptop(world, { attachRules: [{ match: "ansible-playbook -i", code: 2 }] });
  await assert.rejects(cmdInstall(failed, OPTS), ForgeError);
  // Added by hand since: forge's file has no block for it yet.
  const rules: ExecRule[] = [{ match: "ssh -G forge-local", stdout: "hostname 192.0.2.5\n" }];
  const ctx = laptop(world, { rules });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) => e instanceof ForgeError && /Host forge-local/.test(e.message));
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook"]);
  assert.equal(existsSync(join(home, ".ssh/config.d/agent-forge.config")), false);
});

test("declining the Include stops the install, ~/.ssh/config unchanged", async () => {
  const config = join(home, ".ssh/config");
  writeFileSync(config, "Host *\n  ServerAliveInterval 60\n");
  chmodSync(config, 0o644); // not writeFileSync's mode, which a hardened umask (027) narrows
  const ctx = laptop({ vm: null }, { answers: [2] });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /Include config\.d\/agent-forge\.config/.test(e.message) && /forge-local/.test(e.message));
  assert.equal(readFileSync(config, "utf8"), "Host *\n  ServerAliveInterval 60\n");
  assert.equal(statSync(config).mode & 0o777, 0o644);
  assert.ok(!called(ctx).some((c) => c.includes("'git' 'config'")));
  assert.ok(!loadHosts()[0].done.includes("ssh"));
});

test("an accepted Include keeps the rest of ~/.ssh/config and its mode", async () => {
  const config = join(home, ".ssh/config");
  writeFileSync(config, "Host *\n  ServerAliveInterval 60\n", { mode: 0o640 });
  assert.equal(await cmdInstall(laptop({ vm: null }, { answers: [1, 2] }), OPTS), 0);
  assert.equal(readFileSync(config, "utf8"), "Include config.d/agent-forge.config\n\nHost *\n  ServerAliveInterval 60\n");
  assert.equal(statSync(config).mode & 0o777, 0o640);
});

// An Include that already covers forge's file for every host is enough:
// ~/.ssh/config is not touched (the maintainer's layout).
test("an existing Include under Match all covers forge's file: ~/.ssh/config untouched", async () => {
  const config = join(home, ".ssh/config");
  const text = 'Host *\n  IdentityAgent "/run/user agent.sock"\n\nMatch All\nInclude ~/.ssh/config.d/*.config\n';
  writeFileSync(config, text);
  chmodSync(config, 0o644); // not writeFileSync's mode, which a hardened umask (027) narrows
  const ctx = laptop({ vm: null }, { answers: [2] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.ok(!asked(ctx).includes(INCLUDE), asked(ctx).join("\n"));
  assert.equal(readFileSync(config, "utf8"), text);
  assert.equal(statSync(config).mode & 0o777, 0o644);
  assert.match(forgeSshFile(), /^Host forge-local$/m);
  // Checked with ssh -G once forge's file is written: before the VM, at the
  // SSH step, and the check of what ssh resolves.
  const checks = called(ctx).flatMap((c, i) => (c === "ssh -G forge-local" ? [i] : []));
  assert.equal(checks.length, 3, called(ctx).join("\n"));
  assert.ok(checks[2] > firstIndex(ctx, "ansible-playbook -i"), called(ctx).join("\n"));
});

// ssh keeps the first value it reads: settings before the Include win over
// forge's block. Then the Include goes at the top, after the same question.
const overridden = (): ExecRule => ({
  match: "ssh -G forge-local",
  stdout: [
    "user me", "hostname 127.0.0.1", "port 60022", "identitiesonly yes", "stricthostkeychecking accept-new",
    "hostkeyalias forge-local", `identityfile ${forgeKeyPath("forge-local")}`, `userknownhostsfile ${knownHostsPath()}`,
    "forwardagent no",
  ].join("\n") + "\n",
});
const LATE_INCLUDE = "Host *\n  User me\n  ForwardAgent no\n\nMatch all\nInclude config.d/*.config\n";

test("settings of ~/.ssh/config that win over forge's are named, and the Include offered at the top", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const config = join(home, ".ssh/config");
  writeFileSync(config, LATE_INCLUDE);
  const ctx = laptop(world, { rules: [overridden()], answers: [1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.ok(ctx.out_lines.includes("`User me` from your ~/.ssh/config wins over forge's `User forge`"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("`ForwardAgent no` from your ~/.ssh/config wins over forge's `ForwardAgent yes`"), ctx.out_lines.join("\n"));
  assert.ok(!ctx.out_lines.some((l) => l.startsWith("`HostName") || l.startsWith("`Port")), ctx.out_lines.join("\n"));
  assert.deepEqual(asked(ctx), [INCLUDE]);
  assert.equal(readFileSync(config, "utf8"), `Include config.d/agent-forge.config\n\n${LATE_INCLUDE}`);
});

test("declining the Include when settings win over forge's stops: the alias would not work as installed", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const config = join(home, ".ssh/config");
  writeFileSync(config, LATE_INCLUDE);
  const ctx = laptop(world, { rules: [overridden()], answers: [2] });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /would not work as installed/.test(e.message) && /Include config\.d\/agent-forge\.config/.test(e.message));
  assert.deepEqual(asked(ctx), [INCLUDE]);
  assert.equal(readFileSync(config, "utf8"), LATE_INCLUDE);
  assert.ok(!ctx.attachCalls.some((a) => a.argv[0] === "herdr"));
});

// A host installed by an earlier forge: its block is in config.d/agent-forge,
// which ~/.ssh/config still reads, so ssh -G resolves the alias already.
function installedBefore(): void {
  renameSync(join(home, ".ssh/config.d/agent-forge.config"), join(home, ".ssh/config.d/agent-forge"));
  writeFileSync(join(home, ".ssh/config"), "Include config.d/agent-forge\n");
}
const RESOLVED: ExecRule = { match: "ssh -G forge-local", stdout: "hostname 127.0.0.1\nport 60022\nuser forge\n" };

test("an alias in the old config.d/agent-forge is forge's own: moved to the new file once ssh reads it", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  installedBefore();
  const ctx = laptop(world, { rules: [RESOLVED], answers: [1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [INCLUDE]);
  assert.match(forgeSshFile(), /^Host forge-local$/m);
  assert.equal(existsSync(join(home, ".ssh/config.d/agent-forge")), false);
  assert.equal(readFileSync(join(home, ".ssh/config"), "utf8"), "Include config.d/agent-forge.config\n\nInclude config.d/agent-forge\n");
});

test("declining the Include keeps the old config.d/agent-forge, so the alias still works", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  installedBefore();
  const old = readFileSync(join(home, ".ssh/config.d/agent-forge"), "utf8");
  const ctx = laptop(world, { rules: [RESOLVED], answers: [2] });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) => e instanceof ForgeError && /Include config\.d\/agent-forge\.config/.test(e.message));
  assert.equal(readFileSync(join(home, ".ssh/config.d/agent-forge"), "utf8"), old);
  assert.equal(readFileSync(join(home, ".ssh/config"), "utf8"), "Include config.d/agent-forge\n");
});

test("an install removes the config.d/agent-forge an earlier forge wrote", async () => {
  mkdirSync(join(home, ".ssh/config.d"));
  const old = join(home, ".ssh/config.d/agent-forge");
  writeFileSync(old, "# Managed by forge install: edits are overwritten.\n\nHost forge-local\n  Port 60022\n");
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  assert.equal(await cmdInstall(laptop({ vm: null }, { answers: [2] }), OPTS), 0);
  assert.equal(existsSync(old), false);
  assert.match(forgeSshFile(), /^Host forge-local$/m);
});

test("a ~/.local/bin/forge pointing elsewhere is left alone", async () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/elsewhere/forge", join(home, ".local/bin/forge"));
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  const ctx = laptop({ vm: null });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [TOASTS()]);
  assert.equal(readlinkSync(join(home, ".local/bin/forge")), "/elsewhere/forge");
  assert.ok([...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes("~/.local/bin/forge") && l.includes("left")));
  assert.ok(!ctx.out_lines.includes('export PATH="$HOME/.local/bin:$PATH"'));
});

// Every path under `root`, with what it is: a change shows as a different value.
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out.set(rel, `link ${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(rel, `dir ${st.mode & 0o777}`); walk(p); }
      else out.set(rel, `file ${st.mode & 0o777} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

function changedOutsideForge(before: Map<string, string>, after: Map<string, string>): { changed: string[]; outside: string[] } {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
  const forge = (p: string) =>
    p === ".config/agent-forge" || p.startsWith(".config/agent-forge/") ||
    p === ".local/share/agent-forge" || p.startsWith(".local/share/agent-forge/") ||
    p === ".ssh/config.d" || p === ".ssh/config.d/agent-forge.config";
  return { changed, outside: changed.filter((p) => !forge(p)) };
}

test("nothing is written outside forge's directories without a confirmation", async () => {
  // The developer's own files, which must stay as they are.
  writeFileSync(join(home, ".ssh/id_ed25519.pub"), `${KEY}\n`);
  writeFileSync(join(home, ".zshrc"), "export EDITOR=vi\n");

  // Every confirmation declined: the run stops at the Include.
  let before = snapshot(home);
  await assert.rejects(cmdInstall(laptop({ vm: null }, { answers: [2] }), OPTS), ForgeError);
  let diff = changedOutsideForge(before, snapshot(home));
  assert.ok(diff.changed.includes(".config/agent-forge/hosts.json"), diff.changed.join("\n"));
  assert.deepEqual(diff.outside, []);

  // The Include already there, the link and herdr's notifications declined:
  // the run completes.
  rmSync(join(home, ".config/agent-forge"), { recursive: true, force: true });
  rmSync(join(home, ".ssh/config.d"), { recursive: true, force: true });
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n\nHost *\n  ServerAliveInterval 60\n");
  before = snapshot(home);
  const world: World = { vm: null };
  const ctx = laptop(world, { answers: [2, 2] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [LINK, TOASTS()]);
  diff = changedOutsideForge(before, snapshot(home));
  assert.ok(diff.changed.includes(".ssh/config.d/agent-forge.config"), diff.changed.join("\n"));
  assert.deepEqual(diff.outside, []);
  assert.equal(existsSync(join(home, ".local/bin")), false);

  // A yes for herdr's notifications: its config, and nothing else outside.
  before = snapshot(home);
  assert.equal(await cmdInstall(laptop(world, { answers: [2, 1] }), OPTS), 0);
  assert.deepEqual(changedOutsideForge(before, snapshot(home)).outside, [".config/herdr", ".config/herdr/config.toml"]);
});

// herdr draws the start popup's warnings only when the laptop's herdr config
// turns toasts on (spec, sub-project 1, Finding). Not a recorded step: asked
// on each run until it is there.
test("a yes turns herdr's notifications on in a new laptop config, once", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  const world: World = { vm: null };
  const ctx = laptop(world, { answers: [2, 1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [LINK, TOASTS()]);
  assert.equal(readFileSync(herdrConfig(), "utf8"), renderLaptopBlock());
  assert.equal(statSync(herdrConfig()).mode & 0o777, 0o644);
  assert.equal(statSync(join(home, ".config/herdr")).mode & 0o777, 0o700);
  assert.ok(ctx.out_lines.includes("  herdr notifications: done"), ctx.out_lines.join("\n"));
  assert.deepEqual(ctx.attachCalls.at(-1)?.argv, HERDR_LOCAL);

  // Already there: not asked again, not written again.
  const before = statSync(herdrConfig());
  const again = laptop(world, { answers: [2] });
  assert.equal(await cmdInstall(again, OPTS), 0);
  assert.deepEqual(asked(again), [LINK]);
  assert.equal(statSync(herdrConfig()).mtimeMs, before.mtimeMs);
  assert.equal(statSync(herdrConfig()).ino, before.ino);
  assert.ok(again.out_lines.includes("  herdr notifications: already there"), again.out_lines.join("\n"));
});

test("a yes adds the block after the laptop config's own settings and keeps its mode", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  mkdirSync(join(home, ".config/herdr"));
  const mine = '[keys]\nprefix = "ctrl+a"\n';
  writeFileSync(herdrConfig(), mine, { mode: 0o600 });
  assert.equal(await cmdInstall(laptop({ vm: null }, { answers: [2, 1] }), OPTS), 0);
  assert.equal(readFileSync(herdrConfig(), "utf8"), `${mine}\n${renderLaptopBlock()}`);
  assert.equal(statSync(herdrConfig()).mode & 0o777, 0o600);
});

test("a no, or no answer, leaves herdr's config alone, says the warnings go unseen, and goes on", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  const world: World = { vm: null };
  for (const answer of [2, null]) {
    const ctx = laptop(world, { answers: [2, answer] });
    assert.equal(await cmdInstall(ctx, OPTS), 0);
    assert.deepEqual(asked(ctx), [LINK, TOASTS()]);
    assert.equal(existsSync(join(home, ".config/herdr")), false);
    assert.ok(ctx.out_lines.some((l) => /popup's warnings will go unseen/.test(l)), ctx.out_lines.join("\n"));
    assert.ok(ctx.out_lines.includes("  herdr notifications: declined"), ctx.out_lines.join("\n"));
    assert.deepEqual(ctx.attachCalls.at(-1)?.argv, HERDR_LOCAL);
  }
});

test("a broken laptop block, or a config forge cannot write, leaves herdr's notifications as they are", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  mkdirSync(join(home, ".config/herdr"));
  const broken = '# >>> agent-forge laptop >>>\n[ui.toast]\ndelivery = "herdr"\n';
  writeFileSync(herdrConfig(), broken);
  const world: World = { vm: null };
  const ctx = laptop(world, { answers: [2] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [LINK]);
  const line = ctx.out_lines.find((l) => l.startsWith(`${herdrConfig()}: `));
  assert.ok(line && /without an end marker/.test(line) && /left as they are/.test(line), ctx.out_lines.join("\n"));
  assert.equal(readFileSync(herdrConfig(), "utf8"), broken);
  assert.ok(ctx.out_lines.includes("  herdr notifications: left as they are"), ctx.out_lines.join("\n"));
  assert.deepEqual(ctx.attachCalls.at(-1)?.argv, HERDR_LOCAL);

  // A yes, but the directory refuses the write.
  rmSync(herdrConfig());
  chmodSync(join(home, ".config/herdr"), 0o500);
  try {
    const denied = laptop(world, { answers: [2, 1] });
    assert.equal(await cmdInstall(denied, OPTS), 0);
    assert.ok(denied.out_lines.some((l) => l.startsWith(`${herdrConfig()}: `) && /left as they are/.test(l)), denied.out_lines.join("\n"));
    assert.ok(denied.out_lines.includes("  herdr notifications: left as they are"), denied.out_lines.join("\n"));
    assert.equal(existsSync(herdrConfig()), false);
    assert.deepEqual(denied.attachCalls.at(-1)?.argv, HERDR_LOCAL);
  } finally {
    chmodSync(join(home, ".config/herdr"), 0o700);
  }
});

test("a laptop herdr config whose own [ui.toast] already delivers to herdr needs no line", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  mkdirSync(join(home, ".config/herdr"));
  const mine = '[ui.toast]\ndelivery = "herdr"\n';
  writeFileSync(herdrConfig(), mine);
  const ctx = laptop({ vm: null }, { answers: [2] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [LINK]);
  assert.equal(readFileSync(herdrConfig(), "utf8"), mine);
  assert.ok(!ctx.out_lines.some((l) => l.includes("leaves it alone")), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  herdr notifications: set in your config"), ctx.out_lines.join("\n"));
});

test("a laptop herdr config that sets [ui.toast] or ui itself is left alone, without a question", async () => {
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  mkdirSync(join(home, ".config/herdr"));
  const world: World = { vm: null };
  for (const mine of ['[ui.toast]\ndelivery = "terminal"\n', "ui = { sidebar_width = 30 }\n"]) {
    writeFileSync(herdrConfig(), mine);
    const ctx = laptop(world, { answers: [2] });
    assert.equal(await cmdInstall(ctx, OPTS), 0);
    assert.deepEqual(asked(ctx), [LINK]);
    assert.equal(readFileSync(herdrConfig(), "utf8"), mine);
    const line = ctx.out_lines.find((l) => l.includes(herdrConfig()) && l.includes("leaves it alone"));
    assert.ok(line && /popup's warnings/.test(line), ctx.out_lines.join("\n"));
    assert.ok(ctx.out_lines.includes("  herdr notifications: set in your config"), ctx.out_lines.join("\n"));
  }
});

// --- A cloud host: the dev VM that OpenTofu creates (forge cloud create) ---

const CLOUD_SETTINGS: CloudSettings = {
  awsProfile: "forge-dev", region: "eu-west-3", instanceType: "m7i.2xlarge", diskGb: 200, budgetUsd: 60,
  alertEmail: "ops@example.com", upstream: "example/agent-forge", fork: "bot-example/agent-forge",
  botName: "Example Bot", botEmail: "1+bot-example@users.noreply.github.com",
};
// askCloudSettings' ten answers; the instance type and the disk take their defaults.
const CLOUD_ANSWERS = [
  "forge-dev", "eu-west-3", "", "", "60", "ops@example.com", "example/agent-forge", "bot-example/agent-forge",
  "Example Bot", "1+bot-example@users.noreply.github.com",
];
const CLOUD_ALL: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "claude", "relay"];
const TOKEN = "tok-abc";
// A classic token's shape, built here so that no secret scanner takes this file for a leak.
const BOT_TOKEN = `ghp_${"Ab3".repeat(12)}`;
const TRUSTED = "maintainer-example";
const TRUSTED_LABEL = "GitHub logins the agent takes instructions from (yours), comma-separated";
const CLOUD_RULES: ExecRule[] = [
  { match: "tofu version", stdout: "OpenTofu v1.10.0\n" },
  { match: "aws --version", stdout: "aws-cli/2.31.0 Python/3.13.7\n" },
  { match: "describe-instance-types", stdout: '["nested-virtualization"]' },
  { match: "checkip.amazonaws.com", stdout: "198.51.100.7\n" },
  { match: " output -json", stdout: JSON.stringify({
    address: { value: "203.0.113.20" }, relay_address: { value: "203.0.113.21" },
    relay_private_ip: { value: "10.100.1.11" }, subnet_cidr: { value: "10.100.1.0/24" },
  }) },
  { match: "ssh-keyscan", stdout: "203.0.113.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey\n" },
  { match: "'test' '-s' '.config/agent-forge/claude-token'", code: 1 },
  { match: "'sudo' 'test' '-s' '/etc/forge-relay/github-token'", code: 1 },
];
// forge's known_hosts follows the first connections: a key is known once ssh asked about it.
const cloudLaptop = (o: { rules?: ExecRule[]; answers?: (number | string | null)[]; attachRules?: ExecRule[] } = {}) =>
  withKnownHosts(laptop({ vm: null }, { ...o, rules: [...(o.rules ?? []), ...CLOUD_RULES] }), knownHostsPath);
const cloudHost = (): LaptopHost => ({
  name: "forge-dev", kind: "cloud", address: "", port: 22, user: "alice", admin: "ubuntu",
  adminKey: forgeKeyPath("forge-dev"), exposure: "public", done: [],
});
const noWait = async (): Promise<void> => {};
const metadataFlags = (): unknown[] => {
  const vars = JSON.parse(readFileSync(join(hostDir("forge-dev"), "tofu.tfvars.json"), "utf8"));
  return [vars.dev_metadata_enabled, vars.relay_metadata_enabled];
};

const devFirst = (address: string) =>
  `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ubuntu@${address} true`;
const galaxy = () =>
  `ansible-galaxy collection install -r ${CHECKOUT}/ansible/requirements.yml -p ${join(home, ".local/share/agent-forge/collections")}`;
// The dev VM's playbook with the relay link, then the relay's.
const playbooks = () => [
  `ansible-playbook -i ${inventoryPath("forge-dev")} ${CHECKOUT}/ansible/contributor.yml -e @${relayLinkPath("forge-dev")}`,
  `ansible-playbook -i ${relayInventoryPath("forge-dev")} ${CHECKOUT}/ansible/relay.yml ` +
  `-e ${JSON.stringify({ forge_relay_client_key_file: relayClientKeyPath("forge-dev") })}`,
];

// A new cloud host from its questions to herdr: the trusted logins answered,
// the Include accepted, both tokens pasted, the link and herdr's
// notifications declined.
async function newCloud(): Promise<FakeContext> {
  const ctx = cloudLaptop({ answers: ["dev", "alice", ...CLOUD_ANSWERS, TRUSTED, 1, TOKEN, BOT_TOKEN, 2, 2] });
  assert.equal(await cmdInstall(ctx, { checkout: CHECKOUT, cloud: true, sleep: noWait }), 0);
  return ctx;
}

test("a new cloud host: settings asked, infra applied, address recorded, contributor playbook, no setup or image", async () => {
  const ctx = await newCloud();
  const host = loadHosts().find((h) => h.name === "forge-dev")!;
  assert.equal(host.kind, "cloud");
  assert.equal(host.address, "203.0.113.20");
  assert.equal(host.admin, "ubuntu");
  assert.equal(host.adminKey, forgeKeyPath("forge-dev"));
  assert.equal(host.relayAddress, "203.0.113.21");
  assert.deepEqual(host.done, CLOUD_ALL);
  assert.equal(loadCloudSettings("forge-dev").sshCidr, "198.51.100.7/32");
  assert.deepEqual(loadCloudSettings("forge-dev").trustedLogins, [TRUSTED]);
  // New instances: cloud-init reads the admin key from the metadata services.
  assert.deepEqual(metadataFlags(), [true, true]);
  // OpenTofu, both first connections once sshd answers, both playbooks, the
  // relay's setup, herdr.
  assert.ok(called(ctx).includes("ssh-keyscan -T 5 203.0.113.20"), called(ctx).join("\n"));
  assert.ok(called(ctx).includes("ssh-keyscan -T 5 203.0.113.21"), called(ctx).join("\n"));
  assert.deepEqual(attached(ctx), [
    `tofu -chdir=${CHECKOUT}/infra/aws apply -var-file=${join(hostDir("forge-dev"), "tofu.tfvars.json")}`,
    // By address, not by the alias: the alias's ForwardAgent no would not apply.
    devFirst("203.0.113.20"),
    devFirst("203.0.113.21"),
    galaxy(),
    ...playbooks(),
    `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ` +
    "ubuntu@203.0.113.21 -- 'sudo' '-u' 'forge-relay' '/usr/local/bin/forge-relay' 'setup'",
    "herdr --remote forge-dev --remote-keybindings server",
  ]);
  // No forge setup, no image, and never this machine's git identity: the dev VM commits as the bot.
  assert.ok(!called(ctx).some((c) =>
    /forge setup|image build|'forge' 'setup'|'image' 'build'|'git' 'config'/.test(c)), called(ctx).join("\n"));
  const inventory = readFileSync(inventoryPath("forge-dev"), "utf8");
  assert.match(inventory, /forge_contributor_fork: "bot-example\/agent-forge"/);
  assert.match(inventory, /ansible_ssh_common_args: ".*-o ForwardAgent=no.*"/);
  assert.match(forgeSshFile(), /^Host forge-dev\n(  .*\n)*  ForwardAgent no$/m);
  assert.ok(ctx.out_lines.includes("  Claude token: done"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  relay setup: done"), ctx.out_lines.join("\n"));
});

// A host installed before the relay existed: its dev VM was reached, the
// relay is new. Its metadata service is on until forge knows its key, then
// the first connection asks about that key, in the open.
test("the relay's first connection happens while its key is unknown", async () => {
  saveHost({ ...cloudHost(), address: "203.0.113.20", done: ["vm", "inventory", "playbook", "ssh", "claude"], deployed: HEAD2 });
  saveCloudSettings("forge-dev", CLOUD_SETTINGS);
  writeFileSync(knownHostsPath(), `203.0.113.20 ${hostKeyOf("203.0.113.20")}\n`);
  const ctx = cloudLaptop({ answers: [TRUSTED, 1, BOT_TOKEN, 2, 2] });
  assert.equal(await cmdInstall(ctx, { checkout: CHECKOUT, host: "forge-dev", sleep: noWait }), 0);
  assert.deepEqual(metadataFlags(), [false, true]);
  // The dev VM's wait is the admin's login, the relay's a key scan.
  assert.deepEqual(called(ctx).filter((c) => c.startsWith("ssh-keyscan")), ["ssh-keyscan -T 5 203.0.113.21"]);
  const first = attached(ctx).indexOf(devFirst("203.0.113.21"));
  assert.ok(first >= 0 && first < attached(ctx).indexOf(galaxy()), attached(ctx).join("\n"));
  assert.ok(!attached(ctx).includes(devFirst("203.0.113.20")), attached(ctx).join("\n"));
  assert.ok(asked(ctx).includes(TRUSTED_LABEL), asked(ctx).join("\n"));
  const host = loadHosts()[0];
  assert.equal(host.relayAddress, "203.0.113.21");
  assert.deepEqual(host.done, CLOUD_ALL);
});

test("the playbook step runs contributor.yml with the relay link, then relay.yml", async () => {
  const ctx = await newCloud();
  assert.deepEqual(attached(ctx).filter((a) => a.startsWith("ansible-playbook")), playbooks());
  // The relay's private address, its key as the first connection recorded
  // it, and where the dev VM's client key lands on this machine.
  assert.deepEqual(JSON.parse(readFileSync(relayLinkPath("forge-dev"), "utf8")), {
    forge_contributor_relay_address: "10.100.1.11",
    forge_contributor_relay_host_key: hostKeyOf("203.0.113.21"),
    forge_contributor_relay_client_pub_dest: relayClientKeyPath("forge-dev"),
  });
  const inventory = readFileSync(relayInventoryPath("forge-dev"), "utf8");
  assert.match(inventory, /^ {4}forge-dev-relay:\n {6}ansible_host: "203\.0\.113\.21"$/m);
  assert.match(inventory, /^ {6}ansible_user: "ubuntu"$/m);
  assert.match(inventory, /ansible_ssh_common_args: ".*-o ForwardAgent=no.*"/);
  assert.match(inventory, /^ {4}forge_exposure: "public"$/m);
  assert.match(inventory, /^ {4}forge_relay_bot_login: "bot-example"$/m);
  assert.match(inventory, /^ {4}forge_relay_trusted_logins: \["maintainer-example"\]$/m);
  assert.match(inventory, /^ {4}forge_relay_co_author_emails: \["noreply@anthropic\.com"\]$/m);
  assert.match(inventory, /^ {4}forge_relay_client_cidr: "10\.100\.1\.0\/24"$/m);
});

test("the bot token reaches the relay on ssh's stdin, never in an argv", async () => {
  const ctx = await newCloud();
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes(BOT_TOKEN)));
  assert.ok(![...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes(BOT_TOKEN)));
  const execs = ctx.calls.filter((c) => !ctx.attachCalls.some((a) => a.argv === c));
  const i = execs.findIndex((c) => c.join(" ").includes("github-token.new"));
  // Root's, readable by forge-relay (like config.json), renamed into place.
  const file = "/etc/forge-relay/github-token";
  assert.equal(execs[i]?.join(" "),
    `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o BatchMode=yes -o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ` +
    `ubuntu@203.0.113.21 -- 'sudo' 'sh' '-c' 'umask 077 && cat > ${file}.new && chown root:forge-relay ${file}.new && ` +
    `chmod 0640 ${file}.new && mv -f ${file}.new ${file}'`);
  assert.equal(ctx.execOptions[i]?.input, `${BOT_TOKEN}\n`);
  // Never in a file on this machine.
  for (const [rel, what] of snapshot(home)) {
    if (what.startsWith("file ")) assert.ok(!readFileSync(join(home, rel), "utf8").includes(BOT_TOKEN), rel);
  }
});

test("the Claude token travels on stdin only", async () => {
  const ctx = await newCloud();
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes(TOKEN)));
  assert.ok(![...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes(TOKEN)));
  // execOptions follows the exec calls only: an attach call records none.
  const execs = ctx.calls.filter((c) => !ctx.attachCalls.some((a) => a.argv === c));
  assert.equal(execs.length, ctx.execOptions.length);
  const i = execs.findIndex((c) => c.join(" ").includes("cat >"));
  assert.ok(i >= 0, called(ctx).join("\n"));
  assert.equal(ctx.execOptions[i]?.input, `${TOKEN}\n`);
  // Never in a file on this machine.
  for (const [rel, what] of snapshot(home)) {
    if (what.startsWith("file ")) assert.ok(!readFileSync(join(home, rel), "utf8").includes(TOKEN), rel);
  }
});

test("a cloud host whose first connection failed is retried, never forgotten", async () => {
  saveHost(cloudHost());
  saveCloudSettings("forge-dev", CLOUD_SETTINGS);
  const state = join(hostDir("forge-dev"), "terraform.tfstate");
  writeFileSync(state, "{}\n");
  const ctx = cloudLaptop({ attachRules: [{ match: "ubuntu@203.0.113.20", code: 255 }] });
  await assert.rejects(cmdInstall(ctx, { checkout: CHECKOUT, host: "forge-dev", sleep: noWait }),
    /The VM step failed: run forge cloud create --host forge-dev to resume there\./);
  assert.ok(attached(ctx).some((a) => a.startsWith("tofu ") && a.includes(" apply ")), attached(ctx).join("\n"));
  assert.ok(existsSync(hostDir("forge-dev")));
  assert.equal(readFileSync(state, "utf8"), "{}\n");
  assert.deepEqual(loadHosts().map((h) => [h.name, h.done]), [["forge-dev", []]]);
  assert.ok(!ctx.err_lines.some((l) => l.includes("forget these answers")));
});

test("a cloud VM that never answers on SSH stops the run after 36 tries, 5 s apart", async () => {
  saveHost(cloudHost());
  saveCloudSettings("forge-dev", CLOUD_SETTINGS);
  const slept: number[] = [];
  const ctx = cloudLaptop({ rules: [{ match: "ssh-keyscan", stdout: "" }] });
  await assert.rejects(cmdInstall(ctx, { checkout: CHECKOUT, host: "forge-dev", sleep: async (ms) => { slept.push(ms); } }),
    /203\.0\.113\.20[\s\S]*forge cloud create --host forge-dev/);
  assert.equal(called(ctx).filter((c) => c.startsWith("ssh-keyscan")).length, 36);
  assert.deepEqual(slept, Array(35).fill(5000));
  assert.ok(!attached(ctx).some((a) => a.includes("ubuntu@")));
  assert.deepEqual(loadHosts().map((h) => h.name), ["forge-dev"]);
});

// The relay's setup as the admin runs it: a re-run of a finished host runs it again.
const relaySetupCall = () =>
  `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ` +
  "ubuntu@203.0.113.21 -- 'sudo' '-u' 'forge-relay' '/usr/local/bin/forge-relay' 'setup'";
const BOT_TOKEN_STORED: ExecRule = { match: "'sudo' 'test' '-s' '/etc/forge-relay/github-token'", code: 0 };
const KEEP_OR_PASTE = "A bot token is already stored on the relay";

// After a change to infra/aws, `forge cloud start` refuses and points here: a
// re-run applies OpenTofu again (its plan asks, an empty one asks nothing),
// then the playbooks and the relay's setup; never a first connection or the
// Claude token again.
test("a re-run of a finished cloud host applies OpenTofu, the playbooks and the relay's setup again, never the first connection", async () => {
  await newCloud();
  const ctx = cloudLaptop({
    rules: [{ match: "checkip.amazonaws.com", stdout: "198.51.100.8\n" }, BOT_TOKEN_STORED], answers: [1, 2, 2],
  });
  assert.equal(await cmdInstall(ctx, { checkout: CHECKOUT, host: "forge-dev", sleep: noWait }), 0);
  assert.ok(called(ctx).some((c) => c.startsWith(`tofu -chdir=${CHECKOUT}/infra/aws init`)), called(ctx).join("\n"));
  assert.deepEqual(attached(ctx), [
    `tofu -chdir=${CHECKOUT}/infra/aws apply -var-file=${join(hostDir("forge-dev"), "tofu.tfvars.json")}`,
    galaxy(),
    ...playbooks(),
    relaySetupCall(),
    "herdr --remote forge-dev --remote-keybindings server",
  ]);
  // This machine's address may have moved since the last run.
  assert.equal(loadCloudSettings("forge-dev").sshCidr, "198.51.100.8/32");
  // Reached once, the VMs no longer need their metadata services.
  assert.deepEqual(metadataFlags(), [false, false]);
  // Installed, the host runs fail2ban in aggressive mode, which bans this
  // machine for ssh-keyscan's connections: the wait is the admin's login.
  assert.ok(!called(ctx).some((c) => c.startsWith("ssh-keyscan")), called(ctx).join("\n"));
  assert.ok(called(ctx).includes(
    `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 ` +
    `-o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ubuntu@203.0.113.20 true`), called(ctx).join("\n"));
  assert.ok(called(ctx).includes(
    `ssh -o UserKnownHostsFile=${knownHostsPath()} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 ` +
    `-o ForwardAgent=no -i ${forgeKeyPath("forge-dev")} ubuntu@203.0.113.21 true`), called(ctx).join("\n"));
  // The bot's token kept: its file is only checked.
  assert.ok(!called(ctx).some((c) => c.includes("claude-token") || c.includes("github-token.new")), called(ctx).join("\n"));
  assert.deepEqual(asked(ctx), [KEEP_OR_PASTE, LINK, TOASTS()]);
  assert.ok(ctx.out_lines.includes("  relay setup: already there"), ctx.out_lines.join("\n"));
  assert.deepEqual(loadHosts()[0].done, CLOUD_ALL);
});

// The bot's token must expire: a finished host's update is how it is replaced.
test("a re-run of a finished cloud host replaces an expired bot token, then checks it", async () => {
  await newCloud();
  const renewed = `ghp_${"Cd4".repeat(12)}`;
  const ctx = cloudLaptop({ rules: [BOT_TOKEN_STORED], answers: [2, renewed, 2, 2] });
  assert.equal(await cmdInstall(ctx, { checkout: CHECKOUT, host: "forge-dev", sleep: noWait }), 0);
  const execs = ctx.calls.filter((c) => !ctx.attachCalls.some((a) => a.argv === c));
  const write = execs.findIndex((c) => c.join(" ").includes("github-token.new"));
  assert.equal(ctx.execOptions[write]?.input, `${renewed}\n`);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes(renewed)));
  // The new token is written before the relay's setup checks it.
  const setup = attached(ctx).indexOf(relaySetupCall());
  assert.ok(setup >= 0, attached(ctx).join("\n"));
  assert.ok(ctx.calls.indexOf(execs[write]) < ctx.calls.indexOf(ctx.attachCalls[setup].argv));
  assert.ok(ctx.out_lines.includes("  relay setup: done"), ctx.out_lines.join("\n"));
  assert.deepEqual(loadHosts()[0].done, CLOUD_ALL);
});

test("--remote with a cloud host's address is refused: its SSH block would forward the agent", async () => {
  saveHost({ ...cloudHost(), address: "203.0.113.20", done: CLOUD_ALL });
  const ctx = laptop({ vm: null });
  await assert.rejects(cmdInstall(ctx, { ...OPTS, remote: "203.0.113.20" }), (e: Error) =>
    e instanceof ForgeError && /forge-dev/.test(e.message));
  assert.deepEqual(asked(ctx), []);
  assert.deepEqual(loadHosts().map((h) => h.name), ["forge-dev"]);
});
