// Helpers shared by the integration suites (tests/integration/*.test.ts).
// Everything here talks to a real Incus and the real `forge`; nothing runs
// unless a suite is enabled with FORGE_INTEGRATION=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { strictModeSupported } from "../../cli/lib/host.ts";

export const ENABLED = process.env.FORGE_INTEGRATION === "1";
// Instances are deleted only when both their name prefix and their sentinel
// repo match (v1's double guard). The peer sentinel marks a second container
// that must not be the one `forge egress forge-selftest/throwaway` finds.
export const PREFIX = "agent-forge-selftest-";
export const SENTINEL = "forge-selftest/throwaway";
export const SENTINEL_PEER = "forge-selftest/peer";
export const FORGE = resolve("cli/forge");
export const REPO_ROOT = resolve(".");

export type Run = { status: number | null; stdout: string; stderr: string };

export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Run {
  // A default timeout, so a host-side hang cannot block the suite; a timed-out
  // run has status null and says so in stderr.
  const r = spawnSync(cmd, args, {
    encoding: "utf8", input: opts.input ?? "", env: { ...process.env, ...opts.env }, timeout: opts.timeout ?? 600_000,
  });
  const failure = r.error ? `${String(r.error)}${(r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? " (timed out)" : ""}` : "";
  return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${failure}` };
}
export const incus = (project: string, args: string[], input?: string) =>
  run("incus", ["--project", project, ...args], { input });
// `env` adds variables on top of FORGE_INCUS_PROJECT (FORGE_PROXY_SLOT, XDG_CONFIG_HOME…).
export const forge = (project: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  run(FORGE, args, { env: { ...env, FORGE_INCUS_PROJECT: project } });
export const raw = (label: string, r: Run) =>
  `${label}\n  exit=${r.status}\n  stdout=${JSON.stringify(r.stdout)}\n  stderr=${JSON.stringify(r.stderr)}`;
export function must(label: string, r: Run): Run {
  assert.equal(r.status, 0, raw(label, r));
  return r;
}

// Removes what a previous run (or this one) left in a test project, then the
// project. Instances: only ours (prefix and sentinel), plus the build
// instance a failed image build leaves and forge-proxy (created by `forge
// setup`, so ours in a test project). Images and the profiles: the project is
// a test project, all of it is ours. The two ACLs named after the project live
// in `default`: they are ours too, nothing else is touched there.
export function teardownProject(project: string) {
  assert.ok(project.startsWith("forge-selftest"), `refusing to tear down ${project}`);
  // The ACLs live in `default` and outlive their project: remove them first.
  for (const acl of [`forge-proxy-${project}`, `forge-egress-strict-${project}`]) {
    incus("default", ["network", "acl", "delete", acl]);
  }
  const list = incus(project, ["list", "-f", "json"]);
  if (list.status !== 0) return;
  for (const inst of JSON.parse(list.stdout) as { name: string }[]) {
    const repo = incus(project, ["config", "get", inst.name, "user.forge.repo"]).stdout.trim();
    const ours = inst.name.startsWith(PREFIX) && (repo === SENTINEL || repo === SENTINEL_PEER);
    if (ours || inst.name === "forge-image-build" || inst.name === "forge-proxy") {
      incus(project, ["delete", inst.name, "--force"]);
    } else {
      console.error(`WARNING: leaving ${inst.name} in ${project} alone (repo=${JSON.stringify(repo)})`);
    }
  }
  const images = incus(project, ["image", "list", "-f", "json"]);
  if (images.status === 0) {
    for (const img of JSON.parse(images.stdout) as { fingerprint: string }[]) {
      incus(project, ["image", "delete", img.fingerprint]);
    }
  }
  incus(project, ["profile", "delete", "agent-forge"]);
  incus(project, ["profile", "delete", "forge-proxy"]);
  // The ACLs were attempted first; retry now that their users are gone.
  for (const acl of [`forge-proxy-${project}`, `forge-egress-strict-${project}`]) {
    incus("default", ["network", "acl", "delete", acl]);
  }
  const removed = run("incus", ["project", "delete", project]);
  if (removed.status !== 0) console.error(raw(`WARNING: project ${project} not deleted — inspect it`, removed));
}

export function launch(project: string, name: string, repo: string = SENTINEL) {
  must(`launch ${name}`, incus(project, ["launch", "agent-base", name, "--profile", "agent-forge", "-c", `user.forge.repo=${repo}`]));
  waitReady(project, name);
}

// Right after `incus launch`, systemctl answers nothing (systemd's bus is not
// up yet) or "offline" (systemd is not PID 1 yet) before it reports a real
// state: retry on both (as forge's waitReady), fail on any other state.
export function waitReady(project: string, name: string) {
  let last: Run = { status: null, stdout: "", stderr: "" };
  for (let i = 0; i < 60; i++) {
    last = incus(project, ["exec", name, "--", "systemctl", "is-system-running", "--wait"]);
    const state = last.stdout.trim();
    if (state === "running" || state === "degraded") return;
    if (state !== "" && state !== "offline") assert.fail(raw(`${name} is ${state}`, last));
    spawnSync("sleep", ["1"]);
  }
  assert.fail(raw(`${name} never became ready`, last));
}

// Copies agent-base from one project of this server to another.
// `incus image copy` between two projects of one server needs the server to
// listen on the network (pull) or a client temp dir as big as the image
// (relay, in a small tmpfs /tmp): export and import through the disk instead.
export function copyImage(from: string, to: string): Run {
  const dir = mkdtempSync(join(homedir(), "forge-selftest-img-"));
  try {
    const exported = incus(from, ["image", "export", "agent-base", dir]);
    if (exported.status !== 0) return exported;
    const file = readdirSync(dir).find((f) => f.endsWith(".tar.gz") || f.endsWith(".tar.xz") || f.endsWith(".tar.zst"));
    if (!file) return { status: 1, stdout: "", stderr: `no exported image file in ${dir}: ${readdirSync(dir).join(", ")}` };
    return incus(to, ["image", "import", join(dir, file), "--alias", "agent-base"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const asAgent = (project: string, name: string, cmd: string) =>
  incus(project, ["exec", name, "--", "su", "-", "aiuser", "-c", cmd]);

// True when the host's Incus fails the strict-mode version gate (e.g. 7.0.1
// while 7.0.2 is not packaged): the egress suite then lifts the gate for its
// own forge-selftest project through the test-only override.
export function incusBelowGate(): boolean {
  const r = run("incus", ["query", "/1.0"]);
  if (r.status !== 0) return false;
  const version = (JSON.parse(r.stdout) as { environment?: { server_version?: string } }).environment?.server_version ?? "";
  return !strictModeSupported(version);
}
