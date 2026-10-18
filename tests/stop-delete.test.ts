import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { mirrorPath, workspacesDir } from "../cli/lib/paths.ts";
import { cmdStop } from "../cli/lib/commands/stop.ts";
import { cmdDelete } from "../cli/lib/commands/delete.ts";

// Jamais le vrai home : delete regarde si le miroir existe.
const dir = mkdtempSync(join(tmpdir(), "forge-delete-"));
const saved = { ws: process.env.FORGE_WORKSPACES, mirrors: process.env.FORGE_MIRRORS };
process.env.FORGE_WORKSPACES = join(dir, "workspaces");
process.env.FORGE_MIRRORS = join(dir, "mirrors");
after(() => {
  for (const [k, v] of [["FORGE_WORKSPACES", saved.ws], ["FORGE_MIRRORS", saved.mirrors]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
  { match: "status --porcelain", stdout: " M scripts/forge\n" },
];

test("stop runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdStop(c, "moroine/agent-forge", false), /uncommitted changes/);
  assert.ok(!c.calls.some((call) => call[1] === "stop"));
});

test("stop --force skips the pre-flight and stops the container", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await cmdStop(c, "moroine/agent-forge", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-moroine-agent-forge"));
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
});

test("stop asks for the repo when it is missing", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  await cmdStop(c, undefined, true);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-moroine-agent-forge"));
});

test("delete skips the pre-flight on an already stopped container", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
      { match: "status --porcelain", stdout: " M scripts/forge\n" },
    ],
  });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge delete agent-x --force"));
});

test("delete runs the pre-flight on a running container", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdDelete(c, "moroine/agent-forge", false), /uncommitted changes/);
});

// Fail-fast : `ctx.exec` capture stderr là où bash en héritait. Sans
// mustSucceed, un `incus stop`/`incus delete` en échec rendait 0 et n'affichait
// rien du tout — pire que le bash d'origine sous `set -e`.
test("stop fails loudly when incus stop fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge stop", code: 1, stderr: "Error: The instance is currently in use\n" },
      ...RULES,
    ],
  });
  await assert.rejects(
    () => cmdStop(c, "moroine/agent-forge", true),
    /incus stop failed: Error: The instance is currently in use/,
  );
});

test("delete fails loudly when incus delete fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge delete", code: 1, stderr: "Error: Instance is protected\n" },
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
    ],
  });
  await assert.rejects(
    () => cmdDelete(c, "o/r", false),
    /incus delete failed: Error: Instance is protected/,
  );
});

const STOPPED = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) },
];

test("delete says the workspace and the mirror are kept", async () => {
  mkdirSync(mirrorPath("agent-moroine-agent-forge"), { recursive: true });
  try {
    const c = fakeContext({ rules: STOPPED });
    await cmdDelete(c, "moroine/agent-forge", false);
    const line = c.out_lines.find((l) => l.startsWith("Kept "));
    assert.ok(line, c.out_lines.join("\n"));
    assert.ok(line.includes(join(workspacesDir(), "agent-moroine-agent-forge")), line);
    assert.ok(line.includes(mirrorPath("agent-moroine-agent-forge")), line);
    assert.ok(line.includes("forge start moroine/agent-forge"), line);
  } finally {
    rmSync(mirrorPath("agent-moroine-agent-forge"), { recursive: true, force: true });
  }
});

// Un container d'avant le miroir n'en a pas : la ligne n'en nomme aucun.
test("delete of a container without a mirror names only the workspace", async () => {
  const c = fakeContext({ rules: STOPPED });
  await cmdDelete(c, "moroine/agent-forge", false);
  assert.deepEqual(c.out_lines.filter((l) => l.startsWith("Kept ")), [
    `Kept ${join(workspacesDir(), "agent-moroine-agent-forge")}: 'forge start moroine/agent-forge' reuses it.`,
  ]);
});
