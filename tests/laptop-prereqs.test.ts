import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { checkPrerequisites } from "../cli/lib/laptop/prereqs.ts";

const GOOD: ExecRule[] = [
  { match: "limactl --version", stdout: "limactl version 2.1.2\n" },
  { match: "ansible-playbook --version", stdout: "ansible-playbook [core 2.20.1]\n  config file = None\n" },
  { match: "ansible-galaxy --version", stdout: "ansible-galaxy [core 2.20.1]\n" },
  { match: "herdr --version", stdout: "herdr 0.5.0\n" },
  { match: "git --version", stdout: "git version 2.50.0\n" },
  { match: "ssh -V", stderr: "OpenSSH_10.0p2, OpenSSL 3.5.0\n" },
];

// Remplace la règle de `match` (les règles sont à première correspondance).
const with_ = (match: string, over: Omit<ExecRule, "match">): ExecRule[] =>
  GOOD.map((r) => (r.match === match ? { match, ...over } : r));

async function problem(rules: ExecRule[], kind: "lima" | "remote" | "cloud", platform: string): Promise<string> {
  const ctx = fakeContext({ rules });
  try {
    await checkPrerequisites(ctx, kind, platform as NodeJS.Platform);
  } catch (e) {
    assert.ok(e instanceof ForgeError);
    return e.message;
  }
  assert.fail("expected a ForgeError");
}

test("all prerequisites present resolves", async () => {
  await checkPrerequisites(fakeContext({ rules: GOOD }), "lima", "darwin");
});

test("an old limactl names the version found and the floor", async () => {
  const msg = await problem(with_("limactl --version", { stdout: "limactl version 2.0.3\n" }), "lima", "darwin");
  assert.match(msg, /2\.0\.3/);
  assert.match(msg, /2\.1\.2/);
  assert.match(msg, /brew install lima\b/);
});

test("versions compare numerically per component", async () => {
  await checkPrerequisites(fakeContext({ rules: with_("limactl --version", { stdout: "limactl version 2.10.0\n" }) }), "lima", "darwin");
});

test("ansible core 2.19.1 is too old", async () => {
  const msg = await problem(with_("ansible-playbook --version", { stdout: "ansible-playbook [core 2.19.1]\n" }), "remote", "darwin");
  assert.match(msg, /2\.19\.1/);
  assert.match(msg, /2\.20/);
  assert.match(msg, /brew install ansible\b/);
});

test("missing herdr on darwin suggests brew install herdr", async () => {
  const msg = await problem(with_("herdr --version", { code: 127 }), "remote", "darwin");
  assert.match(msg, /brew install herdr/);
  assert.doesNotMatch(msg, /brew install .*(lima|ansible)/);
});

test("on darwin the missing tools share one brew line", async () => {
  const rules = with_("herdr --version", { code: 127 });
  const both = rules.map((r) => (r.match === "limactl --version" ? { match: r.match, code: 127 } : r));
  const msg = await problem(both, "lima", "darwin");
  assert.equal(msg.match(/brew install/g)?.length, 1);
  assert.match(msg, /brew install lima herdr/);
});

test("on linux the install lines come from the README", async () => {
  const rules = GOOD.map((r) =>
    r.match === "limactl --version" || r.match === "herdr --version" || r.match === "ansible-galaxy --version"
      ? { match: r.match, code: 127 }
      : r);
  const msg = await problem(rules, "lima", "linux");
  assert.match(msg, /github\.com\/lima-vm\/lima\/releases/);
  assert.match(msg, /2\.1\.2/);
  assert.match(msg, /pipx install ansible-core/);
  assert.match(msg, /https:\/\/herdr\.dev/);
  assert.doesNotMatch(msg, /brew/);
});

test("the remote kind never runs limactl", async () => {
  const ctx = fakeContext({ rules: GOOD });
  await checkPrerequisites(ctx, "remote", "darwin");
  assert.ok(!ctx.calls.some((c) => c[0] === "limactl"));
});

test("a missing git is reported without an install line", async () => {
  const msg = await problem(with_("git --version", { code: 127 }), "remote", "darwin");
  assert.match(msg, /git/);
});

test("two problems are both listed", async () => {
  const rules = with_("herdr --version", { code: 127 }).map((r) =>
    r.match === "ssh -V" ? { match: r.match, code: 127 } : r);
  const msg = await problem(rules, "remote", "darwin");
  assert.match(msg, /herdr/);
  assert.match(msg, /ssh/);
});

const CLOUD: ExecRule[] = [
  ...GOOD,
  { match: "tofu version", stdout: "OpenTofu v1.13.9\non darwin_arm64\n" },
  { match: "aws --version", stdout: "aws-cli/2.27.3 Python/3.13 Darwin/25 exe/arm64\n" },
];

test("the cloud kind asks for tofu and aws, never limactl", async () => {
  const ctx = fakeContext({ rules: CLOUD });
  await checkPrerequisites(ctx, "cloud", "darwin");
  assert.ok(ctx.calls.some((c) => c[0] === "tofu"));
  assert.ok(ctx.calls.some((c) => c[0] === "aws"));
  assert.ok(!ctx.calls.some((c) => c[0] === "limactl"));
});

test("cloud: a missing tofu and aws share the darwin brew line", async () => {
  const rules = CLOUD.map((r) => (r.match === "tofu version" || r.match === "aws --version" ? { match: r.match, code: 127 } : r));
  const msg = await problem(rules, "cloud", "darwin");
  assert.match(msg, /brew install opentofu awscli/);
});

test("cloud: tofu older than 1.10.0 and aws-cli v1 are refused", async () => {
  const old = CLOUD.map((r) => (r.match === "tofu version" ? { match: r.match, stdout: "OpenTofu v1.9.2\n" } : r));
  assert.match(await problem(old, "cloud", "linux"), /1\.9\.2[^]*1\.10\.0/);
  const v1 = CLOUD.map((r) => (r.match === "aws --version" ? { match: r.match, stdout: "aws-cli/1.32.0 Python/3.9\n" } : r));
  assert.match(await problem(v1, "cloud", "linux"), /AWS CLI/);
});
