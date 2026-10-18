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
// Without FORGE_INTEGRATION_IMAGE, the tests that need a container export and
// import agent-base from the agent-forge project (built once with `forge image
// build`); when there is none, they are skipped with a message.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import { cloneWorkspace, refreshMirror, MIRROR_MOUNT, ORIGIN_DEVICE } from "../../cli/lib/mirror.ts";
import { mirrorPath } from "../../cli/lib/paths.ts";
import { HOSTILE_HOOKS, hookScript, hostileConfig } from "../lib/hostile-repo.ts";
import {
  ENABLED, FORGE, PREFIX, SENTINEL, asAgent, copyImage, forge as forgeIn, incus, launch, must, raw, run, teardownProject,
  throwawayXdg,
} from "./lib.ts";

const BUILD_IMAGE = process.env.FORGE_INTEGRATION_IMAGE === "1";
const PROJECT = "forge-selftest";
const RESTRICTED = "forge-selftest-restricted";
// Distinct proxy slots: each project has its own forge-proxy on the bridge.
const SLOTS: Record<string, string> = { [PROJECT]: "1", [RESTRICTED]: "2" };

// A throwaway XDG_CONFIG_HOME: the user's allowlist and config are never
// touched (the config is copied in, see throwawayXdg). The herdr config block
// goes to a throwaway file, never the real config.
let xdg = "";
const forge = (project: string, args: string[]) => forgeIn(project, args, {
  FORGE_PROXY_SLOT: SLOTS[project], XDG_CONFIG_HOME: xdg, HERDR_CONFIG_PATH: join(workspaces, "herdr.toml"),
});


let workspaces = "";
let mirrors = "";
let haveImage = false;
let restrictedReady = false;
let c1 = "";
let c2 = "";

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  must("no usable incus client", run("incus", ["--version"]));
  teardownProject(PROJECT);
  teardownProject(RESTRICTED);
  // In the home: the restricted project's restricted.devices.disk.paths names
  // both directories. Two siblings, as <home>/workspaces and <data>/mirrors.
  workspaces = mkdtempSync(join(homedir(), "forge-selftest-ws-"));
  xdg = throwawayXdg("forge-selftest-xdg-");
  mirrors = mkdtempSync(join(homedir(), "forge-selftest-mirrors-"));
});

after(() => {
  if (!ENABLED) return;
  teardownProject(PROJECT);
  teardownProject(RESTRICTED);
  if (workspaces) rmSync(workspaces, { recursive: true, force: true });
  if (xdg) rmSync(xdg, { recursive: true, force: true });
  if (mirrors) rmSync(mirrors, { recursive: true, force: true });
});

