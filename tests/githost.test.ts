import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import { acquireGitHost } from "../scripts/lib/githost.ts";

function ctxFor(
  fleet: { name: string; status: string; role: string; task: string }[],
  extraRules: { match: string; code?: number; stdout?: string; stderr?: string }[] = [],
) {
  return fakeContext({
    rules: [
      ...extraRules,
      { match: "lxc list", stdout: JSON.stringify(fleet.map((c) => ({ name: c.name, status: c.status }))) },
      ...fleet.flatMap((c) => [
        { match: `config get ${c.name} user.forge.repo`, stdout: "o/r" },
        { match: `config get ${c.name} user.forge.mode`, stdout: "autonomous" },
        { match: `config get ${c.name} user.forge.role`, stdout: c.role },
        { match: `config get ${c.name} user.forge.task`, stdout: c.task },
      ]),
    ],
  });
}

test("a running preferred container is used as-is and released without stopping", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-feat", status: "Running", role: "task", task: "feat" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-feat");
  assert.equal(host.name, "agent-o-r-feat");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("another running task container is preferred over waking the template", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-dead", status: "Stopped", role: "task", task: "dead" },
    { name: "agent-o-r-live", status: "Running", role: "task", task: "live" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-dead");
  assert.equal(host.name, "agent-o-r-live");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("with nothing running, the template is started and stopped again on release", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Stopped", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r"));
  await host.release();
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc stop agent-o-r"));
});

test("a running template is used without being stopped afterwards", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Running", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
});

// Un container HÉRITÉ (user.forge.repo, pas de user.forge.role) monte le même
// /workspace : il fait tourner git pour ce repo aussi bien qu'un autre.
// acquireGitHost ne le sélectionnait jamais, si bien que `forge delete` — la
// commande que README et `forge list` prescrivent pour migrer un tel
// container — mourait sur son propre pré-vol WIP.
test("a running legacy container runs git when nothing else can", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Running", role: "", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
});

test("a stopped legacy container is woken, then stopped again on release", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Stopped", role: "", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r"));
  await host.release();
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc stop agent-o-r"));
});

test("the template is preferred over a legacy container when both are stopped", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r-old", status: "Stopped", role: "", task: "" },
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
  ]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
});

test("a repo with no container at all is a ForgeError", async () => {
  await assert.rejects(() => acquireGitHost(ctxFor([]), "o/r"), ForgeError);
});

// release() est volontairement non fatal (voir le commentaire dans
// githost.ts) : un `lxc stop` qui échoue au réveil du template ne doit
// jamais faire planter release(), mais il ne doit pas non plus rester
// silencieux — l'opérateur doit voir le container resté allumé.
test("a template that fails to stop again warns instead of throwing", async () => {
  const ctx = ctxFor(
    [{ name: "agent-o-r", status: "Stopped", role: "template", task: "" }],
    [{ match: "lxc stop", code: 1, stderr: "Error: Failed to stop instance\n" }],
  );
  const host = await acquireGitHost(ctx, "o/r");
  await assert.doesNotReject(() => host.release());
  assert.ok(ctx.err_lines.some((l) => l.includes("WARNING") && l.includes("agent-o-r")));
});
