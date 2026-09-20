// tests/claude-cmd.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdClaude } from "../scripts/lib/commands/claude.ts";
import { currentVersion } from "../scripts/lib/claude-dist.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-claude-cmd-"));
  process.env.FORGE_CLAUDE_DIST = dir;
  return dir;
}

test("claude list shows each version and marks the current one", async () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  const ctx = fakeContext({});
  await cmdClaude(ctx, "list", undefined);
  const out = ctx.out_lines.join("\n");
  assert.match(out, /2\.0\.9/);
  assert.match(out, /2\.0\.14/);
  assert.match(out, /none/);
});

test("claude update resolves 'latest' through npm view when no version is given", async () => {
  const dir = sandbox();
  const ctx = fakeContext({ rules: [{ match: "npm view", stdout: "2.0.14\n" }] });
  // Le `npm install` est simulé par fakeContext : il rend 0 sans rien écrire.
  // Simuler un install RÉUSSI impose donc de créer aussi ce que npm aurait
  // créé — sans quoi le garde-fou de switchCurrent (refuser une version
  // absente) se déclenche, et c'est justement lui qu'on veut garder vivant.
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  assert.equal(await cmdClaude(ctx, "update", undefined), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ") === "npm view @anthropic-ai/claude-code version"));
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("@anthropic-ai/claude-code@2.0.14")));
  assert.equal(currentVersion(), "2.0.14");
});

test("claude update installs the pinned version and switches current", async () => {
  const dir = sandbox();
  const ctx = fakeContext({});
  // Le `npm install` est simulé par fakeContext : il rend 0 sans rien écrire.
  // Simuler un install RÉUSSI impose donc de créer aussi ce que npm aurait
  // créé — sans quoi le garde-fou de switchCurrent (refuser une version
  // absente) se déclenche, et c'est justement lui qu'on veut garder vivant.
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  assert.equal(await cmdClaude(ctx, "update", "2.0.9"), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("@anthropic-ai/claude-code@2.0.9")));
  assert.equal(currentVersion(), "2.0.9");
});

test("update refuses to make a never-installed version current", async () => {
  sandbox();
  // fakeContext ne rate jamais : "npm install" rend 0 sans rien écrire sur
  // disque. C'est exactement le cas d'un npm qui mentirait, ou d'un bug qui
  // sauterait l'install — le garde-fou de switchCurrent doit rattraper ça,
  // sans quoi `current` pourrait pointer sur un répertoire vide qu'un shim
  // de container tenterait d'exécuter.
  const ctx = fakeContext({});
  await assert.rejects(() => cmdClaude(ctx, "update", "9.9.9"), /9\.9\.9/);
  assert.equal(currentVersion(), null);
});

test("claude update does not switch current when npm install fails", async () => {
  sandbox();
  const ctx = fakeContext({ rules: [{ match: "npm install", code: 1, stderr: "ETARGET\n" }] });
  await assert.rejects(() => cmdClaude(ctx, "update", "9.9.9"), /ETARGET/);
  assert.equal(currentVersion(), null);
});

test("an unknown subcommand yields the usage", async () => {
  sandbox();
  await assert.rejects(() => cmdClaude(fakeContext({}), "bogus", undefined), /Usage: forge claude/);
});
