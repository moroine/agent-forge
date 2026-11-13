import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromEnv, createWatchdog, fullAvg10, pickVictim, readProc, type Config, type Proc,
} from "../ansible/roles/forge_memory_watchdog/files/memory-watchdog.ts";

const ME = 1000;
let root: string;
let clock: number;
let killed: number[];
let lines: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-watchdog-"));
  mkdirSync(join(root, "cgroup"));
  mkdirSync(join(root, "proc"));
  clock = 0;
  killed = [];
  lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (extra: Partial<Config> = {}): Config => ({
  cgroupRoot: join(root, "cgroup"), prefix: "lxc.payload.agent-forge_", procRoot: join(root, "proc"),
  threshold: 20, seconds: 15, intervalMs: 1000, uid: ME, ...extra,
});
const dog = (extra: Partial<Config> = {}) =>
  createWatchdog(config(extra), { now: () => clock, kill: (pid) => { killed.push(pid); }, log: (l) => lines.push(l) });

const PSI = (full: number) =>
  `some avg10=${full + 4} avg60=1.00 avg300=0.10 total=1\nfull avg10=${full.toFixed(2)} avg60=1.00 avg300=0.10 total=1\n`;

function cgroup(name: string, full: number, pids: Record<string, number[]>) {
  const dir = join(root, "cgroup", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.pressure"), PSI(full));
  for (const [sub, list] of Object.entries(pids)) {
    const d = sub === "" ? dir : join(dir, sub);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "cgroup.procs"), list.map(String).join("\n") + "\n");
  }
}
const setPressure = (name: string, full: number) => writeFileSync(join(root, "cgroup", name, "memory.pressure"), PSI(full));

function proc(pid: number, o: { name?: string; rssKib?: number; uid?: number; nspid?: string; args?: string[] } = {}) {
  const dir = join(root, "proc", String(pid));
  mkdirSync(dir, { recursive: true });
  const rss = o.rssKib === undefined ? "" : `VmRSS:\t${o.rssKib} kB\n`;
  writeFileSync(join(dir, "status"),
    `Name:\t${o.name ?? "node"}\nUid:\t${o.uid ?? ME}\t${o.uid ?? ME}\t${o.uid ?? ME}\t${o.uid ?? ME}\n` +
    `NSpid:\t${o.nspid ?? `${pid}\t${pid - 100000}`}\n${rss}`);
  writeFileSync(join(dir, "cmdline"), (o.args ?? [o.name ?? "node"]).join("\0") + "\0");
}

const C = "lxc.payload.agent-forge_agent-acme-widgets";
// Ticks once a second, from `from` to `to` seconds included.
function run(d: ReturnType<typeof dog>, from: number, to: number) {
  for (let s = from; s <= to; s++) { clock = s * 1000; d.tick(); }
}

test("full avg10 is read from memory.pressure, null when there is none", () => {
  assert.equal(fullAvg10(PSI(51.87)), 51.87);
  assert.equal(fullAvg10("some avg10=1.00 avg60=0 avg300=0 total=0\n"), null);
  assert.equal(fullAvg10(null), null);
});

test("the biggest process is killed once the pressure has held for the whole duration", () => {
  cgroup(C, 51.87, { "": [101], "user.slice": [202, 303] });
  proc(101, { name: "systemd", rssKib: 9000, uid: 100000, nspid: "101\t1" });
  proc(202, { name: "node", rssKib: 40000 });
  proc(303, { name: "eslint", rssKib: 9_800_000 });
  const d = dog();
  run(d, 0, 14);
  assert.deepEqual(killed, [], "14 s is not enough");
  run(d, 15, 15);
  assert.deepEqual(killed, [303]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^agent-acme-widgets: killed pid 303 \(eslint, 9\.3 GiB RSS\), the biggest of its processes: /);
  assert.match(lines[0], /full avg10=51\.87 has been 20 or above for 15 s$/);
});

test("a pressure that dips below the threshold starts the count again", () => {
  cgroup(C, 30, { "": [303] });
  proc(303, { rssKib: 5000 });
  const d = dog();
  run(d, 0, 10);
  setPressure(C, 3);
  run(d, 11, 11);
  setPressure(C, 30);
  run(d, 12, 25);
  assert.deepEqual(killed, [], "the 15 s were not continuous");
  run(d, 26, 27);
  assert.deepEqual(killed, [303]);
});

