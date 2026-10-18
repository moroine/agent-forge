import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../cli/lib/context.ts";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { proxyPlan } from "../cli/lib/ipv4.ts";
import { egressNames } from "../cli/lib/objects.ts";
import {
  ENV_KEYS, PROXY_FILES, aptConf, applyStrictSettings, clearStrictSettings, dockerDropIn, egressAfterStart,
  egressBeforeStart, egressMode, profileScript, proxyEnv, requireStrictRuntime, strictLaunchArgs,
} from "../cli/lib/strict.ts";

// The default config (10.77.0.1/24) applies: no config file in the temp dir.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-strict-"));
const plan = proxyPlan("10.77.0.1/24", 0);
const PROJECT = "agent-forge";
const key = (path: string) => `${PROJECT}/web${path}`;

const OPEN_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress",
  "security.acls.default.egress.action": "allow", "security.acls.default.ingress.action": "reject",
};
const STRICT_NIC = {
  ...OPEN_NIC, "security.acls": "forge-egress-strict", "security.acls.default.egress.action": "reject",
};

// `nic` is the effective eth0 of web (by default the one its marker says);
// "manual" is a hand-made one, neither open nor strict.
function setup(opts: {
  proxy?: "none" | "running" | "stopped"; acl?: boolean; mode?: string; nic?: "open" | "strict" | "manual";
  repo?: string;
} = {}) {
  const fake = FakeIncus.withRuntime();
  fake.addProfile(PROJECT, "agent-forge", { devices: { eth0: OPEN_NIC } });
  const proxy = opts.proxy ?? "running";
  if (proxy !== "none") {
    fake.addInstance(PROJECT, "forge-proxy", {
      status: proxy === "running" ? "Running" : "Stopped", config: { "user.forge.proxy_recipe": "1" },
    });
  }
  if (opts.acl ?? true) {
    fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  }
  const nic = opts.nic ?? (opts.mode === "strict" ? "strict" : "open");
  fake.addInstance(PROJECT, "web", {
    profiles: ["agent-forge"],
    config: { ...(opts.mode ? { "user.forge.egress": opts.mode } : {}), ...(opts.repo ? { "user.forge.repo": opts.repo } : {}) },
    devices: nic === "strict" ? { eth0: { ...STRICT_NIC } } : nic === "manual" ? { eth0: { ...OPEN_NIC, "security.acls": "mine" } } : {},
  });
  return { fake, ctx: fakeContext({ incus: fake }) };
}
const cmds = (ctx: { calls: string[][] }) => ctx.calls.map((c) => c.join(" "));
const writes = (ctx: { calls: string[][] }) =>
  cmds(ctx).filter((c) => / (file push|config set|exec) /.test(c) && !c.includes("test -e"));

test("the proxy environment, both letter cases, Node's switch and the loopback exceptions", () => {
  assert.deepEqual(proxyEnv(plan), {
    HTTP_PROXY: "http://10.77.0.2:3128", HTTPS_PROXY: "http://10.77.0.2:3128", http_proxy: "http://10.77.0.2:3128",
    https_proxy: "http://10.77.0.2:3128", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
  });
  assert.deepEqual(ENV_KEYS, Object.keys(proxyEnv(plan)).map((k) => `environment.${k}`));
});

test("the launch arguments override eth0 three times, then set the environment and the marker", () => {
  const a = strictLaunchArgs(plan, egressNames("agent-forge"));
  assert.deepEqual(a.slice(0, 6), ["-d", "eth0,security.acls=forge-egress-strict", "-d", "eth0,security.acls.default.egress.action=reject",
    "-d", "eth0,security.acls.default.ingress.action=reject"]);
  assert.deepEqual(a.slice(-2), ["-c", "user.forge.egress=strict"]);
  assert.ok(a.includes("environment.HTTPS_PROXY=http://10.77.0.2:3128"));
  assert.equal(a.filter((x) => x === "-c").length, 8);
});

