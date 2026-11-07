import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { hostDir } from "../cli/lib/laptop/state.ts";
import {
  applyQuiet, askCloudSettings, checkNestedVirt, currentPublicIp, type CloudSettings, type Infra,
} from "../cli/lib/laptop/cloud.ts";

const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), "forge-cloud-"));
  process.env.FORGE_HOME = tmp;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const SETTINGS: CloudSettings = {
  awsProfile: "forge-dev", region: "eu-west-3", instanceType: "m7i.2xlarge", diskGb: 200, budgetUsd: 60,
  alertEmail: "ops@example.com", upstream: "example/agent-forge", fork: "bot-example/agent-forge",
  botName: "Example Bot", botEmail: "1+bot-example@users.noreply.github.com", sshCidr: "198.51.100.7/32",
};
const INFRA: Infra = {
  name: "forge-dev", checkout: "/srv/example/agent-forge", settings: SETTINGS, adminKey: "ssh-ed25519 AAAAexample admin",
};

function planJson(changes: [string, string[]][]): string {
  return JSON.stringify({ resource_changes: changes.map(([address, actions]) => ({ address, change: { actions } })) });
}

test("askCloudSettings validates every answer", async () => {
  const ctx = fakeContext({ answers: ["forge-dev", "eu-west-3", "", "", "60", "ops@example.com",
    "example/agent-forge", "bot-example/agent-forge", "Example Bot", "1+bot-example@users.noreply.github.com"] });
  const s = await askCloudSettings(ctx);
  assert.equal(s.instanceType, "m7i.2xlarge");
  assert.equal(s.diskGb, 200);
  const bad = fakeContext({ answers: ["forge-dev", "eu-west-3", "", "", "60", "ops@example.com", "https://github.com/example/agent-forge"] });
  await assert.rejects(askCloudSettings(bad), /owner\/repo/);
});

test("currentPublicIp refuses anything but one IPv4 address", async () => {
  const ok = fakeContext({ rules: [{ match: "checkip.amazonaws.com", stdout: "198.51.100.7\n" }] });
  assert.equal(await currentPublicIp(ok), "198.51.100.7");
  const portal = fakeContext({ rules: [{ match: "checkip.amazonaws.com", stdout: "<html>login</html>" }] });
  await assert.rejects(currentPublicIp(portal), /public address/);
});

test("checkNestedVirt stops when the region lacks it", async () => {
  const ctx = fakeContext({ rules: [{ match: "describe-instance-types", stdout: '["amd-sev-snp"]' }] });
  await assert.rejects(checkNestedVirt(ctx, SETTINGS), /nested virtualization/);
});

test("applyQuiet applies an in-place plan", async () => {
  const ctx = fakeContext({ rules: [{ match: " show -json ", stdout: planJson([["aws_ec2_instance_state.dev", ["update"]]]) }] });
  await applyQuiet(ctx, INFRA, true);
  assert.ok(ctx.calls.some((c) => c.includes("apply") && c.some((a) => a.endsWith(".tfplan"))));
});

test("applyQuiet refuses a plan that replaces or creates anything", async () => {
  const ctx = fakeContext({ rules: [{ match: " show -json ", stdout: planJson([["aws_instance.dev", ["delete", "create"]]]) }] });
  await assert.rejects(applyQuiet(ctx, INFRA, false), /aws_instance\.dev.*forge cloud create --host forge-dev/s);
  assert.ok(!ctx.calls.some((c) => c.includes("apply")));
});

test("tofu runs in the checkout's infra/aws with the host's data directory and state", async () => {
  const ctx = fakeContext({ rules: [{ match: " show -json ", stdout: planJson([]) }] });
  await applyQuiet(ctx, INFRA, true);
  const init = ctx.calls.find((c) => c.includes("init"))!;
  assert.ok(init.includes(`-chdir=${INFRA.checkout}/infra/aws`));
  assert.ok(init.some((a) => a === `-backend-config=path=${join(hostDir("forge-dev"), "terraform.tfstate")}`));
  assert.equal(ctx.execOptions[ctx.calls.indexOf(init)]?.env?.TF_DATA_DIR, join(hostDir("forge-dev"), "tofu"));
});
