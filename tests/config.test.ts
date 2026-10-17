import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../cli/lib/config.ts";

const PATH = "/home/u/.config/agent-forge/config.json";
const parse = (raw: unknown) => parseConfig(PATH, raw);

// Every config error starts with the file, then names the key.
function rejects(raw: unknown, pattern: RegExp) {
  assert.throws(() => parse(raw), (e: Error) => {
    assert.ok(e.message.startsWith(`${PATH}: `), e.message);
    assert.match(e.message, pattern);
    return true;
  });
}

function withFile(content: string | null, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "forge-config-"));
  const path = join(dir, "config.json");
  if (content !== null) writeFileSync(path, content);
  try { fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the defaults are the spec's", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    network: { ipv4Address: "10.77.0.1/24" },
    storagePool: "default",
    limits: { cpu: null, memory: "75%", processes: 10000, rootDisk: "50GiB" },
  });
});

test("a missing file gives the defaults", () => {
  withFile(null, (path) => assert.deepEqual(loadConfig(path), DEFAULT_CONFIG));
});

test("an empty object gives the defaults", () => {
  withFile("{}", (path) => assert.deepEqual(loadConfig(path), DEFAULT_CONFIG));
});

test("invalid JSON names the file", () => {
  withFile("", (path) => assert.throws(() => loadConfig(path), (e: Error) => {
    assert.ok(e.message.startsWith(`${path}: invalid JSON`), e.message);
    return true;
  }));
});

test("the file's content must be an object", () => {
  for (const raw of [[], null, "x", 3]) rejects(raw, /must be a JSON object/);
});

test("set keys override, the others keep their defaults", () => {
  const c = parse({ limits: { cpu: 4 } });
  assert.equal(c.limits.cpu, 4);
  assert.equal(c.limits.memory, "75%");
  assert.equal(c.network.ipv4Address, "10.77.0.1/24");
});

test("every key can be set", () => {
  const raw = {
    network: { ipv4Address: "192.168.50.1/24" },
    storagePool: "fast",
    limits: { cpu: "0-3", memory: "12GiB", processes: 4096, rootDisk: "100GiB" },
  };
  assert.deepEqual(parse(raw), raw);
});

test("parsing never mutates the defaults", () => {
  parse({ limits: { cpu: 2 } });
  assert.equal(DEFAULT_CONFIG.limits.cpu, null);
});

test("an unknown key is an error naming it", () => {
  rejects({ netwrok: {} }, /unknown key netwrok/);
  rejects({ limits: { memroy: "1GiB" } }, /unknown key limits\.memroy/);
  rejects({ network: { ipv6Address: "fd00::1/64" } }, /unknown key network\.ipv6Address/);
});

test("the bridge address needs its prefix", () => {
  rejects({ network: { ipv4Address: "10.77.0.1" } }, /network\.ipv4Address must be/);
  rejects({ network: { ipv4Address: 10 } }, /network\.ipv4Address must be/);
});

test("the bridge subnet must lie in a private range", () => {
  for (const a of ["8.8.8.1/24", "100.64.0.1/24", "172.32.0.1/24", "10.0.0.1/7"]) {
    rejects({ network: { ipv4Address: a } }, /network\.ipv4Address/);
  }
});

test("the bridge address must be a host address of its subnet", () => {
  for (const a of ["10.77.0.0/24", "10.77.0.255/24", "10.77.0.1/31"]) {
    rejects({ network: { ipv4Address: a } }, /network\.ipv4Address/);
  }
});

test("limits.cpu takes null, a count or a CPU set", () => {
  assert.equal(parse({ limits: { cpu: null } }).limits.cpu, null);
  assert.equal(parse({ limits: { cpu: "0,2,4-7" } }).limits.cpu, "0,2,4-7");
  for (const bad of [0, -1, 1.5, true, "four", ""]) rejects({ limits: { cpu: bad } }, /limits\.cpu/);
});

test("limits.memory takes a size or a percentage", () => {
  assert.equal(parse({ limits: { memory: "512MiB" } }).limits.memory, "512MiB");
  for (const bad of ["120%", "0%", "lots", 12, "12 GiB"]) rejects({ limits: { memory: bad } }, /limits\.memory/);
});

test("limits.processes is a positive integer", () => {
  for (const bad of [0, -5, 1.5, "10000"]) rejects({ limits: { processes: bad } }, /limits\.processes/);
});

test("limits.rootDisk is a size", () => {
  for (const bad of ["50%", "", 50]) rejects({ limits: { rootDisk: bad } }, /limits\.rootDisk/);
});

test("storagePool is a pool name", () => {
  for (const bad of ["", "-x", 3]) rejects({ storagePool: bad }, /storagePool/);
});