test("the file contents", () => {
  assert.match(profileScript(proxyEnv(plan)), /^export HTTPS_PROXY='http:\/\/10\.77\.0\.2:3128'$/m);
  assert.equal(aptConf(plan), 'Acquire::http::Proxy "http://10.77.0.2:3128";\nAcquire::https::Proxy "http://10.77.0.2:3128";\n');
  const dropIn = dockerDropIn(proxyEnv(plan));
  assert.ok(dropIn.startsWith("[Service]\nEnvironment=\"HTTP_PROXY=http://10.77.0.2:3128\"\n"));
  assert.match(dropIn, /^Environment="HTTPS_PROXY=http:\/\/10\.77\.0\.2:3128"$/m);
  for (const text of [profileScript(proxyEnv(plan)), aptConf(plan), dockerDropIn(proxyEnv(plan))]) {
    assert.ok(!text.includes(".docker/config.json"));
  }
});

test("applyStrictSettings writes the keys and the three files, then restarts the Docker user daemon", async () => {
  const { fake, ctx } = setup();
  await applyStrictSettings(ctx, "web", plan);
  const inst = fake.instances.get(PROJECT)!.get("web")!;
  for (const [k, v] of Object.entries(proxyEnv(plan))) assert.equal(inst.config[`environment.${k}`], v);
  assert.equal(cmds(ctx).filter((c) => c.includes("config set web")).length, 1);
  const env = proxyEnv(plan);
  assert.deepEqual(fake.files.get(key(PROXY_FILES.profile)), { content: profileScript(env), uid: "0", gid: "0", mode: "644" });
  assert.deepEqual(fake.files.get(key(PROXY_FILES.apt)), { content: aptConf(plan), uid: "0", gid: "0", mode: "644" });
  assert.deepEqual(fake.files.get(key(PROXY_FILES.docker)), { content: dockerDropIn(env), uid: "0", gid: "0", mode: "644" });
  assert.ok(cmds(ctx).some((c) => c.includes("systemctl --user daemon-reload && systemctl --user restart docker")));
});

test("the Docker drop-in is a system-wide user drop-in under /etc, not in aiuser's home", () => {
  assert.equal(PROXY_FILES.docker, "/etc/systemd/user/docker.service.d/agent-forge-proxy.conf");
});

test("after provisioning, forge never writes or reads as root through a path under /home/aiuser", async () => {
  const { ctx } = setup();
  // Twice: the first run writes, the second only reads back.
  await applyStrictSettings(ctx, "web", plan);
  await applyStrictSettings(ctx, "web", proxyPlan("10.77.0.1/24", 1));
  await clearStrictSettings(ctx, "web");
  const pushes = ctx.calls.filter((c) => c.includes("file") && c.includes("push"));
  assert.equal(pushes.length, 6);
  for (const argv of pushes) {
    const dest = argv[argv.indexOf("push") + 2];
    assert.ok(dest.startsWith("web/etc/"), dest);
    assert.equal(argv[argv.indexOf("--uid") + 1], "0");
    assert.equal(argv[argv.indexOf("--gid") + 1], "0");
  }
  for (const c of cmds(ctx)) assert.ok(!c.includes("/home/aiuser"), c);
});

test("a failing Docker restart is a warning, not an error", async () => {
  const { fake } = setup();
  const ctx = fakeContext({ incus: fake, rules: [{ match: "restart docker", code: 1, stderr: "no unit" }] });
  await applyStrictSettings(ctx, "web", plan);
  assert.ok(ctx.err_lines.some((l) => /^WARNING: .*Docker/.test(l)));
});

test("a second applyStrictSettings writes nothing and does not restart Docker", async () => {
  const { ctx } = setup();
  await applyStrictSettings(ctx, "web", plan);
  const before = ctx.calls.length;
  await applyStrictSettings(ctx, "web", plan);
  assert.deepEqual(writes({ calls: ctx.calls.slice(before) }), []);
});

