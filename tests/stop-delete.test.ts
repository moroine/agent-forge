import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import type { ExecRule } from "./lib/fake-context.ts";
import { cmdStop } from "../scripts/lib/commands/stop.ts";
import { cmdDelete } from "../scripts/lib/commands/delete.ts";

// Bâti comme `fleetCtx` dans tests/containers.test.ts : un seul `lxc list`,
// puis les quatre clés user.forge.{repo,mode,role,task} par container.
function fleetCtx(opts: {
  tasks?: Record<string, string>; template?: string; dirty?: boolean; extra?: ExecRule[];
}) {
  const ownerRepo = "o/r";
  const containers: { name: string; status: string; role: string; task: string }[] = [];
  for (const [task, status] of Object.entries(opts.tasks ?? {})) {
    containers.push({ name: `agent-o-r-${task}`, status, role: "task", task });
  }
  if (opts.template) {
    containers.push({ name: "agent-o-r", status: opts.template, role: "template", task: "" });
  }

  const list = JSON.stringify(containers.map((c) => ({ name: c.name, status: c.status })));
  const rules: ExecRule[] = [
    // Les règles spécifiques à un test (ex: faire échouer un `lxc stop`/`lxc
    // delete` précis) passent en premier : la première correspondance gagne.
    ...(opts.extra ?? []),
    { match: "lxc list", stdout: list },
    ...containers.flatMap((c) => [
      { match: `config get ${c.name} user.forge.repo`, stdout: ownerRepo },
      { match: `config get ${c.name} user.forge.mode`, stdout: "autonomous" },
      { match: `config get ${c.name} user.forge.role`, stdout: c.role },
      { match: `config get ${c.name} user.forge.task`, stdout: c.task },
    ]),
    { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
    { match: "status --porcelain", stdout: opts.dirty ? " M scripts/forge\n" : "" },
  ];

  return fakeContext({ rules });
}

test("stop pauses one task without any WIP pre-flight", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running", other: "Running" } });
  assert.equal(await cmdStop(ctx, "o/r", "feat"), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc stop agent-o-r-feat"));
  assert.ok(!joined.includes("lxc stop agent-o-r-other"), "une pause ne touche pas les voisines");
  assert.ok(!joined.some((s) => s.includes("status --porcelain")), "plus de pré-vol sur stop");
});

test("stop without a task pauses every running container of the repo", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running", other: "Stopped" }, template: "Running" });
  await cmdStop(ctx, "o/r", undefined);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc stop agent-o-r-feat"));
  assert.ok(joined.includes("lxc stop agent-o-r"));
  assert.ok(!joined.includes("lxc stop agent-o-r-other"), "déjà arrêtée");
});

test("stop names the task when it has no container", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running" } });
  await assert.rejects(() => cmdStop(ctx, "o/r", "absent"), /absent/);
});

test("delete removes every task container and the template", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped", other: "Stopped" }, template: "Stopped" });
  assert.equal(await cmdDelete(ctx, "o/r", true), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc delete agent-o-r-feat --force"));
  assert.ok(joined.includes("lxc delete agent-o-r-other --force"));
  assert.ok(joined.includes("lxc delete agent-o-r --force"));
});

test("delete deletes the template last", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped" }, template: "Stopped" });
  await cmdDelete(ctx, "o/r", true);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.indexOf("lxc delete agent-o-r-feat --force") < joined.indexOf("lxc delete agent-o-r --force"));
});

test("delete runs the WIP pre-flight across every worktree unless forced", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running" }, dirty: true });
  await assert.rejects(() => cmdDelete(ctx, "o/r", false), /uncommitted changes/);
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});

test("delete says the host mount survives", async () => {
  const ctx = fleetCtx({ tasks: {}, template: "Stopped" });
  await cmdDelete(ctx, "o/r", true);
  assert.match(ctx.out_lines.join("\n"), /workspace|mount/i);
});

test("stop says a task is already stopped and issues no lxc stop", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped" } });
  assert.equal(await cmdStop(ctx, "o/r", "feat"), 0);
  assert.ok(ctx.out_lines.some((l) => l.includes("already stopped")));
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("lxc stop")));
});

test("delete refuses when there is no container for the repo, naming it", async () => {
  const ctx = fleetCtx({});
  await assert.rejects(() => cmdDelete(ctx, "o/r", true), /o\/r/);
});

// Fail-fast : `ctx.exec` capture stderr là où bash en héritait. Sans
// mustSucceed, un `lxc stop`/`lxc delete` en échec rendait 0 et n'affichait
// rien du tout — pire que le bash d'origine sous `set -e`.
test("stop fails loudly when lxc stop fails, surfacing its stderr", async () => {
  const ctx = fleetCtx({
    tasks: { feat: "Running" },
    extra: [{ match: "lxc stop agent-o-r-feat", code: 1, stderr: "Error: The instance is currently in use\n" }],
  });
  await assert.rejects(
    () => cmdStop(ctx, "o/r", "feat"),
    /lxc stop failed: Error: The instance is currently in use/,
  );
});

test("delete fails loudly when lxc delete fails, surfacing its stderr", async () => {
  const ctx = fleetCtx({
    tasks: { feat: "Stopped" },
    template: "Stopped",
    extra: [{ match: "lxc delete agent-o-r-feat", code: 1, stderr: "Error: Instance is protected\n" }],
  });
  await assert.rejects(
    () => cmdDelete(ctx, "o/r", true),
    /lxc delete failed: Error: Instance is protected/,
  );
});
