// Layer 3 for strict egress mode: the real `incus`, the real `forge`, a real
// forge-proxy (squid) and a strict container, opt-in, on the throwaway test
// Incus (see incus.test.ts for the setup). Run inside it:
//
//   FORGE_INTEGRATION=1 npm run test:integration
//   FORGE_INTEGRATION=1 FORGE_INTEGRATION_DOCKER=1 npm run test:integration   # adds a real Docker Hub pull
//
// One test project, forge-selftest-egress, with its own proxy slot (3) and a
// throwaway XDG_CONFIG_HOME whose allowlist holds example.com only, so a real
// agent-forge setup on the same host (its ACLs, its allowlist) is untouched;
// the user's config.json is copied in, so the shared bridge keeps its address.
//
// The strict container is not created with `forge start --strict` (that would
// clone from GitHub on the host): the arguments forge itself would pass to
// `incus launch` are printed by a one-liner, the container is launched with
// them, then the in-container settings are applied by forge's own
// egressAfterStart. Its name is the sanitized name of the sentinel repo, so
// `forge egress forge-selftest/throwaway` finds it.
//
// Every probe runs as aiuser, both ways an agent can be reached: through
// `incus exec --user 1001` (the instance environment) and through
// `su - aiuser -c` (a login shell: /etc/profile.d). Every network probe has a
// timeout, so a hang never blocks the suite, and each denial follows a
// positive control, so a broken probe cannot pass one.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import {
  ENABLED, PREFIX, REPO_ROOT, SENTINEL, SENTINEL_PEER, asAgent, copyImage, forge as forgeIn, incus, incusBelowGate, launch, must, raw, run,
  teardownProject, throwawayXdg, waitReady, type Run,
} from "./lib.ts";

const PROJECT = "forge-selftest-egress";
const SLOT = "3";
// sanitizeContainerName("forge-selftest/throwaway") and ("forge-selftest/peer").
const S1 = "agent-forge-selftest-throwaway";
const PEER = "agent-forge-selftest-peer";
const DOCKER_DIR = "/etc/systemd/user/docker.service.d";
const PROFILE_FILE = "/etc/profile.d/agent-forge-proxy.sh";
const DOCKER_DROP_IN = `${DOCKER_DIR}/agent-forge-proxy.conf`;

let xdg = "";
let haveImage = false;
let ready = false; // s1 is launched and strict
let peerReady = false;
let proxyIp = "";
let bridgeIp = "";
let ipOfExample = "";
// example.com's IPv4, resolved once on the host.
function exampleIp(): string {
  if (!ipOfExample) {
    const resolved = must("resolve example.com on the host", run("getent", ["ahostsv4", "example.com"]));
    ipOfExample = resolved.stdout.trim().split(/\s+/)[0];
    assert.match(ipOfExample, /^\d+\.\d+\.\d+\.\d+$/, raw("getent", resolved));
  }
  return ipOfExample;
}

// XDG_CONFIG_HOME is overridden for forge's allowlist and config: the incus
// client keeps its own configuration through INCUS_CONF.
// FORGE_TEST_ALLOW_INCUS_BELOW_GATE is added only when the host's Incus fails
// the strict-mode version gate (decided once, in before()).
let gateLifted = false;
const env = () => ({
  FORGE_PROXY_SLOT: SLOT, XDG_CONFIG_HOME: xdg,
  ...(gateLifted ? { FORGE_TEST_ALLOW_INCUS_BELOW_GATE: "1" } : {}),
  INCUS_CONF: process.env.INCUS_CONF ?? join(homedir(), ".config", "incus"),
});
const forge = (args: string[]) => forgeIn(PROJECT, args, env());
const allowlistFile = () => join(xdg, "agent-forge", "egress-allowlist");

// A node one-liner against forge's own modules, with the test's environment.
function nodeEval(code: string, extra: NodeJS.ProcessEnv = {}): Run {
  return run("node", ["--input-type=module", "-e", code], { env: { ...env(), FORGE_INCUS_PROJECT: PROJECT, ...extra } });
}
const lib = (name: string) => `'${REPO_ROOT}/cli/lib/${name}'`;

