// Layer 3: the real `incus` and the real `forge`, opt-in, on a throwaway test
// Incus (the v2 runtime plan's "Test Incus": a Lima VM). Run inside it:
//
//   FORGE_INTEGRATION=1 npm run test:integration
//   FORGE_INTEGRATION=1 FORGE_INTEGRATION_IMAGE=1 npm run test:integration   # adds a full image build (slow)
//
// Everything happens in two throwaway projects, forge-selftest and
// forge-selftest-restricted, reached through FORGE_INCUS_PROJECT. Instances
// are deleted only when both their name prefix and their sentinel match (v1's
// double guard). forgebr0 and forge-egress live in the default project and
// may be shared with a real agent-forge project: they are left in place.
//
// Without FORGE_INTEGRATION_IMAGE, the tests that need a container copy
// agent-base from the agent-forge project (built once with `forge image
// build`); when there is none, they are skipped with a message.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

const ENABLED = process.env.FORGE_INTEGRATION === "1";
const BUILD_IMAGE = process.env.FORGE_INTEGRATION_IMAGE === "1";
const PROJECT = "forge-selftest";
const RESTRICTED = "forge-selftest-restricted";
const PREFIX = "agent-forge-selftest-";
const SENTINEL = "forge-selftest/throwaway";
const FORGE = resolve("cli/forge");

