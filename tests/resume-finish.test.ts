import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import type { ExecRule } from "./lib/fake-context.ts";
import { cmdFinish } from "../scripts/lib/commands/finish.ts";

// resume.ts référence encore containerForRepo/requireContainerForRepo,
// supprimés d'un container par repo — sa migration est une tâche ultérieure
// (voir task-9-brief.md, point 4). Un `import` statique de ce module ferait
// planter TOUT ce fichier de test au chargement (SyntaxError sur l'export
// manquant), y compris les tests de `finish` qui n'ont rien à voir avec lui.
// L'import dynamique isole le crash à l'intérieur de chaque test resume, où
// il est attendu — et donc rapporté comme un échec de CE test, pas de
// l'ensemble du fichier.
let cmdResume: (ctx: Parameters<typeof cmdFinish>[0], repo?: string, task?: string) => Promise<number>;
try {
  ({ cmdResume } = await import("../scripts/lib/commands/resume.ts"));
} catch (e) {
  cmdResume = async () => { throw e; };
}

const BASE = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("resume attaches the task's tmux session", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  assert.equal(await cmdResume(c, "moroine/agent-forge", "cli"), 0);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach, "no attach happened");
  assert.ok(attach.includes("new-session") && attach.includes("cli"));
});

test("resume never creates a worktree", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

test("resume errors when the worktree is absent, pointing at start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "nope"), /forge start/);
});

test("resume asks for repo then task when both are missing", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], answers: [1, 2] });
  await cmdResume(c, undefined, undefined);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach?.includes("docs"), `attached to the wrong session: ${attach?.join(" ")}`);
});

test("resume fails when the container refuses to start", async () => {
  const c = fakeContext({
    rules: [
      { match: "lxc start", code: 1, stderr: "Error: Failed to start device\n" },
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) },
      { match: "test -e", code: 0 },
    ],
  });
  await assert.rejects(
    () => cmdResume(c, "moroine/agent-forge", "cli"),
    /lxc start failed: Error: Failed to start device/,
  );
  assert.ok(!c.calls.some((call) => call.includes("tmux")), "attaché malgré l'échec du démarrage");
});

// --- finish -----------------------------------------------------------
//
// Le montage est partagé entre tous les containers d'un repo (un seul
// .git) : `finish` doit pouvoir retirer une worktree même quand le
// container de la tâche est éteint ou déjà supprimé, via un git host
// (scripts/lib/githost.ts) — le template en dernier recours.
type Fleet = { name: string; status: string; role: string; task: string };

function finishCtx(opts: {
  task?: string;
  status?: string | null;   // null = pas de container de tâche dans la flotte
  dirty?: boolean;
  mode?: string;
  extraRules?: ExecRule[];
}) {
  const task = opts.task ?? "feat";
  const templateName = "agent-o-r";
  const containerName = `agent-o-r-${task}`;
  const fleet: Fleet[] = [{ name: templateName, status: "Stopped", role: "template", task: "" }];
  if (opts.status !== null) {
    fleet.push({ name: containerName, status: opts.status ?? "Running", role: "task", task });
  }
  const mode = opts.mode ?? "supervised";
  return fakeContext({
    rules: [
      ...(opts.extraRules ?? []),
      { match: "lxc list", stdout: JSON.stringify(fleet.map((c) => ({ name: c.name, status: c.status }))) },
      ...fleet.flatMap((c) => [
        { match: `config get ${c.name} user.forge.repo`, stdout: "o/r" },
        { match: `config get ${c.name} user.forge.mode`, stdout: mode },
        { match: `config get ${c.name} user.forge.role`, stdout: c.role },
        { match: `config get ${c.name} user.forge.task`, stdout: c.task },
      ]),
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: opts.dirty ? " M x\n" : "" },
    ],
  });
}

test("finish removes the worktree after the pre-flight", async () => {
  const c = finishCtx({ task: "cli" });
  assert.equal(await cmdFinish(c, "o/r", "cli", false), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove .trees/cli")));
});

test("finish --force skips the pre-flight and forces the removal", async () => {
  const c = finishCtx({ task: "cli", dirty: true });
  assert.equal(await cmdFinish(c, "o/r", "cli", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove --force .trees/cli")));
});

test("finish keeps the branch and kills the session", async () => {
  const c = finishCtx({ task: "cli" });
  await cmdFinish(c, "o/r", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("branch -D")));
  assert.ok(c.calls.some((call) => call.join(" ").includes("kill-session -t cli")));
  assert.ok(c.out_lines.some((l) => l.includes("branch agent/cli retained")));
});

// Fail-fast : sans mustSucceed, `git worktree remove` pouvait échouer et
// finish annonçait quand même « Finished task cli » en rendant 0.
test("finish fails when the worktree removal fails, and claims nothing", async () => {
  const c = finishCtx({
    task: "cli",
    extraRules: [{ match: "worktree remove", code: 1, stderr: "fatal: '.trees/cli' contains modified files\n" }],
  });
  await assert.rejects(
    () => cmdFinish(c, "o/r", "cli", false),
    /git worktree remove failed: fatal: '\.trees\/cli' contains modified files/,
  );
  assert.ok(
    !c.out_lines.some((l) => l.includes("Finished task")),
    `success announced despite the failure: ${c.out_lines.join(" | ")}`,
  );
});

test("finish removes the worktree before deleting the container", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running" });
  assert.equal(await cmdFinish(ctx, "o/r", "feat", true), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  const removed = joined.findIndex((s) => s.includes("worktree remove"));
  const deleted = joined.findIndex((s) => s === "lxc delete agent-o-r-feat --force");
  assert.ok(removed >= 0 && deleted >= 0);
  assert.ok(removed < deleted, "sinon .git/worktrees/feat reste orpheline");
});

test("finish on a stopped task container goes through the template", async () => {
  const ctx = finishCtx({ task: "feat", status: "Stopped" });
  await cmdFinish(ctx, "o/r", "feat", true);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((s) => s.startsWith("lxc exec agent-o-r ") && s.includes("worktree remove")));
  assert.ok(joined.some((s) => s === "lxc start agent-o-r"));
  assert.ok(joined.some((s) => s === "lxc stop agent-o-r"));
});

test("finish runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running", dirty: true });
  await assert.rejects(() => cmdFinish(ctx, "o/r", "feat", false), /uncommitted changes/);
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});

// Tous les autres tests d'échec utilisent un container de tâche EN COURS
// D'EXÉCUTION comme git host : release() y prend la branche no-op, donc le
// chemin "on rendort le template" du `finally` n'est jamais exercé par un
// échec. Ici le container est arrêté (le template est réveillé) et la
// worktree est sale : cmdFinish rejette, mais le template doit quand même
// être rendormi.
test("finish stops a woken template even when the pre-flight rejects", async () => {
  const ctx = finishCtx({ task: "feat", status: "Stopped", dirty: true });
  await assert.rejects(() => cmdFinish(ctx, "o/r", "feat", false), /uncommitted changes/);
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc stop agent-o-r"));
});

test("finish retains the branch and says so", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running" });
  await cmdFinish(ctx, "o/r", "feat", true);
  assert.match(ctx.out_lines.join("\n"), /branch agent\/feat retained/);
});

test("finish cleans a worktree whose container is already gone", async () => {
  const ctx = finishCtx({ task: "feat", status: null });   // no task container in the fleet
  assert.equal(await cmdFinish(ctx, "o/r", "feat", true), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("worktree remove")));
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});