// Runs one command as aiuser both ways; `check` sees each result.
function eachWay(name: string, cmd: string, check: (r: Run, way: string) => void) {
  const ways: [string, Run][] = [
    ["incus exec --user 1001", incus(PROJECT, ["exec", name, "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", "bash", "-c", cmd])],
    ["su - aiuser -c", asAgent(PROJECT, name, cmd)],
  ];
  for (const [way, r] of ways) check(r, way);
}

const status = (url: string) => `curl -sS -m 20 -o /dev/null -w '%{http_code}' ${url}`;
// The status of the proxy's answer to CONNECT: 403 when the proxy refuses.
const connectStatus = (url: string) => `curl -sS -m 20 -o /dev/null -w '%{http_connect}' ${url}`;
const tcp = (host: string, port: number | string) => `timeout 5 bash -c '</dev/tcp/${host}/${port}'`;

function expectAllowed(name: string, url: string) {
  eachWay(name, status(url), (r, way) => {
    assert.equal(r.status, 0, raw(`${url} via ${way}`, r));
    assert.equal(r.stdout.trim(), "200", raw(`${url} via ${way}`, r));
  });
}
function expectRefused(name: string, url: string) {
  eachWay(name, connectStatus(url), (r, way) => {
    assert.notEqual(r.status, 0, raw(`${url} via ${way}: curl succeeded`, r));
    assert.equal(r.stdout.trim(), "403", raw(`${url} via ${way}: not the proxy's 403`, r));
  });
}

function ipv4Of(name: string): string {
  const listed = JSON.parse(must(`list ${name}`, incus(PROJECT, ["list", name, "-f", "json"])).stdout);
  const a = listed[0]?.state?.network?.eth0?.addresses?.find((x: { family: string }) => x.family === "inet");
  assert.ok(a, `${name} has no IPv4 address`);
  return a.address;
}

// After a start, the proxy is up as soon as the first request is answered.
function waitProxyServes(name: string) {
  let last: Run = { status: null, stdout: "", stderr: "" };
  for (let i = 0; i < 30; i++) {
    last = incus(PROJECT, ["exec", name, "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", "bash", "-c", status("https://example.com")]);
    if (last.status === 0 && last.stdout.trim() === "200") return;
    spawnSleep(2);
  }
  assert.fail(raw(`the proxy never served ${name}`, last));
}
const spawnSleep = (s: number) => run("sleep", [String(s)]);

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a test Incus");
  must("no usable incus client", run("incus", ["--version"]));
  teardownProject(PROJECT);
  gateLifted = incusBelowGate();
  if (gateLifted) console.log(`NOTE: this host's Incus is below the strict-mode version gate: it is lifted for ${PROJECT} in this run`);
  xdg = throwawayXdg("forge-selftest-egress-xdg-");
  writeFileSync(allowlistFile(), "example.com\n");
});

after(() => {
  if (!ENABLED) return;
  teardownProject(PROJECT);
  if (xdg) rmSync(xdg, { recursive: true, force: true });
});