type Run = { status: number | null; stdout: string; stderr: string };

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Run {
  const r = spawnSync(cmd, args, { encoding: "utf8", input: opts.input ?? "", env: { ...process.env, ...opts.env } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}
const incus = (project: string, args: string[], input?: string) => run("incus", ["--project", project, ...args], { input });
const forge = (project: string, args: string[]) => run(FORGE, args, { env: { FORGE_INCUS_PROJECT: project } });
const raw = (label: string, r: Run) =>
  `${label}\n  exit=${r.status}\n  stdout=${JSON.stringify(r.stdout)}\n  stderr=${JSON.stringify(r.stderr)}`;
function must(label: string, r: Run): Run {
  assert.equal(r.status, 0, raw(label, r));
  return r;
}

// Removes what a previous run (or this one) left in a test project, then the
// project. Instances: only ours (prefix and sentinel), plus the build
// instance a failed image build leaves. Images and the profile: the project
// is a test project, all of it is ours.
function teardownProject(project: string) {
  const list = incus(project, ["list", "-f", "json"]);
  if (list.status !== 0) return;
  for (const inst of JSON.parse(list.stdout) as { name: string }[]) {
    const repo = incus(project, ["config", "get", inst.name, "user.forge.repo"]).stdout.trim();
    if ((inst.name.startsWith(PREFIX) && repo === SENTINEL) || inst.name === "forge-image-build") {
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
  const removed = run("incus", ["project", "delete", project]);
  if (removed.status !== 0) console.error(raw(`WARNING: project ${project} not deleted — inspect it`, removed));
}

function launch(project: string, name: string) {
  must(`launch ${name}`, incus(project, ["launch", "agent-base", name, "--profile", "agent-forge", "-c", `user.forge.repo=${SENTINEL}`]));
  const ready = incus(project, ["exec", name, "--", "systemctl", "is-system-running", "--wait"]);
  assert.match(ready.stdout, /^(running|degraded)$/m, raw(`${name} never became ready`, ready));
}
const asAgent = (project: string, name: string, cmd: string) =>
  incus(project, ["exec", name, "--", "su", "-", "aiuser", "-c", cmd]);

let workspaces = "";
let haveImage = false;
let c1 = "";
let c2 = "";

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  must("no usable incus client", run("incus", ["--version"]));
  teardownProject(PROJECT);
  teardownProject(RESTRICTED);
  // In the home: the restricted project's restricted.devices.disk.paths names
  // this directory.
  workspaces = mkdtempSync(join(homedir(), "forge-selftest-ws-"));
});

after(() => {
  if (!ENABLED) return;
  teardownProject(PROJECT);
  teardownProject(RESTRICTED);
  if (workspaces) rmSync(workspaces, { recursive: true, force: true });
});

test("forge setup converges, then reports only unchanged", { skip: !ENABLED }, () => {
  const first = must("first forge setup", forge(PROJECT, ["setup"]));
  assert.match(first.stdout, /^profile agent-forge: created$/m, raw("first setup", first));
  // The JSON forge sends on stdin was taken as YAML: the profile has forge's values.
  const idmap = must("profile get raw.idmap", incus(PROJECT, ["profile", "get", "agent-forge", "raw.idmap"]));
  assert.equal(idmap.stdout.trim(), `uid ${process.getuid!()} 1001\ngid ${process.getgid!()} 1001`, raw("raw.idmap", idmap));
  const second = must("second forge setup", forge(PROJECT, ["setup"]));
  const lines = second.stdout.trim().split("\n");
  assert.equal(lines.length, 4, raw("second setup", second));
  for (const line of lines) assert.match(line, /: unchanged$/, raw("second setup", second));
});

test("agent-base is available in the test project", { skip: !ENABLED }, () => {
  if (BUILD_IMAGE) {
    must("forge image build", forge(PROJECT, ["image", "build"]));
    const head = must("git rev-parse HEAD", run("git", ["rev-parse", "HEAD"])).stdout.trim();
    const stamp = must("image stamp", incus(PROJECT, ["image", "get-property", "agent-base", "user.forge.commit"]));
    assert.equal(stamp.stdout.trim(), head);
    haveImage = true;
    return;
  }
  const copy = run("incus", ["image", "copy", "agent-base", "local:", "--project", "agent-forge",
    "--target-project", PROJECT, "--alias", "agent-base"]);
  // A failed copy fails the run: a run that tests nothing must not look green.
  if (copy.status !== 0) {
    assert.fail(`no agent-base in project agent-forge to copy (run 'forge image build' once, or set FORGE_INTEGRATION_IMAGE=1): ${copy.stderr}`);
  }
  haveImage = true;
});

test("containers launch from agent-base under the forge profile", { skip: !ENABLED }, (t) => {
  if (!haveImage) return t.skip("no agent-base");
  const id = Math.random().toString(36).slice(2, 8);
  c1 = `${PREFIX}${id}-1`;
  c2 = `${PREFIX}${id}-2`;
  launch(PROJECT, c1);
  launch(PROJECT, c2);
});

// A TCP connection attempt from c1; exit code 0 means it connected.
const connect = (host: string, port: number) =>
  incus(PROJECT, ["exec", c1, "--", "timeout", "5", "bash", "-c", `</dev/tcp/${host}/${port}`]);

test("network: the internet answers and DNS works", { skip: !ENABLED }, (t) => {
  if (!c1) return t.skip("no container");
  const web = incus(PROJECT, ["exec", c1, "--", "curl", "-sS", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"]);
  assert.equal(web.stdout.trim(), "200", raw("https://example.com from the container", web));
  must("DNS from the container", incus(PROJECT, ["exec", c1, "--", "getent", "hosts", "example.com"]));
});

test("network: the bridge, the host's other address and the metadata address do not answer", { skip: !ENABLED }, (t) => {
  if (!c1) return t.skip("no container");
  const bridge = must("bridge address", incus(PROJECT, ["network", "get", "forgebr0", "ipv4.address"])).stdout.trim().split("/")[0];
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal && i.address !== bridge)?.address;
  assert.ok(lan, "the test VM has no IPv4 address besides the bridge's");
  // Host-side proof that the targets answer without the ACL: sshd listens on
  // every host address, so without the ACL both would answer the container.
  for (const host of [bridge, lan]) {
    must(`host → ${host}:22`, run("bash", ["-c", `timeout 5 bash -c '</dev/tcp/${host}/22'`]));
  }
  // Positive control: the same probe from the container reaches the internet,
  // so a broken probe (no timeout, no /dev/tcp) cannot pass the denials below.
  must("positive control: the same probe reaches example.com:443 from the container", connect("example.com", 443));
  for (const [host, port] of [[bridge, 22], [lan, 22], ["169.254.169.254", 80]] as [string, number][]) {
    const r = connect(host, port);
    assert.notEqual(r.status, 0, raw(`${host}:${port} answered from the container`, r));
  }
});

test("network: a second container is unreachable", { skip: !ENABLED }, (t) => {
  if (!c2) return t.skip("no container");
  must("listener in the second container", incus(PROJECT, ["exec", c2, "--", "bash", "-c",
    "setsid python3 -m http.server 9000 >/dev/null 2>&1 < /dev/null &"]));
  const listed = JSON.parse(must("list", incus(PROJECT, ["list", c2, "-f", "json"])).stdout);
  const peer = listed[0].state.network.eth0.addresses.find((a: { family: string }) => a.family === "inet").address;
  // The host reaches it, so the listener is up...
  must(`host → ${peer}:9000`, run("bash", ["-c",
    `for i in 1 2 3 4 5; do timeout 2 bash -c '</dev/tcp/${peer}/9000' && exit 0; sleep 1; done; exit 1`]));
  // ...and the first container does not.
  const r = connect(peer, 9000);
  assert.notEqual(r.status, 0, raw(`${peer}:9000 answered from ${c1}`, r));
});

test("userns: the agent's user gets user namespaces, Chrome's sandbox and rootless Docker", { skip: !ENABLED }, (t) => {
  if (!c1) return t.skip("no container");
  must("unshare -Ur as aiuser", asAgent(PROJECT, c1, "unshare -Ur true"));
  const chrome = asAgent(PROJECT, c1,
    'd=$(mktemp -d) && timeout 60 google-chrome-stable --headless=new --disable-gpu --user-data-dir="$d" --dump-dom about:blank; rc=$?; rm -rf "$d"; exit $rc');
  assert.equal(chrome.status, 0, raw("Chrome with its sandbox", chrome));
  assert.match(chrome.stdout, /<html/);
  // The user daemon starts after systemd reports the system ready: give it time.
  const docker = must("docker info as aiuser", asAgent(PROJECT, c1,
    "for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker info"));
  assert.match(docker.stdout, /^\s+rootless$/m, raw("docker info", docker));
});

test("idmap: a file the agent creates in /workspace belongs to the host user", { skip: !ENABLED }, (t) => {
  if (!c1) return t.skip("no container");
  const dir = join(workspaces, "c1");
  mkdirSync(dir);
  must("add the workspace disk", incus(PROJECT, ["config", "device", "add", c1, "workspace", "disk", `source=${dir}`, "path=/workspace"]));
  must("touch as aiuser", asAgent(PROJECT, c1, "touch /workspace/idmap-probe"));
  const st = statSync(join(dir, "idmap-probe"));
  assert.equal(st.uid, process.getuid!());
  assert.equal(st.gid, process.getgid!());
});

test("restricted project: setup drops raw.lxc, and an instance runs with its workspace", { skip: !ENABLED }, (t) => {
  if (!haveImage) return t.skip("no agent-base");
  const uid = process.getuid!();
  const gid = process.getgid!();
  // The admin keys of the spec's "Restricted-project compatibility" table, as
  // JSON on stdin (`project create` ignores -c when stdin carries a config).
  must("create the restricted project", run("incus", ["project", "create", RESTRICTED], {
    input: JSON.stringify({
      description: "agent-forge integration test (restricted)",
      config: {
        "features.images": "true",
        "features.profiles": "true",
        "features.storage.volumes": "true",
        "features.networks": "false",
        restricted: "true",
        "restricted.containers.nesting": "allow",
        "restricted.idmap.uid": String(uid),
        "restricted.idmap.gid": String(gid),
        "restricted.devices.disk": "allow",
        "restricted.devices.disk.paths": workspaces,
      },
    }),
  }));
  const setup = must("forge setup in the restricted project", forge(RESTRICTED, ["setup"]));
  assert.match(setup.stderr, /^NOTICE: .*raw\.lxc/m, raw("expected the raw.lxc notice", setup));
  const rawLxc = incus(RESTRICTED, ["profile", "get", "agent-forge", "raw.lxc"]);
  assert.equal(rawLxc.stdout.trim(), "", raw("raw.lxc must be absent", rawLxc));
  must("copy agent-base", run("incus", ["image", "copy", "agent-base", "local:", "--project", PROJECT,
    "--target-project", RESTRICTED, "--alias", "agent-base"]));
  const name = `${PREFIX}${Math.random().toString(36).slice(2, 8)}-r`;
  launch(RESTRICTED, name);
  const dir = join(workspaces, "restricted");
  mkdirSync(dir);
  must("add the workspace disk", incus(RESTRICTED, ["config", "device", "add", name, "workspace", "disk", `source=${dir}`, "path=/workspace"]));
  must("write in /workspace as aiuser", asAgent(RESTRICTED, name, "touch /workspace/probe"));
  assert.equal(statSync(join(dir, "probe")).uid, uid);
});
