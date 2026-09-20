// tests/token.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdToken } from "../scripts/lib/commands/token.ts";
import { readToken, writeToken } from "../scripts/lib/credentials.ts";

function sandbox(): void {
  process.env.FORGE_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-token-"));
}

const FLEET = JSON.stringify([{ name: "agent-o-r", status: "Stopped" }]);
const META = [
  { match: "lxc list", stdout: FLEET },
  { match: "config get agent-o-r user.forge.repo", stdout: "o/r" },
  { match: "config get agent-o-r user.forge.mode", stdout: "autonomous" },
  { match: "config get agent-o-r user.forge.role", stdout: "template" },
  { match: "config get agent-o-r user.forge.task", stdout: "" },
];

test("token set stores what askSecret returned, and never puts it in argv", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META, answers: ["ghp_typed"] });
  assert.equal(await cmdToken(ctx, "set", "o/r"), 0);
  assert.equal(readToken("o/r"), "ghp_typed");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("ghp_typed")));
});

test("token set refuses an empty token", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META, answers: [""] });
  await assert.rejects(() => cmdToken(ctx, "set", "o/r"), /empty token/);
});

test("token set refuses a whitespace-only token", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META, answers: ["   "] });
  await assert.rejects(() => cmdToken(ctx, "set", "o/r"), /empty token/);
});

test("token rm says so when there was nothing stored", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META });
  assert.equal(await cmdToken(ctx, "rm", "o/r"), 0);
  assert.match(ctx.out_lines.join("\n"), /no stored token/);
});

test("token import reads gh auth token from the repo's container", async () => {
  sandbox();
  const ctx = fakeContext({
    rules: [...META, { match: "gh auth token", stdout: "ghp_from_container\n" }],
  });
  assert.equal(await cmdToken(ctx, "import", "o/r"), 0);
  assert.equal(readToken("o/r"), "ghp_from_container");
});

test("token import starts a stopped container and stops it again", async () => {
  sandbox();
  const ctx = fakeContext({
    rules: [...META, { match: "gh auth token", stdout: "ghp_x\n" }],
  });
  await cmdToken(ctx, "import", "o/r");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc start agent-o-r"));
  assert.ok(joined.includes("lxc stop agent-o-r"));
  assert.ok(joined.indexOf("lxc start agent-o-r") < joined.indexOf("lxc stop agent-o-r"));
});

test("token import warns but does not throw when re-stopping fails", async () => {
  sandbox();
  const ctx = fakeContext({
    rules: [...META, { match: "gh auth token", stdout: "ghp_x\n" }, { match: "lxc stop", code: 1, stderr: "device busy" }],
  });
  assert.equal(await cmdToken(ctx, "import", "o/r"), 0);
  assert.equal(readToken("o/r"), "ghp_x");
  assert.match(ctx.err_lines.join("\n"), /WARNING: could not stop agent-o-r again: device busy/);
});

test("token import fails loudly when gh has no token", async () => {
  sandbox();
  const ctx = fakeContext({ rules: [...META, { match: "gh auth token", code: 1, stderr: "not logged in" }] });
  await assert.rejects(() => cmdToken(ctx, "import", "o/r"), /not logged in|no token/);
});

test("an unknown subcommand yields the usage", async () => {
  sandbox();
  await assert.rejects(() => cmdToken(fakeContext({ rules: META }), "bogus", "o/r"), /Usage: forge token/);
});