test("setup creates the proxy, then reports unchanged", { skip: !ENABLED }, () => {
  const first = must("first forge setup", forge(["setup"]));
  const out = first.stdout;
  assert.match(out, new RegExp(`^network acl forge-proxy-${PROJECT}: created$`, "m"), raw("first setup", first));
  assert.match(out, new RegExp(`^network acl forge-egress-strict-${PROJECT}: created$`, "m"), raw("first setup", first));
  assert.match(out, /^profile forge-proxy: created$/m, raw("first setup", first));
  assert.match(out, /^allowlist: 1 entries$/m, raw("first setup", first));
  assert.match(out, /^instance forge-proxy: created$/m, raw("first setup", first));
  const second = must("second forge setup", forge(["setup"]));
  const lines = second.stdout.trim().split("\n");
  assert.ok(lines.length >= 7, raw("second setup", second));
  for (const line of lines) assert.match(line, /(: unchanged|^allowlist: \d+ entries)$/, raw("second setup", second));

  const proxy = JSON.parse(must("list forge-proxy", incus(PROJECT, ["list", "forge-proxy", "-f", "json"])).stdout);
  assert.equal(proxy[0]?.status, "Running", raw("forge-proxy", first));

  // Addresses for the probes below, from forge's own plan.
  const plan = JSON.parse(must("plan", nodeEval(
    `import { currentPlan } from ${lib("strict.ts")}; console.log(JSON.stringify(currentPlan()));`)).stdout);
  proxyIp = plan.proxyAddress;
  bridgeIp = plan.bridgeAddress;
  assert.match(proxyIp, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(bridgeIp, /^\d+\.\d+\.\d+\.\d+$/);
});

test("agent-base is available in the test project", { skip: !ENABLED }, () => {
  const copy = copyImage("agent-forge", PROJECT);
  // A failed copy fails the run: a run that tests nothing must not look green.
  if (copy.status !== 0) {
    assert.fail(`no agent-base in project agent-forge to copy (run 'forge image build' once): ${copy.stderr}`);
  }
  haveImage = true;
});

test("a strict container launches with forge's arguments and gets its settings", { skip: !ENABLED }, (t) => {
  if (!haveImage) return t.skip("no agent-base");
  const printed = must("strictLaunchArgs", nodeEval(
    `import { currentPlan, strictLaunchArgs } from ${lib("strict.ts")}; import { egressNames } from ${lib("objects.ts")};` +
    ` console.log(JSON.stringify(strictLaunchArgs(currentPlan(), egressNames(process.env.FORGE_INCUS_PROJECT))));`));
  const args = JSON.parse(printed.stdout) as string[];
  assert.ok(args.includes("-d") && args.includes("-c"), raw("launch arguments", printed));

  must("launch the strict container", incus(PROJECT, ["launch", "agent-base", S1, "--profile", "agent-forge",
    "-c", `user.forge.repo=${SENTINEL}`, ...args]));
  waitReady(PROJECT, S1);
  must("egressAfterStart strict", nodeEval(
    `import { createContext } from ${lib("context.ts")}; import { egressAfterStart } from ${lib("strict.ts")};` +
    ` await egressAfterStart(createContext(), process.env.C, "strict"); process.exit(0);`, { C: S1 }));
  ready = true;

  // The second container, an ordinary open one (used as a target, and to show
  // that an open container cannot reach the proxy).
  launch(PROJECT, PEER, SENTINEL_PEER);
  peerReady = true;
  assert.ok(PEER.startsWith(PREFIX));
});

test("an allowed domain answers through the proxy", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectAllowed(S1, "https://example.com");
});

test("a domain off the list gets the proxy's 403", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectAllowed(S1, "https://example.com"); // positive control
  expectRefused(S1, "https://example.org");
});

test("going around the proxy reaches nothing", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectAllowed(S1, "https://example.com"); // positive control (through the proxy)
  // --resolve bypasses DNS: a failed lookup (exit 6) must not pass for a
  // firewall block. Only a refused (7) or timed-out (28) connection does.
  const direct = `curl -sS -m 15 -o /dev/null --noproxy '*' --resolve example.com:443:${exampleIp()} https://example.com`;
  eachWay(S1, direct, (r, way) => {
    assert.ok(r.status === 7 || r.status === 28, raw(`direct https://example.com via ${way}: expected curl exit 7 or 28`, r));
  });
});

test("an IP literal is denied by the proxy", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectAllowed(S1, "https://example.com");
  expectRefused(S1, `https://${exampleIp()}`);
});

