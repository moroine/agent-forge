import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { laptopDataDir, laptopStateDir, limaHome, sshDir } from "../cli/lib/paths.ts";
import {
  forgeKeyPath, forgetHost, hostDir, inventoryPath, knownHostsPath, loadHosts, saveHost, selectHost, validHostName,
  type LaptopHost,
} from "../cli/lib/laptop/state.ts";

const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_SSH_DIR", "LIMA_HOME"];
let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), "forge-laptop-"));
  process.env.FORGE_HOME = tmp;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

function host(name: string, over: Partial<LaptopHost> = {}): LaptopHost {
  return {
    name, kind: "remote", address: "203.0.113.10", port: 22, user: "forge", admin: "alice",
    adminKey: join(tmp, "admin-key"), exposure: "public", done: ["vm", "inventory"], ...over,
  };
}

test("paths honour their env overrides", () => {
  assert.equal(sshDir(), join(tmp, ".ssh"));
  assert.equal(limaHome(), join(tmp, ".lima"));
  assert.equal(laptopStateDir(), join(tmp, ".config", "agent-forge"));
  assert.equal(laptopDataDir(), join(tmp, ".local", "share", "agent-forge"));
  process.env.FORGE_SSH_DIR = join(tmp, "ssh");
  process.env.LIMA_HOME = join(tmp, "lima");
  assert.equal(sshDir(), join(tmp, "ssh"));
  assert.equal(limaHome(), join(tmp, "lima"));
});

test("state paths live under the state directory", () => {
  const state = laptopStateDir();
  assert.equal(hostDir("forge-acme"), join(state, "hosts", "forge-acme"));
  assert.equal(inventoryPath("forge-acme"), join(state, "hosts", "forge-acme", "inventory.yml"));
  assert.equal(forgeKeyPath("forge-acme"), join(state, "hosts", "forge-acme", "forge-key.pub"));
  assert.equal(knownHostsPath(), join(state, "known_hosts"));
});

test("loadHosts returns [] when there is no file", () => {
  assert.deepEqual(loadHosts(), []);
});

test("two hosts round-trip, with the optional identityAgent and deployed commit", () => {
  const a = host("forge-acme", { deployed: "0123456789abcdef0123456789abcdef01234567" });
  const b = host("forge-local", { kind: "lima", exposure: "local", identityAgent: "/run/agent.sock", done: [] });
  saveHost(a);
  saveHost(b);
  assert.deepEqual(loadHosts(), [a, b]);
});

test("saveHost replaces a host by name", () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-local"));
  saveHost(host("forge-acme", { address: "203.0.113.11", done: ["vm"] }));
  const hosts = loadHosts();
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].address, "203.0.113.11");
  assert.deepEqual(hosts[0].done, ["vm"]);
});

test("forgetHost removes only the named host", () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-local"));
  forgetHost("forge-acme");
  assert.deepEqual(loadHosts().map((h) => h.name), ["forge-local"]);
  forgetHost("forge-nope");
  assert.equal(loadHosts().length, 1);
});

test("the state file is 0600 and its directory 0700", () => {
  saveHost(host("forge-acme"));
  assert.equal(statSync(join(laptopStateDir(), "hosts.json")).mode & 0o777, 0o600);
  assert.equal(statSync(laptopStateDir()).mode & 0o777, 0o700);
});

function writeState(text: string): string {
  mkdirSync(laptopStateDir(), { recursive: true });
  const path = join(laptopStateDir(), "hosts.json");
  writeFileSync(path, text);
  return path;
}

test("a corrupt file is a ForgeError naming the file", () => {
  const path = writeState("{not json");
  assert.throws(() => loadHosts(), (e: unknown) => e instanceof ForgeError && (e as Error).message.includes(path));
});

test("an invalid schema is a ForgeError naming the file", () => {
  const good = host("forge-acme");
  const cases: unknown[] = [
    { hosts: "x" },
    [{ ...good, kind: "vm" }],
    [{ ...good, exposure: "open" }],
    [{ ...good, done: ["nope"] }],
    [{ ...good, port: "22" }],
    [{ ...good, adminKey: undefined }],
    [{ ...good, identityAgent: 3 }],
    [{ ...good, deployed: 3 }],
    // A name that is a path would turn hostDir(name) into the state directory or outside it.
    [{ ...good, name: ".." }],
    [{ ...good, name: "../x" }],
    [{ ...good, name: "acme" }],
  ];
  for (const c of cases) {
    const path = writeState(JSON.stringify(c));
    assert.throws(() => loadHosts(), (e: unknown) => e instanceof ForgeError && (e as Error).message.includes(path));
  }
});

test("selectHost with no host asks for forge install", async () => {
  await assert.rejects(selectHost(fakeContext()), /no forge host yet: run forge install/);
});

test("selectHost returns the only host", async () => {
  saveHost(host("forge-acme"));
  assert.equal((await selectHost(fakeContext())).name, "forge-acme");
});

test("selectHost picks among several hosts", async () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-local"));
  assert.equal((await selectHost(fakeContext({ answers: [2] }))).name, "forge-local");
});

test("selectHost without an answer asks for --host", async () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-local"));
  await assert.rejects(selectHost(fakeContext({ tty: false })), /--host/);
});

test("selectHost honours --host and lists names for an unknown one", async () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-local"));
  assert.equal((await selectHost(fakeContext(), "forge-acme")).name, "forge-acme");
  await assert.rejects(selectHost(fakeContext(), "forge-zzz"), /forge-zzz.*forge-acme.*forge-local/);
});

test("validHostName", () => {
  assert.ok(validHostName("forge-local"));
  assert.ok(validHostName("forge-acme"));
  assert.ok(!validHostName("acme"));
  assert.ok(!validHostName("forge-"));
  assert.ok(!validHostName("forge-Acme"));
});

test("a cloud host is accepted", () => {
  writeState(JSON.stringify([host("forge-dev", { kind: "cloud" })]));
  assert.equal(loadHosts()[0].kind, "cloud");
});