test("PID 1 of the container, claude and other users' processes are spared", () => {
  cgroup(C, 40, { "": [1001, 1002, 1003, 1004, 1005, 1006] });
  proc(1001, { name: "systemd", rssKib: 900000, nspid: "1001\t1" });
  proc(1002, { name: "claude", rssKib: 800000 });
  // Claude Code run by node: the script's name is the second argument.
  proc(1003, { name: "node", rssKib: 700000, args: ["node", "/usr/lib/claude-code/bin/claude", "--resume"] });
  proc(1004, { name: "journald", rssKib: 600000, uid: 100000 });
  proc(1005, { name: "vite", rssKib: 500000 });
  // The init of a nested namespace (a rootless Docker container) is not the container's.
  proc(1006, { name: "app", rssKib: 100000, nspid: "1006\t77\t1" });
  const d = dog();
  run(d, 0, 15);
  assert.deepEqual(killed, [1005]);
});

test("the claude of a script named like it in another position is not spared", () => {
  cgroup(C, 40, { "": [1] });
  proc(1, { name: "node", rssKib: 100, args: ["node", "build.js", "claude"] });
  const d = dog();
  run(d, 0, 15);
  assert.deepEqual(killed, [1]);
});

test("a container with nothing to kill is said once, not at every tick", () => {
  cgroup(C, 40, { "": [1] });
  proc(1, { name: "systemd", rssKib: 100, nspid: "1\t1" });
  const d = dog();
  run(d, 0, 40);
  assert.deepEqual(killed, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent-acme-widgets: .*and no process can be killed/);
});

test("kernel threads (no VmRSS) and processes that exited are skipped", () => {
  cgroup(C, 40, { "": [10, 11, 12] });
  proc(10, { name: "kworker" });
  proc(11, { rssKib: 50 });
  // 12 has no /proc entry.
  const d = dog();
  run(d, 0, 15);
  assert.deepEqual(killed, [11]);
});

test("after a kill, a second one waits for the threshold to hold again", () => {
  cgroup(C, 40, { "": [1, 2] });
  proc(1, { rssKib: 900 });
  proc(2, { rssKib: 800 });
  const d = dog();
  run(d, 0, 15);
  assert.deepEqual(killed, [1]);
  run(d, 16, 29);
  assert.deepEqual(killed, [1], "still counting from the kill");
  run(d, 30, 31);
  assert.deepEqual(killed, [1, 1], "pid 1 is still in the fake tree: the same biggest is picked again");
});

test("only cgroups of the watched prefix are looked at, each on its own", () => {
  cgroup(C, 40, { "": [1] });
  cgroup("lxc.payload.agent-forge_other", 2, { "": [2] });
  cgroup("lxc.payload.forge-selftest_x", 90, { "": [3] });
  cgroup("user.slice", 90, { "": [4] });
  proc(1, { rssKib: 10 }); proc(2, { rssKib: 20 }); proc(3, { rssKib: 30 }); proc(4, { rssKib: 40 });
  const d = dog();
  run(d, 0, 15);
  assert.deepEqual(killed, [1]);
});

test("a kill that fails is logged and does not stop the watchdog", () => {
  cgroup(C, 40, { "": [1] });
  proc(1, { rssKib: 10 });
  const d = createWatchdog(config(), {
    now: () => clock, log: (l) => lines.push(l),
    kill: () => { throw new Error("EPERM: operation not permitted"); },
  });
  run(d, 0, 15);
  assert.match(lines[0], /agent-acme-widgets: could not kill pid 1 \(node\): EPERM/);
});

test("threshold, duration and prefix come from the environment, with defaults", () => {
  assert.deepEqual(configFromEnv({}, 7), {
    cgroupRoot: "/sys/fs/cgroup", prefix: "lxc.payload.agent-forge_", procRoot: "/proc",
    threshold: 20, seconds: 15, intervalMs: 1000, uid: 7,
  });
  const c = configFromEnv({ FORGE_WATCHDOG_THRESHOLD: "35", FORGE_WATCHDOG_SECONDS: "30", FORGE_WATCHDOG_INTERVAL: "2" }, 7);
  assert.deepEqual([c.threshold, c.seconds, c.intervalMs], [35, 30, 2000]);
  assert.throws(() => configFromEnv({ FORGE_WATCHDOG_SECONDS: "soon" }, 7), /FORGE_WATCHDOG_SECONDS must be a positive number/);
  assert.throws(() => configFromEnv({ FORGE_WATCHDOG_THRESHOLD: "0" }, 7), /FORGE_WATCHDOG_THRESHOLD/);
});

test("readProc and pickVictim agree on a plain process", () => {
  proc(5, { name: "node", rssKib: 42 });
  const p = readProc(join(root, "proc"), 5) as Proc;
  assert.deepEqual([p.pid, p.name, p.rssKib, p.uid, p.containerInit], [5, "node", 42, ME, false]);
  assert.equal(pickVictim([p], ME)?.pid, 5);
  assert.equal(pickVictim([p], ME + 1), null);
});
