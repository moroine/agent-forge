// Opt-in : FORGE_INTEGRATION=1 npm run test:integration, dans un container
// super (ou sur l'hôte). Ces trois assertions sont les seules du design qui
// ne peuvent pas être tranchées par un fake — elles portent sur le
// comportement réel de LXD et du noyau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../scripts/lib/context.ts";
import { addDiskDevice, copyInstance } from "../../scripts/lib/lxd.ts";

const RUN = process.env.FORGE_INTEGRATION === "1";
const ctx = createContext();
const PREFIX = `forge-it-${process.pid}`;

async function lxc(...argv: string[]) {
  const r = await ctx.exec(["lxc", ...argv]);
  assert.equal(r.code, 0, `lxc ${argv.join(" ")} failed: ${r.stderr}`);
  return r;
}
const agent = (name: string, script: string) =>
  ctx.exec(["lxc", "exec", name, "--", "su", "-", "aiuser", "-c", script]);

test("the same host directory mounted into two containers stays consistent", { skip: !RUN }, async (t) => {
  const shared = mkdtempSync(join(tmpdir(), "forge-shared-"));
  writeFileSync(join(shared, "from-host"), "host\n");
  const a = `${PREFIX}-a`, b = `${PREFIX}-b`;
  t.after(async () => { await ctx.exec(["lxc", "delete", a, "--force"]); await ctx.exec(["lxc", "delete", b, "--force"]); });

  await lxc("launch", "agent-base", a, "--profile", "agent");
  await lxc("launch", "agent-base", b, "--profile", "agent");
  await addDiskDevice(ctx, a, "workspace", shared, "/workspace");
  await addDiskDevice(ctx, b, "workspace", shared, "/workspace");

  const write = await agent(a, "echo from-a > /workspace/from-a");
  assert.equal(write.code, 0, write.stderr);
  const read = await agent(b, "cat /workspace/from-a");
  assert.equal(read.stdout.trim(), "from-a", "b doit voir ce que a a écrit");

  // Propriété cohérente : même raw.idmap des deux côtés, donc pas de shift.
  const owner = await agent(b, "stat -c %U /workspace/from-a");
  assert.equal(owner.stdout.trim(), "aiuser");
  assert.equal(readFileSync(join(shared, "from-a"), "utf8").trim(), "from-a");
  assert.equal(statSync(join(shared, "from-a")).uid, 1000, "vu comme moroine côté hôte");
});

test("hardlinks work between .forge-cache and a worktree (the §5 assumption)", { skip: !RUN }, async (t) => {
  const shared = mkdtempSync(join(tmpdir(), "forge-hardlink-"));
  const name = `${PREFIX}-hl`;
  t.after(async () => { await ctx.exec(["lxc", "delete", name, "--force"]); });

  await lxc("launch", "agent-base", name, "--profile", "agent");
  await addDiskDevice(ctx, name, "workspace", shared, "/workspace");

  const r = await agent(name,
    "mkdir -p /workspace/.forge-cache/pnpm /workspace/.trees/t/node_modules && " +
    "echo payload > /workspace/.forge-cache/pnpm/blob && " +
    "ln /workspace/.forge-cache/pnpm/blob /workspace/.trees/t/node_modules/blob && " +
    "stat -c %h /workspace/.forge-cache/pnpm/blob");
  assert.equal(r.code, 0, `le hardlink a échoué (EXDEV ?) : ${r.stderr}`);
  assert.equal(r.stdout.trim(), "2", "les deux chemins doivent partager un inode");
});

test("a super container copied from a stopped template starts its nested LXD", { skip: !RUN || !process.env.FORGE_INTEGRATION_SUPER }, async (t) => {
  const tpl = `${PREFIX}-tpl`, copy = `${PREFIX}-copy`;
  t.after(async () => { await ctx.exec(["lxc", "delete", tpl, "--force"]); await ctx.exec(["lxc", "delete", copy, "--force"]); });

  await lxc("launch", "agent-base-super", tpl, "--profile", "agent-super");
  await lxc("exec", tpl, "--", "snap", "wait", "system", "seed.loaded");
  await lxc("exec", tpl, "--", "/snap/bin/lxd", "init", "--minimal");
  await lxc("stop", tpl);                       // la copie DOIT partir d'un template arrêté

  await copyInstance(ctx, tpl, copy);
  await lxc("start", copy);
  const r = await ctx.exec(["lxc", "exec", copy, "--", "/snap/bin/lxc", "list", "-f", "json"]);
  assert.equal(r.code, 0, `le LXD imbriqué de la copie ne répond pas : ${r.stderr}`);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});
