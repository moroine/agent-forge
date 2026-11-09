import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCloud } from "../cli/lib/commands/cloud.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { loadCloudSettings, saveCloudSettings, type CloudSettings } from "../cli/lib/laptop/cloud.ts";
import { forgeKeyPath, hostDir, knownHostsPath, loadHosts, saveHost, type InstallStep, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext, type ExecRule, type FakeContext } from "./lib/fake-context.ts";
import { hostKeyOf, withKnownHosts } from "./lib/fake-known-hosts.ts";

// Every laptop path lives in a temporary home, like install.test.ts.
const ENV: Record<string, string> = {
  FORGE_HOME: "", XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", FORGE_SSH_DIR: ".ssh", LIMA_HOME: ".lima",
  HERDR_CONFIG_PATH: ".config/herdr/config.toml",
};
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-cloud-"));
  for (const [k, rel] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = join(home, rel); }
  for (const d of [".config", ".local/share", ".ssh"]) mkdirSync(join(home, d), { recursive: true });
});
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

const CHECKOUT = "/src/agent-forge";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyOne alice@laptop";
const HEAD = "1111111111111111111111111111111111111111";
const CLOUD_ALL: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "claude", "relay"];
// A classic token's shape, built here so that no secret scanner takes this file for a leak.
const BOT_TOKEN = `ghp_${"Ab3".repeat(12)}`;
const SETTINGS: CloudSettings = {
  awsProfile: "forge-dev", region: "eu-west-3", instanceType: "m7i.2xlarge", diskGb: 200, budgetUsd: 60,
  alertEmail: "ops@example.com", upstream: "example/agent-forge", fork: "bot-example/agent-forge",
  botName: "Example Bot", botEmail: "1+bot-example@users.noreply.github.com", sshCidr: "192.0.2.9/32",
  trustedLogins: ["maintainer-example"], coAuthorEmails: ["noreply@anthropic.com"],
};
const RULES: ExecRule[] = [
  { match: "tofu version", stdout: "OpenTofu v1.10.0\n" },
  { match: "aws --version", stdout: "aws-cli/2.31.0 Python/3.13.7\n" },
  { match: "describe-instance-types", stdout: '["nested-virtualization"]' },
  { match: "checkip.amazonaws.com", stdout: "198.51.100.7\n" },
  { match: "show -json", stdout: '{"resource_changes":[{"address":"aws_ec2_instance_state.dev","change":{"actions":["update"]}}]}' },
  { match: " output -json", stdout: JSON.stringify({
    address: { value: "203.0.113.20" }, relay_address: { value: "203.0.113.21" },
    relay_private_ip: { value: "10.100.1.11" }, subnet_cidr: { value: "10.100.1.0/24" },
  }) },
  { match: "ssh-keyscan", stdout: "203.0.113.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey\n" },
  { match: "'test' '-s' '.config/agent-forge/claude-token'", code: 1 },
  { match: "ssh-add -L", stdout: `${KEY}\n` },
  { match: "ansible-playbook --version", stdout: "ansible-playbook [core 2.20.1]\n" },
  { match: `git -C ${CHECKOUT} rev-parse HEAD`, stdout: `${HEAD}\n` },
];
const host = (o: Partial<LaptopHost> = {}): LaptopHost => ({
  name: "forge-dev", kind: "cloud", address: "203.0.113.20", relayAddress: "203.0.113.21", port: 22, user: "alice",
  admin: "ubuntu", adminKey: forgeKeyPath("forge-dev"), exposure: "public", done: CLOUD_ALL, ...o,
});
// Both VMs reached: forge's known_hosts holds their keys.
function install(h: LaptopHost = host()): void {
  saveHost(h);
  saveCloudSettings(h.name, SETTINGS);
  writeFileSync(forgeKeyPath(h.name), `${KEY}\n`);
  writeFileSync(knownHostsPath(), `203.0.113.20 ${hostKeyOf("203.0.113.20")}\n203.0.113.21 ${hostKeyOf("203.0.113.21")}\n`);
}
// `ssh -G <alias>` as ssh answers it once forge's file is included: that file's block for the alias.
function sshG(name: string): string {
  let text = "";
  try { text = readFileSync(join(home, ".ssh/config.d/agent-forge.config"), "utf8"); } catch { /* no file yet */ }
  const block = text.split(/\n(?=Host )/).find((b) => b.startsWith(`Host ${name}\n`));
  if (!block) return `hostname ${name}\nport 22\nuser alice\n`;
  return block.split("\n").slice(1).flatMap((l) => {
    const m = /^\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) return [];
    const v = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(["\\])/g, "$1") : m[2];
    return [`${m[1].toLowerCase()} ${m[1] === "HostName" ? v.toLowerCase() : v}`];
  }).join("\n") + "\n";
}
function laptop(o: { answers?: (number | string | null)[]; rules?: ExecRule[] } = {}): FakeContext {
  const ctx = fakeContext({ rules: [...(o.rules ?? []), ...RULES], answers: o.answers });
  const exec = ctx.exec;
  ctx.exec = async (argv, opts) => {
    if (argv[0] === "ssh" && argv[1] === "-G") {
      ctx.calls.push(argv);
      ctx.execOptions.push(opts);
      return { code: 0, stdout: sshG(argv[2]), stderr: "" };
    }
    return exec(argv, opts);
  };
  return withKnownHosts(ctx, knownHostsPath);
}
const called = (ctx: FakeContext) => ctx.calls.map((c) => c.join(" "));
const attached = (ctx: FakeContext) => ctx.attachCalls.map((a) => a.argv.join(" "));
const noWait = async (): Promise<void> => {};
const tfvars = () => JSON.parse(readFileSync(join(hostDir("forge-dev"), "tofu.tfvars.json"), "utf8"));
const metadataFlags = (): unknown[] => [tfvars().dev_metadata_enabled, tfvars().relay_metadata_enabled];

test("start: records this machine's address, starts the VM, waits for SSH, opens herdr", async () => {
  install();
  const ctx = fakeContext({ rules: RULES });
  // sshd answers on the third try.
  const exec = ctx.exec;
  let tries = 0;
  ctx.exec = async (argv, o) => {
    if (argv[0] === "ssh" && argv.includes("forge-dev") && ++tries < 3) { ctx.calls.push(argv); return { code: 255, stdout: "", stderr: "refused" }; }
    return exec(argv, o);
  };
  const slept: number[] = [];
  assert.equal(await cmdCloud(ctx, "start", { checkout: CHECKOUT, sleep: async (ms) => { slept.push(ms); } }), 0);
  assert.equal(loadCloudSettings("forge-dev").sshCidr, "198.51.100.7/32");
  assert.equal(tfvars().running, true);
  assert.equal(tfvars().ssh_cidr, "198.51.100.7/32");
  assert.deepEqual(metadataFlags(), [false, false]);
  assert.deepEqual(slept, [5000, 5000]);
  assert.equal(attached(ctx).at(-1), "herdr --remote forge-dev --remote-keybindings server");
});

test("start: a VM that never answers stops after 36 tries", async () => {
  install();
  const ctx = fakeContext({ rules: [{ match: "forge-dev -- ", code: 255 }, ...RULES] });
  await assert.rejects(cmdCloud(ctx, "start", { checkout: CHECKOUT, sleep: noWait }), /forge-dev/);
  assert.equal(called(ctx).filter((c) => c.includes("forge-dev -- ")).length, 36);
  assert.ok(!attached(ctx).some((a) => a.startsWith("herdr")));
});

test("stop: stops the VM with the saved address, without looking up this machine's", async () => {
  install();
  const ctx = fakeContext({ rules: RULES });
  assert.equal(await cmdCloud(ctx, "stop", { checkout: CHECKOUT, sleep: noWait }), 0);
  assert.equal(tfvars().running, false);
  assert.equal(tfvars().ssh_cidr, "192.0.2.9/32");
  assert.deepEqual(metadataFlags(), [false, false]);
  assert.ok(!called(ctx).some((c) => c.includes("checkip")));
  assert.ok(ctx.out_lines.some((l) => /disks are kept/.test(l)), ctx.out_lines.join("\n"));
});

test("rebuild: refused without confirmation, nothing touched", async () => {
  install();
  const ctx = fakeContext({ rules: RULES, answers: [2] });
  await assert.rejects(cmdCloud(ctx, "rebuild", { checkout: CHECKOUT, sleep: noWait }));
  assert.ok(!called(ctx).some((c) => c.startsWith("tofu") || c.startsWith("ssh-keygen")));
});

test("rebuild: replaces the instance, forgets both host keys, installs again", async () => {
  install();
  appendFileSync(knownHostsPath(), "forge-dev ssh-ed25519 AAAA\n");
  // Confirm, accept the SSH Include, the Claude token, decline the link and herdr's notifications.
  const ctx = laptop({ answers: [1, 1, "tok-abc", 2, 2] });
  // The variables of the replacing apply, read as it runs: the install's own apply rewrites them.
  let replacing: unknown[] = [];
  const attach = ctx.attach;
  ctx.attach = async (argv, o) => {
    if (argv.includes("-replace=aws_instance.dev")) replacing = metadataFlags();
    return attach(argv, o);
  };
  assert.equal(await cmdCloud(ctx, "rebuild", { checkout: CHECKOUT, sleep: noWait }), 0);
  const replace = attached(ctx).findIndex((a) => a.startsWith("tofu ") && a.includes("apply") && a.includes("-replace=aws_instance.dev"));
  assert.ok(replace >= 0, attached(ctx).join("\n"));
  // The new dev VM's cloud-init needs its metadata service; the relay's stays off.
  assert.deepEqual(replacing, [true, false]);
  const keygen = called(ctx).filter((c) => c.startsWith("ssh-keygen -R"));
  assert.deepEqual(keygen.map((c) => c.split(" ")[2]), ["forge-dev", "203.0.113.20"]);
  assert.ok(keygen.every((c) => c.endsWith(knownHostsPath())));
  assert.ok(attached(ctx).some((a) => a.includes("contributor.yml")));
  // The relay, reached already, keeps its metadata service off.
  assert.deepEqual(metadataFlags(), [true, false]);
  assert.deepEqual(loadHosts()[0].done, CLOUD_ALL);
});

test("rebuild-relay replaces only the relay and redoes the playbook and the relay step", async () => {
  install();
  // Confirm, accept the SSH Include, paste the new token, decline the link and herdr's notifications.
  const ctx = laptop({ answers: [1, 1, BOT_TOKEN, 2, 2], rules: [{ match: "'sudo' 'test' '-s' '/etc/forge-relay/github-token'", code: 1 }] });
  // Each apply's variables and the steps recorded then, read as it runs.
  const applies: { argv: string; metadata: unknown[]; done: InstallStep[] }[] = [];
  const attach = ctx.attach;
  ctx.attach = async (argv, o) => {
    if (argv[0] === "tofu") applies.push({ argv: argv.join(" "), metadata: metadataFlags(), done: loadHosts()[0].done });
    return attach(argv, o);
  };
  assert.equal(await cmdCloud(ctx, "rebuild-relay", { checkout: CHECKOUT, sleep: noWait }), 0);
  // The new relay's cloud-init needs its metadata service; the dev VM's stays off.
  assert.ok(applies[0].argv.includes("-replace=aws_instance.relay"), applies[0].argv);
  assert.deepEqual(applies[0].metadata, [false, true]);
  assert.ok(!called(ctx).some((c) => c.includes("aws_instance.dev")), called(ctx).join("\n"));
  // Only the relay's key is forgotten, then asked about again.
  assert.deepEqual(called(ctx).filter((c) => c.startsWith("ssh-keygen -R")).map((c) => c.split(" ")[2]), ["203.0.113.21"]);
  assert.ok(attached(ctx).some((a) => a.endsWith("ubuntu@203.0.113.21 true")), attached(ctx).join("\n"));
  assert.ok(!attached(ctx).some((a) => a.endsWith("ubuntu@203.0.113.20 true")), attached(ctx).join("\n"));
  assert.match(readFileSync(knownHostsPath(), "utf8"), /^203\.0\.113\.20 /m);
  // The install starts again without the playbook and the relay step.
  assert.deepEqual(applies[1].done, ["vm", "inventory", "ssh", "claude"]);
  assert.ok(attached(ctx).some((a) => a.includes("contributor.yml")) && attached(ctx).some((a) => a.includes("relay.yml")));
  assert.ok(called(ctx).some((c) => c.includes("'install'") && c.includes("github-token")), called(ctx).join("\n"));
  assert.deepEqual(loadHosts()[0].done, CLOUD_ALL);
  // Last, the rotation runbook: the old credentials still work on GitHub.
  const runbook = ctx.out_lines.slice(-4).join("\n");
  assert.match(runbook, /revoke the old token/);
  assert.match(runbook, /remove the old signing key/);
});

test("create --host updates the listed cloud host, create alone starts a new one", async () => {
  install();
  const ctx = laptop({ answers: [1, 2, 2] });
  assert.equal(await cmdCloud(ctx, "create", { host: "forge-dev", checkout: CHECKOUT, sleep: noWait }), 0);
  // What start and stop refuse to apply, create --host shows and applies.
  const apply = attached(ctx).findIndex((a) => a.startsWith("tofu ") && a.includes(" apply ") && !a.includes("-replace"));
  assert.ok(apply >= 0, attached(ctx).join("\n"));
  assert.ok(apply < attached(ctx).findIndex((a) => a.includes("contributor.yml")), attached(ctx).join("\n"));
  assert.ok(!attached(ctx).some((a) => a.includes("ubuntu@")), attached(ctx).join("\n"));

  // No --host: the first question of a new cloud host (its name), unanswered here.
  const fresh = fakeContext({ rules: RULES, answers: [] });
  await assert.rejects(cmdCloud(fresh, "create", { checkout: CHECKOUT, sleep: noWait }));
  assert.ok(fresh.err_lines.some((l) => l.includes("Host name")), fresh.err_lines.join("\n"));
});

test("create --host refuses a host that is not a cloud host", async () => {
  saveHost(host({ name: "forge-acme", kind: "remote" }));
  const ctx = fakeContext({ rules: RULES });
  await assert.rejects(cmdCloud(ctx, "create", { host: "forge-acme", checkout: CHECKOUT, sleep: noWait }),
    /forge-acme[\s\S]*forge install --host forge-acme/);
  assert.deepEqual(ctx.calls, []);
});

test("no cloud host: start fails, and a remote host is never offered", async () => {
  saveHost(host({ name: "forge-acme", kind: "remote" }));
  const ctx = fakeContext({ rules: RULES });
  await assert.rejects(cmdCloud(ctx, "start", { checkout: CHECKOUT, sleep: noWait }), /no cloud host: run forge cloud create/);
  assert.ok(!existsSync(join(hostDir("forge-acme"), "tofu.tfvars.json")));
});

// An unfinished install (the token never pasted, say) has nothing start or
// stop should touch on their own: the install resumes first.
test("start and stop refuse a host whose install is not finished, before any command", async () => {
  install(host({ done: ["vm", "inventory", "playbook", "ssh"] }));
  for (const sub of ["start", "stop"]) {
    const ctx = fakeContext({ rules: RULES });
    await assert.rejects(cmdCloud(ctx, sub, { checkout: CHECKOUT, sleep: noWait }), (e: Error) =>
      e instanceof ForgeError && /forge cloud create --host forge-dev/.test(e.message), sub);
    assert.deepEqual(ctx.calls, [], sub);
  }
});

// Installed before the relay existed: forge cloud create --host adds it first.
test("start refuses a host whose install lacks the relay step", async () => {
  install(host({ done: ["vm", "inventory", "playbook", "ssh", "claude"], relayAddress: undefined }));
  const ctx = fakeContext({ rules: RULES });
  await assert.rejects(cmdCloud(ctx, "start", { checkout: CHECKOUT, sleep: noWait }), (e: Error) =>
    e instanceof ForgeError && /forge cloud create --host forge-dev/.test(e.message));
  assert.deepEqual(ctx.calls, []);
});

test("an unknown subcommand lists the five", async () => {
  const ctx = fakeContext();
  await assert.rejects(cmdCloud(ctx, "nope"), /create\|start\|stop\|rebuild\|rebuild-relay/);
  await assert.rejects(cmdCloud(ctx, undefined), /create\|start\|stop\|rebuild\|rebuild-relay/);
});