test("the proxy's other ports, the bridge and a second container are unreachable", { skip: !ENABLED }, async (t) => {
  if (!ready || !peerReady) return t.skip("no containers");
  // The target on the bridge is the test's own listener on every host address,
  // not sshd (a provisioned host may run it elsewhere than on 22). spawnSync
  // blocks the event loop, but the kernel completes the handshakes into the
  // backlog, so the probes below connect all the same.
  const server = createServer((s) => s.destroy());
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    // Host-side proof that the bridge answers without the ACL.
    must(`host → ${bridgeIp}:${port}`, run("bash", ["-c", tcp(bridgeIp, port)]));
    // The peer's listener, proven from inside the peer.
    must("listener in the peer", incus(PROJECT, ["exec", PEER, "--", "bash", "-c",
      "setsid python3 -m http.server 9000 >/dev/null 2>&1 < /dev/null &"]));
    must("the listener answers inside the peer", incus(PROJECT, ["exec", PEER, "--", "bash", "-c",
      "for i in 1 2 3 4 5; do timeout 2 bash -c '</dev/tcp/127.0.0.1/9000' && exit 0; sleep 1; done; exit 1"]));
    const peerIp = ipv4Of(PEER);

    // Positive control: the proxy's own port connects, so a broken probe cannot
    // pass the denials below.
    eachWay(S1, tcp(proxyIp, 3128), (r, way) => assert.equal(r.status, 0, raw(`${proxyIp}:3128 via ${way}`, r)));
    for (const [host, p] of [[proxyIp, 22], [proxyIp, 80], [proxyIp, 3129], [bridgeIp, port], [peerIp, 9000]] as [string, number][]) {
      eachWay(S1, tcp(host, p), (r, way) => {
        assert.notEqual(r.status, 0, raw(`${host}:${p} answered from ${S1} via ${way}`, r));
      });
    }
  } finally {
    server.close();
  }
});

test("Node, git and Chrome go through the proxy", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  const nodeFetch = (url: string) =>
    `timeout 30 node -e "fetch('${url}').then(r=>console.log(r.status),e=>{console.error(String(e.cause??e));process.exit(1)})"`;
  eachWay(S1, nodeFetch("https://example.com"), (r, way) => {
    assert.equal(r.status, 0, raw(`node fetch via ${way}`, r));
    assert.equal(r.stdout.trim(), "200", raw(`node fetch via ${way}`, r));
  });
  eachWay(S1, nodeFetch("https://example.org"), (r, way) => {
    assert.notEqual(r.status, 0, raw(`node fetch of a refused domain via ${way}`, r));
  });

  // Any HTTP answer from example.com proves the tunnel; the refused domain
  // fails on the CONNECT itself.
  const ls = (host: string) => `GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote https://${host}/nothing.git`;
  eachWay(S1, ls("example.com"), (r, way) => {
    assert.notEqual(r.status, 0, raw(`git ls-remote via ${way}`, r));
    // An HTTP answer came back through the tunnel (404 "not found", a 200 page
    // "not valid", or "returned error"), and nothing failed to connect.
    assert.doesNotMatch(r.stderr, /CONNECT tunnel failed|Could not resolve|Failed to connect|Connection timed out/,
      raw(`git ls-remote via ${way}`, r));
    assert.match(r.stderr, /not found|not valid|returned error/, raw(`git ls-remote via ${way}`, r));
  });
  eachWay(S1, ls("example.org"), (r, way) => {
    assert.match(r.stderr, /CONNECT tunnel failed/, raw(`git ls-remote of a refused host via ${way}`, r));
  });

  // Chrome, with its sandbox (no --no-sandbox).
  const chrome = (url: string) =>
    `d=$(mktemp -d) && timeout 60 google-chrome-stable --headless=new --disable-gpu --user-data-dir="$d" --dump-dom ${url}; rc=$?; rm -rf "$d"; exit $rc`;
  eachWay(S1, chrome("https://example.com"), (r, way) => {
    assert.equal(r.status, 0, raw(`Chrome via ${way}`, r));
    assert.match(r.stdout, /Example Domain/, raw(`Chrome via ${way}`, r));
  });
});

