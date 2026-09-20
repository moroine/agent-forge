import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdList } from "../scripts/lib/commands/list.ts";

function nameFor(repo: string, task?: string): string {
  const slug = repo.replace(/\//g, "-");
  return task ? `agent-${slug}-${task}` : `agent-${slug}`;
}

type FleetOpts = {
  repo?: string;
  mode?: string;
  template?: string;                 // statut du container template
  stamp?: string;                    // user.forge.image_commit du template
  latest?: string;                   // commit courant de l'image de base du mode
  tasks?: Record<string, string>;    // nom de tâche -> statut de son container
  sessions?: string;                 // sortie de `tmux list-sessions` pour la tâche sondée
};

// Construit une flotte à un seul repo (un template + zéro ou plusieurs
// containers de tâche), sur le même modèle que fleetCtx dans
// tests/containers.test.ts.
function fleetCtx(opts: FleetOpts = {}) {
  const repo = opts.repo ?? "o/r";
  const mode = opts.mode ?? "autonomous";
  const templateStatus = opts.template ?? "Running";
  const stamp = opts.stamp ?? "aaa";
  const latest = opts.latest ?? "aaa";
  const tasks = opts.tasks ?? {};

  const templateName = nameFor(repo);
  const instances: { name: string; status: string }[] = [{ name: templateName, status: templateStatus }];
  const meta: Record<string, Record<string, string>> = {
    [templateName]: { repo, mode, role: "template", task: "" },
  };
  for (const [task, status] of Object.entries(tasks)) {
    const name = nameFor(repo, task);
    instances.push({ name, status });
    meta[name] = { repo, mode, role: "task", task };
  }

  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify(instances) },
      // agent-base-super avant agent-base : "agent-base" est une sous-chaîne
      // de "agent-base-super", donc la règle la plus spécifique doit gagner.
      { match: "get-property agent-base-super", stdout: mode === "super" ? latest : "zzz" },
      { match: "get-property agent-base", stdout: mode === "super" ? "zzz" : latest },
      { match: `${templateName} user.forge.image_commit`, stdout: stamp },
      { match: "list-sessions", stdout: opts.sessions ?? "" },
      ...Object.entries(meta).flatMap(([name, m]) => [
        { match: `${name} user.forge.repo`, stdout: m.repo },
        { match: `${name} user.forge.mode`, stdout: m.mode },
        { match: `${name} user.forge.role`, stdout: m.role },
        { match: `${name} user.forge.task`, stdout: m.task },
      ]),
    ],
  });
}

// Un container d'avant ce modèle : porte user.forge.repo mais pas
// user.forge.role (les règles absentes tombent sur "" via fakeContext).
function legacyCtx() {
  const name = "agent-legacy-thing";
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify([{ name, status: "Stopped" }]) },
      { match: `${name} user.forge.repo`, stdout: "legacy/thing" },
      { match: `${name} user.forge.mode`, stdout: "autonomous" },
    ],
  });
}

// Le même repo écrit avec deux casses sur deux containers (une clé de config
// posée à la main lors d'une migration suffit). `forge list` était le seul
// site à comparer la casse : la tâche tombait dans un second groupe, orpheline
// de son template. Tous les autres sites passent par sameRepo.
function mixedCaseCtx() {
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify([
        { name: "agent-o-r", status: "Stopped" },
        { name: "agent-o-r-cli", status: "Stopped" },
      ]) },
      { match: "agent-o-r-cli user.forge.repo", stdout: "O/R" },
      { match: "agent-o-r-cli user.forge.mode", stdout: "autonomous" },
      { match: "agent-o-r-cli user.forge.role", stdout: "task" },
      { match: "agent-o-r-cli user.forge.task", stdout: "cli" },
      { match: "agent-o-r user.forge.repo", stdout: "o/r" },
      { match: "agent-o-r user.forge.mode", stdout: "autonomous" },
      { match: "agent-o-r user.forge.role", stdout: "template" },
      { match: "agent-o-r user.forge.task", stdout: "" },
    ],
  });
}

test("a repo spelled with two casings is still one group", async () => {
  const ctx = mixedCaseCtx();
  await cmdList(ctx);
  const repoRows = ctx.out_lines.filter((l) => /^[oO]\/[rR]\s/.test(l));
  assert.equal(repoRows.length, 1, ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.some((l) => l.startsWith("  cli")), ctx.out_lines.join("\n"));
});

test("list groups tasks under their repo and shows the template's build state", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" }, template: "Stopped", stamp: "aaa", latest: "aaa" });
  await cmdList(ctx);
  const out = ctx.out_lines.join("\n");
  assert.match(out, /REPO\s+MODE\s+TEMPLATE/);
  assert.match(out, /o\/r\s+autonomous\s+ok/);
  assert.match(out, /^\s+cli\s+Running/m);
  assert.match(out, /^\s+api\s+Stopped/m);
});

test("list flags a template behind the base image", async () => {
  const ctx = fleetCtx({ tasks: {}, template: "Stopped", stamp: "old", latest: "new" });
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /behind/);
});

test("list reports the tmux session state of a running task", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running" }, sessions: "cli 1\n" });
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /cli\s+Running\s+attached/);
});

test("list does not probe sessions in a stopped task container", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Stopped" } });
  await cmdList(ctx);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("list-sessions")));
});

test("list flags a legacy container with no role", async () => {
  const ctx = legacyCtx();
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /old model|recreate/);
});

test("list still issues exactly one lxc list", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" } });
  await cmdList(ctx);
  assert.equal(ctx.calls.filter((c) => c[1] === "list").length, 1);
});