test("a new proxy address rewrites every file and key", async () => {
  const { fake, ctx } = setup();
  await applyStrictSettings(ctx, "web", plan);
  const other = proxyPlan("10.77.0.1/24", 1);
  const before = ctx.calls.length;
  await applyStrictSettings(ctx, "web", other);
  const after = { calls: ctx.calls.slice(before) };
  assert.equal(cmds(after).filter((c) => c.includes("file push")).length, 3);
  assert.equal(cmds(after).filter((c) => c.includes("config set web")).length, 1);
  assert.equal(fake.instances.get(PROJECT)!.get("web")!.config["environment.HTTPS_PROXY"], `http://${other.proxyAddress}:3128`);
  assert.equal(fake.files.get(key(PROXY_FILES.apt))!.content, aptConf(other));
  assert.ok(cmds(after).some((c) => c.includes("restart docker")));
});

test("clearStrictSettings removes only forge's files and restarts Docker only when its drop-in was there", async () => {
  const { fake } = setup();
  const present = fakeContext({ incus: fake });
  await clearStrictSettings(present, "web");
  const rm = cmds(present).find((c) => c.includes(" rm -f "))!;
  assert.ok(rm.endsWith(`-- rm -f ${PROXY_FILES.profile} ${PROXY_FILES.apt} ${PROXY_FILES.docker}`));
  assert.ok(cmds(present).some((c) => c.includes("restart docker")));

  const absent = fakeContext({ incus: fake, rules: [{ match: "test -e", code: 1 }] });
  await clearStrictSettings(absent, "web");
  assert.ok(!cmds(absent).some((c) => c.includes("restart docker")));
});

test("requireStrictRuntime names forge setup when the ACL or the proxy is missing", async () => {
  const ok = setup();
  assert.deepEqual(await requireStrictRuntime(ok.ctx), plan);
  await assert.rejects(() => requireStrictRuntime(setup({ acl: false }).ctx), /forge-egress-strict.*forge setup/);
  await assert.rejects(() => requireStrictRuntime(setup({ proxy: "none" }).ctx), /forge-proxy.*forge setup/);
  const unfinished = setup();
  delete unfinished.fake.instances.get(PROJECT)!.get("forge-proxy")!.config["user.forge.proxy_recipe"];
  await assert.rejects(() => requireStrictRuntime(unfinished.ctx), /forge setup/);
  const old = setup();
  old.fake.serverVersion = "7.0.1";
  await assert.rejects(() => requireStrictRuntime(old.ctx), /7\.0\.2/);
});

test("egressMode reads the marker and nothing else", async () => {
  assert.equal(await egressMode(setup({ mode: "strict" }).ctx, "web"), "strict");
  assert.equal(await egressMode(setup({ mode: "open" }).ctx, "web"), "open");
  assert.equal(await egressMode(setup({ mode: "bogus" }).ctx, "web"), null);
  assert.equal(await egressMode(setup().ctx, "web"), null);
});

test("before start: a strict container checks the gate and starts a stopped proxy; an unset one does nothing", async () => {
  const { fake, ctx } = setup({ mode: "strict", proxy: "stopped" });
  assert.equal(await egressBeforeStart(ctx, "web"), "strict");
  assert.equal(fake.instances.get(PROJECT)!.get("forge-proxy")!.status, "Running");
  const old = setup({ mode: "strict" });
  old.fake.serverVersion = "7.0.1";
  await assert.rejects(() => egressBeforeStart(old.ctx, "web"), /7\.0\.2/);
  const unset = setup({ proxy: "stopped" });
  assert.equal(await egressBeforeStart(unset.ctx, "web"), null);
  assert.deepEqual(writes(unset.ctx), []);
  assert.equal(unset.fake.instances.get(PROJECT)!.get("forge-proxy")!.status, "Stopped");
});

// What egressBeforeStart did to Incus besides reading: nothing, when it refuses.
const mutations = (ctx: { calls: string[][] }) =>
  cmds(ctx).filter((c) => / (start|file push|config set|config unset|config device|exec) /.test(c));