test("forge setup converges, then reports only unchanged", { skip: !ENABLED }, () => {
  const first = must("first forge setup", forge(PROJECT, ["setup"]));
  assert.match(first.stdout, /^profile agent-forge: created$/m, raw("first setup", first));
  // The JSON forge sends on stdin was taken as YAML: the profile has forge's values.
  const idmap = must("profile get raw.idmap", incus(PROJECT, ["profile", "get", "agent-forge", "raw.idmap"]));
  assert.equal(idmap.stdout.trim(), `uid ${process.getuid!()} 1001\ngid ${process.getgid!()} 1001`, raw("raw.idmap", idmap));
  const second = must("second forge setup", forge(PROJECT, ["setup"]));
  const lines = second.stdout.trim().split("\n");
  // Every line is "<object>: unchanged" (the herdr config's included), or the
  // allowlist's entry count (its size depends on the list, which is not an
  // object that changes).
  assert.ok(lines.length >= 5, raw("second setup", second));
  for (const line of lines) assert.match(line, /(: unchanged|^allowlist: \d+ entries)$/, raw("second setup", second));
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
  const copy = copyImage("agent-forge", PROJECT);
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

test("network: the bridge, the host's other address and the metadata address do not answer", { skip: !ENABLED }, async (t) => {
  if (!c1) return t.skip("no container");
  const bridge = must("bridge address", incus(PROJECT, ["network", "get", "forgebr0", "ipv4.address"])).stdout.trim().split("/")[0];
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal && i.address !== bridge)?.address;
  assert.ok(lan, "the test VM has no IPv4 address besides the bridge's");
  // The test's own listener on every host address. sshd is no target: the
  // host playbook moves it off 22 (found on an Ansible-provisioned host,
  // 2026-10-17). spawnSync blocks the event loop, but the kernel still
  // completes the handshakes into the listen backlog.
  const server = createServer((s) => s.destroy());
  await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
  const port = (server.address() as AddressInfo).port;
  try {
    // Host-side proof that the targets answer without the ACL.
    for (const host of [bridge, lan]) {
      must(`host → ${host}:${port}`, run("bash", ["-c", `timeout 5 bash -c '</dev/tcp/${host}/${port}'`]));
    }
    // Positive control: the same probe from the container reaches the internet,
    // so a broken probe (no timeout, no /dev/tcp) cannot pass the denials below.
    must("positive control: the same probe reaches example.com:443 from the container", connect("example.com", 443));
    for (const [host, p] of [[bridge, port], [lan, port], ["169.254.169.254", 80]] as [string, number][]) {
      const r = connect(host, p);
      assert.notEqual(r.status, 0, raw(`${host}:${p} answered from the container`, r));
    }
  } finally {
    server.close();
  }
});

test("network: a second container is unreachable", { skip: !ENABLED }, (t) => {
  if (!c2) return t.skip("no container");
  must("listener in the second container", incus(PROJECT, ["exec", c2, "--", "bash", "-c",
    "setsid python3 -m http.server 9000 >/dev/null 2>&1 < /dev/null &"]));
  const listed = JSON.parse(must("list", incus(PROJECT, ["list", c2, "-f", "json"])).stdout);
  const peer = listed[0].state.network.eth0.addresses.find((a: { family: string }) => a.family === "inet").address;
  // The ACL's default ingress action rejects connections to a container from
  // anywhere, the host included, so the listener is proven from inside c2;
  // then c1's failed connect shows that the peer is unreachable.
  must("the listener answers inside the second container", incus(PROJECT, ["exec", c2, "--", "bash", "-c",
    "for i in 1 2 3 4 5; do timeout 2 bash -c '</dev/tcp/127.0.0.1/9000' && exit 0; sleep 1; done; exit 1"]));
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
        "restricted.devices.disk.paths": `${workspaces},${mirrors}`,
      },
    }),
  }));
  const setup = must("forge setup in the restricted project", forge(RESTRICTED, ["setup"]));
  assert.match(setup.stderr, /^NOTICE: .*raw\.lxc/m, raw("expected the raw.lxc notice", setup));
  const rawLxc = incus(RESTRICTED, ["profile", "get", "agent-forge", "raw.lxc"]);
  assert.equal(rawLxc.stdout.trim(), "", raw("raw.lxc must be absent", rawLxc));
  must("copy agent-base", copyImage(PROJECT, RESTRICTED));
  restrictedReady = true;
  const name = `${PREFIX}${Math.random().toString(36).slice(2, 8)}-r`;
  launch(RESTRICTED, name);
  const dir = join(workspaces, "restricted");
  mkdirSync(dir);
  must("add the workspace disk", incus(RESTRICTED, ["config", "device", "add", name, "workspace", "disk", `source=${dir}`, "path=/workspace"]));
  must("write in /workspace as aiuser", asAgent(RESTRICTED, name, "touch /workspace/probe"));
  assert.equal(statSync(join(dir, "probe")).uid, uid);
});

// POSIX single quoting, safe for any value.
const sq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
// Host git for fixtures, with an identity and no signing.
const hostGit = (args: string[], cwd?: string) =>
  must(`git ${args.join(" ")}`, run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com",
    "-c", "commit.gpgsign=false", ...(cwd ? ["-C", cwd] : []), ...args]));