test("the Docker daemon has the proxy", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  // The drop-in and its directory (created by `incus file push --create-dirs`)
  // are root's, under /etc: forge never writes as root into a path aiuser owns.
  for (const path of [DOCKER_DIR, DOCKER_DROP_IN]) {
    const owner = must(`stat ${path}`, incus(PROJECT, ["exec", S1, "--", "stat", "-c", "%u:%g", path]));
    assert.equal(owner.stdout.trim(), "0:0", raw(`owner of ${path}`, owner));
  }
  const show = asAgent(PROJECT, S1,
    "for i in $(seq 1 30); do XDG_RUNTIME_DIR=/run/user/1001 systemctl --user show docker -p Environment && exit 0; sleep 1; done; exit 1");
  assert.equal(show.status, 0, raw("systemctl --user show docker", show));
  assert.ok(show.stdout.includes(`HTTPS_PROXY=http://${proxyIp}:3128`), raw("the daemon's environment", show));
});

// A real pull needs Docker Hub on the allowlist: a second opt-in.
test("a container run by Docker has no proxy unless given it", { skip: !ENABLED }, (t) => {
  if (process.env.FORGE_INTEGRATION_DOCKER !== "1") return t.skip("set FORGE_INTEGRATION_DOCKER=1 (needs Docker Hub; pulls an image)");
  if (!ready) return t.skip("no strict container");
  const original = allowlistFile();
  // Exactly the default list's Docker Hub group (no overlapping entries),
  // the storage host the registry redirects layers to included.
  const hubList = "example.com\nregistry-1.docker.io\nauth.docker.io\nproduction.cloudflare.docker.com\n" +
    "docker-images-prod.s3.dualstack.us-east-1.amazonaws.com\n";
  writeFileSync(original, hubList);
  try {
    must("forge setup with the Docker Hub list", forge(["setup"]));
    must("docker pull", asAgent(PROJECT, S1, "timeout 300 docker pull curlimages/curl"));
    const probe = (extra: string) =>
      asAgent(PROJECT, S1, `timeout 60 docker run --rm ${extra} curlimages/curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com`);
    const without = probe("");
    assert.notEqual(without.status, 0, raw("a Docker container without the proxy variable reached example.com", without));
    const given = probe(`-e HTTPS_PROXY=http://${proxyIp}:3128`);
    assert.equal(given.stdout.trim(), "200", raw("a Docker container given the proxy", given));
  } finally {
    writeFileSync(original, "example.com\n");
    forge(["setup"]);
  }
});

test("forge egress log shows the 403, attributed to the container", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectRefused(S1, "https://example.org");
  let out = "";
  for (let i = 0; i < 5 && !/denied/.test(out); i++) {
    out = must("forge egress log", forge(["egress", "log", SENTINEL])).stdout;
    if (!/denied/.test(out)) spawnSleep(1);
  }
  assert.match(out, /^TIME\s+CONTAINER\s+RESULT\s+METHOD\s+HOST$/m, out);
  assert.match(out, new RegExp(`${S1}\\s+denied\\s+CONNECT\\s+example\\.org:443`), out);
});

test("a forced DHCP renewal keeps the address", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  const held = ipv4Of(S1);
  must("renew the lease", incus(PROJECT, ["exec", S1, "--", "bash", "-c",
    "timeout 30 networkctl renew eth0 || timeout 30 dhclient -1 eth0"]));
  spawnSleep(5);
  assert.equal(ipv4Of(S1), held, "the address changed after the renewal");
  // The container still reaches the proxy afterwards.
  eachWay(S1, tcp(proxyIp, 3128), (r, way) => assert.equal(r.status, 0, raw(`${proxyIp}:3128 via ${way} after the renewal`, r)));
  expectAllowed(S1, "https://example.com");
});

test("with the proxy stopped, nothing answers (fails closed)", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  expectAllowed(S1, "https://example.com"); // positive control
  must("stop forge-proxy", incus(PROJECT, ["stop", "forge-proxy"]));
  try {
    eachWay(S1, "curl -sS -m 10 -o /dev/null https://example.com", (r, way) => {
      assert.notEqual(r.status, 0, raw(`https://example.com via ${way} answered with the proxy stopped`, r));
    });
  } finally {
    must("start forge-proxy", incus(PROJECT, ["start", "forge-proxy"]));
  }
  waitProxyServes(S1);
});