test("before start: a strict marker on a NIC that is not strict is refused, naming both states and the fix", async () => {
  for (const nic of ["open", "manual"] as const) {
    const { fake, ctx } = setup({ mode: "strict", nic, proxy: "stopped", repo: "o/r" });
    await assert.rejects(() => egressBeforeStart(ctx, "web"), (e: Error) => {
      assert.ok(e instanceof ForgeError);
      assert.match(e.message, /web/);
      assert.match(e.message, /user\.forge\.egress=strict/);
      if (nic === "open") {
        assert.match(e.message, /eth0 is open/);
        assert.match(e.message, /forge egress o\/r strict/);
        assert.match(e.message, /forge egress o\/r open/);
      } else {
        // forge egress refuses a hand-made eth0 both ways: never advise it.
        assert.match(e.message, /eth0 matches neither open nor strict \(changed by hand\?\)/);
        assert.match(e.message, /incus --project agent-forge config device show web/);
        assert.doesNotMatch(e.message, /forge egress/);
      }
      return true;
    });
    assert.deepEqual(mutations(ctx), []);
    assert.equal(fake.instances.get(PROJECT)!.get("forge-proxy")!.status, "Stopped");
  }
});

test("before start: a strict NIC under an open or absent marker is refused, naming both states and the fix", async () => {
  for (const mode of ["open", undefined]) {
    const { ctx } = setup({ mode, nic: "strict" });
    await assert.rejects(() => egressBeforeStart(ctx, "web"), (e: Error) => {
      assert.ok(e instanceof ForgeError);
      assert.match(e.message, mode ? /user\.forge\.egress=open/ : /without user\.forge\.egress/);
      assert.match(e.message, /eth0 is strict/);
      // No user.forge.repo: the container's name stands in for the repo.
      assert.match(e.message, /forge egress web strict/);
      assert.match(e.message, /forge egress web open/);
      return true;
    });
    assert.deepEqual(mutations(ctx), []);
  }
});

test("before start: a strict marker whose NIC cannot be listed is refused; an open one goes through", async () => {
  const strict = setup({ mode: "strict" });
  const failing = fakeContext({ incus: strict.fake, rules: [{ match: "list -f json", code: 1, stderr: "boom" }] });
  await assert.rejects(() => egressBeforeStart(failing, "web"), /refusing to start web: .*marked strict/);
  const open = setup({ mode: "open" });
  assert.equal(await egressBeforeStart(fakeContext({ incus: open.fake, rules: [{ match: "list -f json", code: 1 }] }), "web"), "open");
});

test("before start: matching states, and an open or absent marker on an unrecognized NIC, go through", async () => {
  assert.equal(await egressBeforeStart(setup({ mode: "strict", nic: "strict" }).ctx, "web"), "strict");
  assert.equal(await egressBeforeStart(setup({ mode: "open", nic: "open" }).ctx, "web"), "open");
  assert.equal(await egressBeforeStart(setup({ nic: "open" }).ctx, "web"), null);
  assert.equal(await egressBeforeStart(setup({ mode: "open", nic: "manual" }).ctx, "web"), "open");
  assert.equal(await egressBeforeStart(setup({ nic: "manual" }).ctx, "web"), null);
});

test("before start: a missing proxy is a warning naming forge setup, not an error", async () => {
  const { ctx } = setup({ mode: "strict", proxy: "none" });
  assert.equal(await egressBeforeStart(ctx, "web"), "strict");
  assert.ok(ctx.err_lines.some((l) => /forge setup/.test(l)));
});

test("after start: strict applies the settings, open clears them, unset does nothing, and a second strict call writes nothing", async () => {
  const { fake, ctx } = setup();
  await egressAfterStart(ctx, "web", "strict");
  assert.ok(fake.files.has(key(PROXY_FILES.apt)));
  const before = ctx.calls.length;
  await egressAfterStart(ctx, "web", "strict");
  assert.deepEqual(writes({ calls: ctx.calls.slice(before) }), []);
  const mark = ctx.calls.length;
  await egressAfterStart(ctx, "web", null);
  assert.equal(ctx.calls.length, mark);
  await egressAfterStart(ctx, "web", "open");
  assert.ok(cmds({ calls: ctx.calls.slice(mark) }).some((c) => c.includes(" rm -f ")));
});