test("mirror: mounted read-only and locked", { skip: !ENABLED }, (t) => {
  if (!c1) return t.skip("no container");
  const bare = join(workspaces, "mirror-ro.git");
  hostGit(["init", "-q", "--bare", bare]);
  must("add the origin device", incus(PROJECT, ["config", "device", "add", c1, ORIGIN_DEVICE, "disk",
    `source=${bare}`, `path=${MIRROR_MOUNT}`, "readonly=true"]));
  const before = readdirSync(bare).sort();
  // Positive control: the mount is there and readable.
  must("the mount is readable", asAgent(PROJECT, c1, `ls ${MIRROR_MOUNT}/HEAD`));
  const touch = asAgent(PROJECT, c1, `touch ${MIRROR_MOUNT}/x`);
  assert.notEqual(touch.status, 0, raw("touch in the mirror succeeded", touch));
  const remount = incus(PROJECT, ["exec", c1, "--", "mount", "-o", "remount,rw", MIRROR_MOUNT]);
  assert.notEqual(remount.status, 0, raw("remount rw succeeded", remount));
  assert.deepEqual(readdirSync(bare).sort(), before, "the host directory changed");
});

// Sub-project 4's row of the restricted-project table: the mirror lives in
// <data>/mirrors, outside the workspaces, so restricted.devices.disk.paths
// names both directories.
test("restricted project: the origin mirror mounts read-only from the mirrors directory, and the workspace clones from it", { skip: !ENABLED }, async (t) => {
  if (!restrictedReady) return t.skip("no restricted project");
  const name = `${PREFIX}${Math.random().toString(36).slice(2, 8)}-m`;
  launch(RESTRICTED, name);
  // Negative control: a source under neither directory is refused, so the
  // restriction is in force and the two mounts below go through its paths.
  const outside = mkdtempSync(join(homedir(), "forge-selftest-outside-"));
  try {
    const refused = incus(RESTRICTED, ["config", "device", "add", name, "outside", "disk", `source=${outside}`, "path=/mnt/outside"]);
    assert.notEqual(refused.status, 0, raw("a disk outside restricted.devices.disk.paths was accepted", refused));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  // A stand-in "GitHub" with one commit, cloned bare into the mirrors directory.
  const standIn = join(workspaces, "restricted-standin");
  mkdirSync(standIn);
  hostGit(["init", "-q", "-b", "main", "."], standIn);
  hostGit(["commit", "-q", "--allow-empty", "-m", "seed"], standIn);
  const head = hostGit(["rev-parse", "HEAD"], standIn).stdout.trim();
  const mirror = join(mirrors, `${name}.git`);
  hostGit(["clone", "-q", "--bare", standIn, mirror]);
  const ws = join(workspaces, "restricted-clone");
  mkdirSync(ws);
  must("add origin", incus(RESTRICTED, ["config", "device", "add", name, ORIGIN_DEVICE, "disk",
    `source=${mirror}`, `path=${MIRROR_MOUNT}`, "readonly=true"]));
  must("add workspace", incus(RESTRICTED, ["config", "device", "add", name, "workspace", "disk", `source=${ws}`, "path=/workspace"]));
  // Direct evidence of the read-only mount, beside the refused writes of the
  // unrestricted test.
  const options = must("mount options", incus(RESTRICTED, ["exec", name, "--", "findmnt", "-n", "-o", "OPTIONS", MIRROR_MOUNT]));
  assert.match(options.stdout.trim(), /(^|,)ro(,|$)/, raw(`${MIRROR_MOUNT} is not mounted read-only`, options));

  const saved = process.env.FORGE_INCUS_PROJECT;
  process.env.FORGE_INCUS_PROJECT = RESTRICTED;
  try {
    const cloned = await cloneWorkspace(createContext(), name);
    assert.equal(cloned.code, 0, raw("cloneWorkspace", { status: cloned.code, stdout: cloned.stdout, stderr: cloned.stderr }));
  } finally {
    if (saved === undefined) delete process.env.FORGE_INCUS_PROJECT;
    else process.env.FORGE_INCUS_PROJECT = saved;
  }
  const inside = must("HEAD of the clone", asAgent(RESTRICTED, name, "git -C /workspace rev-parse HEAD"));
  assert.equal(inside.stdout.trim(), head, raw("the clone is not the mirror's commit", inside));
  assert.equal(statSync(join(ws, ".git")).uid, process.getuid!(), "the clone does not belong to the host user");
});

test("hostile workspace: refresh and retrieval run nothing the agent planted", { skip: !ENABLED }, async (t) => {
  if (!haveImage) return t.skip("no agent-base");
  const id = Math.random().toString(36).slice(2, 8);
  const c = `${PREFIX}${id}-g`;
  launch(PROJECT, c);
  process.env.FORGE_INCUS_PROJECT = PROJECT;
  process.env.FORGE_MIRRORS = join(workspaces, "mirrors");
  const ctx = createContext();
  const marker = join(workspaces, "HOST-MARKER");
  const canary = join(workspaces, "CANARY");
  writeFileSync(canary, "canary-content\n");

  // A stand-in "GitHub" with one commit, cloned bare as the mirror, whose
  // origin then points at a GitHub URL the test VM has no key for.
  const standIn = join(workspaces, "standin");
  mkdirSync(standIn);
  hostGit(["init", "-q", "-b", "main", "."], standIn);
  hostGit(["commit", "-q", "--allow-empty", "-m", "seed"], standIn);
  const mirror = mirrorPath(c);
  mkdirSync(join(workspaces, "mirrors"), { recursive: true });
  hostGit(["clone", "-q", "--bare", standIn, mirror]);
  hostGit(["--git-dir", mirror, "remote", "set-url", "origin", "git@github.com:forge-selftest/throwaway.git"]);

  const ws = join(workspaces, "hostile");
  mkdirSync(ws);
  must("add origin", incus(PROJECT, ["config", "device", "add", c, ORIGIN_DEVICE, "disk",
    `source=${mirror}`, `path=${MIRROR_MOUNT}`, "readonly=true"]));
  must("add workspace", incus(PROJECT, ["config", "device", "add", c, "workspace", "disk", `source=${ws}`, "path=/workspace"]));
  const cloned = await cloneWorkspace(ctx, c);
  assert.equal(cloned.code, 0, raw("cloneWorkspace", { status: cloned.code, stdout: cloned.stdout, stderr: cloned.stderr }));

  // The agent's side: a branch with a commit to retrieve, then the traps.
  must("agent commit", asAgent(PROJECT, c,
    "cd /workspace && git checkout -q -b agent/t && " +
    "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q --allow-empty -m agent-work"));
  for (const [key, value] of hostileConfig(marker)) {
    must(`plant ${key}`, asAgent(PROJECT, c, `git -C /workspace config ${sq(key)} ${sq(value)}`));
  }
  for (const hook of HOSTILE_HOOKS) {
    const file = `/workspace/.git/hooks/${hook}`;
    must(`plant hook ${hook}`, asAgent(PROJECT, c,
      `printf %s ${sq(hookScript(marker))} > ${sq(file)} && chmod 755 ${sq(file)}`));
  }
  must("plant FETCH_HEAD", asAgent(PROJECT, c, `ln -sf ${sq(canary)} /workspace/.git/FETCH_HEAD`));

  // Positive control: the traps are in place, so a run of them would be possible.
  const planted = must("read back a planted key", asAgent(PROJECT, c, "git -C /workspace config core.fsmonitor"));
  assert.ok(planted.stdout.includes(marker), raw("the planted command is not in the config", planted));

  // The host's refresh fails (no GitHub key here); only its effects count.
  const refreshed = await refreshMirror(ctx, mirror, SENTINEL);
  assert.notEqual(refreshed.code, 0, "the refresh was expected to fail without a GitHub key");
  asAgent(PROJECT, c, "git -C /workspace fetch origin");

  // Retrieval through the real forge, from a clean client.
  const client = mkdtempSync(join(workspaces, "client-"));
  const emptyRemote = mkdtempSync(join(workspaces, "remote-"));
  hostGit(["init", "-q", "."], client);
  hostGit(["remote", "add", c, emptyRemote], client);
  hostGit(["config", `remote.${c}.uploadpack`, `${FORGE} upload-pack ${c}`], client);
  const fetched = run("git", ["-C", client, "fetch", c], { env: { FORGE_INCUS_PROJECT: PROJECT } });
  must("client fetch", fetched);
  const branch = hostGit(["branch", "-r", "--list", `${c}/agent/t`], client).stdout;
  assert.match(branch, new RegExp(`${c}/agent/t`), raw("the agent's branch did not arrive", fetched));

  assert.equal(existsSync(marker), false, "a planted command ran on the host");
  assert.equal(readFileSync(canary, "utf8"), "canary-content\n", "CANARY changed");
});