test("forge egress open, then strict, on a stopped container round-trips", { skip: !ENABLED }, (t) => {
  if (!ready) return t.skip("no strict container");
  const listRow = () => must("forge list", forge(["list"])).stdout.split("\n")
    .find((l) => l.startsWith(SENTINEL + " ") || l.startsWith(SENTINEL + "\t")) ?? "";
  const files = (present: boolean) => {
    for (const path of [PROFILE_FILE, DOCKER_DROP_IN]) {
      const r = incus(PROJECT, ["exec", S1, "--", "test", "-e", path]);
      assert.equal(r.status === 0, present, raw(`${path} should be ${present ? "present" : "absent"}`, r));
    }
  };
  const afterStart = (mode: string) => must(`egressAfterStart ${mode}`, nodeEval(
    `import { createContext } from ${lib("context.ts")}; import { egressAfterStart } from ${lib("strict.ts")};` +
    ` await egressAfterStart(createContext(), process.env.C, process.env.M); process.exit(0);`, { C: S1, M: mode }));

  assert.match(listRow(), /\bstrict\b/, `forge list: ${listRow()}`);
  must("stop", incus(PROJECT, ["stop", S1]));
  // Stopped, S1 has no address in `incus list`: its DHCP lease still names it
  // in the log (the earlier tests left denied lines there).
  const stoppedLog = must("forge egress log, S1 stopped", forge(["egress", "log", SENTINEL])).stdout;
  assert.match(stoppedLog, new RegExp(`${S1}\\s+denied\\s+CONNECT\\s+example\\.org:443`), stoppedLog);
  assert.match(must("egress", forge(["egress", SENTINEL])).stdout, new RegExp(`^${SENTINEL}: strict$`, "m"));

  // strict → open
  assert.match(must("egress open", forge(["egress", SENTINEL, "open"])).stdout, /now open/);
  assert.match(must("egress", forge(["egress", SENTINEL])).stdout, new RegExp(`^${SENTINEL}: open$`, "m"));
  assert.match(must("egress open again", forge(["egress", SENTINEL, "open"])).stdout, /already open/);
  assert.match(listRow(), /\bopen\b.*\bStopped\b/, `forge list: ${listRow()}`);
  must("start", incus(PROJECT, ["start", S1]));
  waitReady(PROJECT, S1);
  afterStart("open");
  files(false);
  // Open again: the internet answers without the proxy, any domain.
  eachWay(S1, status("https://example.org"), (r, way) => {
    assert.equal(r.stdout.trim(), "200", raw(`open container, https://example.org via ${way}`, r));
  });

  // open → strict
  must("stop", incus(PROJECT, ["stop", S1]));
  assert.match(must("egress strict", forge(["egress", SENTINEL, "strict"])).stdout, /now strict/);
  assert.match(listRow(), /\bstrict\b.*\bStopped\b/, `forge list: ${listRow()}`);
  must("start", incus(PROJECT, ["start", S1]));
  waitReady(PROJECT, S1);
  afterStart("strict");
  files(true);
  waitProxyServes(S1);
  expectAllowed(S1, "https://example.com");
  expectRefused(S1, "https://example.org");
});

test("an open container cannot reach the proxy (by design)", { skip: !ENABLED }, (t) => {
  // The proxy sits in a range the open ACL rejects. Expected: recorded here so
  // nobody "fixes" it.
  if (!peerReady) return t.skip("no open container");
  must("positive control: the peer reaches example.com:443",
    incus(PROJECT, ["exec", PEER, "--", "bash", "-c", tcp("example.com", 443)]));
  const r = incus(PROJECT, ["exec", PEER, "--", "bash", "-c", tcp(proxyIp, 3128)]);
  assert.notEqual(r.status, 0, raw(`${proxyIp}:3128 answered from the open peer`, r));
});
