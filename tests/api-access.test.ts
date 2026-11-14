import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { API_DEVICE, ensureApiAccess, restartApiService } from "../cli/lib/api/access.ts";
import { memberNamed } from "../cli/lib/team.ts";

beforeEach(() => {
  process.env.FORGE_API_RUNTIME = "/run/user/1000/forge-api";
  process.env.FORGE_REPO_DIR = process.cwd();
});
afterEach(() => {
  delete process.env.FORGE_API_RUNTIME;
  delete process.env.FORGE_REPO_DIR;
});

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        lead: { capabilities: ["repo", "assign"], talkTo: ["team"] },
        dev: { capabilities: ["repo", "publish"], talkTo: ["lead"] },
        solo: { capabilities: ["repo"] },
      },
    },
  },
});

function setup(name: string) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", name, { status: "Running" });
  const ctx = fakeContext({ incus: fake });
  const device = () => fake.instances.get("agent-forge")!.get(name)!.devices[API_DEVICE];
  return { fake, ctx, device };
}

test("a member that talks gets the channel: /var/lib/forge, the proxy device, forge-team", async () => {
  const { fake, ctx, device } = setup("agent-web-dev");
  await ensureApiAccess(ctx, memberNamed(cfg, "agent-web-dev"));
  const calls = ctx.calls.map((c) => c.join(" "));
  assert.ok(calls.includes("incus --project agent-forge exec agent-web-dev -- mkdir -p /var/lib/forge"), calls.join("\n"));
  assert.ok(calls.includes("incus --project agent-forge config device add agent-web-dev forge-api proxy bind=instance " +
    "listen=unix:/var/lib/forge/api.sock connect=unix:/run/user/1000/forge-api/agent-web-dev.sock uid=1001 gid=1001 mode=0600"), calls.join("\n"));
  assert.deepEqual(device(), {
    type: "proxy", bind: "instance", listen: "unix:/var/lib/forge/api.sock",
    connect: "unix:/run/user/1000/forge-api/agent-web-dev.sock", uid: "1001", gid: "1001", mode: "0600",
  });
  const pushed = fake.files.get("agent-forge/agent-web-dev/usr/local/bin/forge-team")!;
  assert.deepEqual([pushed.uid, pushed.mode], ["0", "755"]);
  assert.ok(pushed.content.startsWith("#!/usr/bin/env node"));
});

test("a second call adds no second device but refreshes forge-team", async () => {
  const { ctx } = setup("agent-web-dev");
  const dev = memberNamed(cfg, "agent-web-dev");
  await ensureApiAccess(ctx, dev);
  await ensureApiAccess(ctx, dev);
  assert.equal(ctx.calls.filter((c) => c.includes("add")).length, 1);
  assert.equal(ctx.calls.filter((c) => c.includes("push")).length, 2);
});

test("a member that no longer needs the API loses the device", async () => {
  const { ctx, device } = setup("agent-web-solo");
  const solo = memberNamed(cfg, "agent-web-solo");
  assert.equal(solo.talkTo.length, 0);
  await ensureApiAccess(ctx, solo);
  assert.ok(!ctx.calls.some((c) => c.includes("remove")), "nothing to remove");
  // Le device d'une ancienne config.
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-solo", { status: "Running", devices: { [API_DEVICE]: { type: "proxy" } } });
  const ctx2 = fakeContext({ incus: fake });
  await ensureApiAccess(ctx2, solo);
  assert.ok(ctx2.calls.some((c) => c.join(" ") === "incus --project agent-forge config device remove agent-web-solo forge-api"));
  assert.equal(device(), undefined);
});

test("restartApiService try-restarts the user service; a failure is a warning", async () => {
  const ok = fakeContext();
  await restartApiService(ok);
  assert.deepEqual(ok.calls, [["systemctl", "--user", "try-restart", "forge-api.service"]]);
  assert.deepEqual(ok.err_lines, []);
  const bad = fakeContext({ rules: [{ match: "systemctl", code: 1, stderr: "Failed to connect to bus\n" }] });
  await restartApiService(bad);
  assert.match(bad.err_lines[0], /^WARNING: could not restart forge-api\.service \(Failed to connect to bus\)/);
});
