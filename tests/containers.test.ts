import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import {
  listForgeContainers, forgeRepos,
  checkNameCollision, isRunning, buildStatus, baseImageFor, latestImageCommitFor,
  ROLE_TASK, ROLE_TEMPLATE, templateContainerName, taskContainerName,
  describeContainers, templateForRepo, requireTemplateForRepo,
  taskContainersForRepo, containerForTask, requireContainerForTask, isLegacy,
} from "../scripts/lib/containers.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
  { name: "unrelated-container", status: "Running" },
]);

function ctxWith(repos: Record<string, string>) {
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: LIST },
      ...Object.entries(repos).map(([name, repo]) => ({
        match: `config get ${name} user.forge.repo`,
        stdout: repo,
      })),
    ],
  });
}

test("listForgeContainers keeps only agent-* names", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST }] });
  assert.deepEqual(await listForgeContainers(ctx), [
    "agent-moroine-agent-forge",
    "agent-acme-widgets",
  ]);
});

test("forgeRepos reads config keys only, never lxc exec", async () => {
  const ctx = ctxWith({
    "agent-moroine-agent-forge": "moroine/agent-forge",
    "agent-acme-widgets": "acme/widgets",
  });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge", "acme/widgets"]);
  assert.ok(!ctx.calls.some((c) => c[1] === "exec"), "un TAB doit rester rapide");
});

test("forgeRepos skips a container with no repo metadata", async () => {
  const ctx = ctxWith({ "agent-moroine-agent-forge": "moroine/agent-forge" });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge"]);
});

test("checkNameCollision refuses a container with no forge metadata", async () => {
  const ctx = fakeContext({
    rules: [{ match: "lxc info", code: 0 }, { match: "config get", stdout: "" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /no user.forge.repo metadata/);
});

test("checkNameCollision refuses a container belonging to another repo", async () => {
  const ctx = fakeContext({
    rules: [{ match: "lxc info", code: 0 }, { match: "config get", stdout: "other/repo" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /different repo/);
});

// Le repo correspond, donc les deux garde-fous précédents laissaient passer —
// et `lxc launch` mourait ensuite sur un « instance already exists » brut, qui
// ne dit rien de la migration à faire.
test("checkNameCollision refuses a legacy container squatting the name", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "lxc info", code: 0 },
      { match: "user.forge.repo", stdout: "o/r" },
      { match: "user.forge.role", stdout: "" },
    ],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-o-r", "o/r"), /legacy forge container/);
  await assert.rejects(() => checkNameCollision(ctx, "agent-o-r", "o/r"), /forge delete/);
});

test("checkNameCollision accepts a container of the same repo that carries a role", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "lxc info", code: 0 },
      { match: "user.forge.repo", stdout: "o/r" },
      { match: "user.forge.role", stdout: "task" },
    ],
  });
  await checkNameCollision(ctx, "agent-o-r-feat", "o/r");
});

test("checkNameCollision accepts a not-yet-existing container", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc info", code: 1 }] });
  await checkNameCollision(ctx, "agent-x", "o/r");
});

test("isRunning is true only for Running", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST }] });
  assert.equal(await isRunning(ctx, "agent-moroine-agent-forge"), true);
  assert.equal(await isRunning(ctx, "agent-acme-widgets"), false);
  assert.equal(await isRunning(ctx, "absent"), false);
});

test("buildStatus compares the two stamps", () => {
  assert.equal(buildStatus("aaa", "aaa"), "up-to-date");
  assert.equal(buildStatus("aaa", "bbb"), "behind");
  assert.equal(buildStatus("", "bbb"), "unknown");
  assert.equal(buildStatus("aaa", ""), "unknown");
});

test("baseImageFor maps super to agent-base-super, everything else to agent-base", () => {
  assert.equal(baseImageFor("super"), "agent-base-super");
  assert.equal(baseImageFor("autonomous"), "agent-base");
  assert.equal(baseImageFor("supervised"), "agent-base");
  assert.equal(baseImageFor(""), "agent-base");
});

test("latestImageCommitFor reads the commit of the mode's base image", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "image get-property agent-base-super", stdout: "SUPERSHA\n" },
      { match: "image get-property agent-base", stdout: "BASESHA\n" },
    ],
  });
  assert.equal(await latestImageCommitFor(ctx, "super"), "SUPERSHA");
  assert.equal(await latestImageCommitFor(ctx, "autonomous"), "BASESHA");
});

const FLEET = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Stopped" },
  { name: "agent-moroine-agent-forge-cli", status: "Running" },
  { name: "agent-moroine-agent-forge-api", status: "Stopped" },
  { name: "agent-acme-widgets", status: "Stopped" },
  { name: "agent-legacy-thing", status: "Running" },
  { name: "unrelated-container", status: "Running" },
]);

function fleetCtx() {
  const meta: Record<string, Record<string, string>> = {
    "agent-moroine-agent-forge":     { repo: "moroine/agent-forge", mode: "super",      role: "template", task: "" },
    "agent-moroine-agent-forge-cli": { repo: "moroine/agent-forge", mode: "super",      role: "task",     task: "cli" },
    "agent-moroine-agent-forge-api": { repo: "moroine/agent-forge", mode: "super",      role: "task",     task: "api" },
    "agent-acme-widgets":            { repo: "acme/widgets",        mode: "supervised", role: "template", task: "" },
    "agent-legacy-thing":            { repo: "legacy/thing",        mode: "autonomous", role: "",         task: "" },
  };
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: FLEET },
      ...Object.entries(meta).flatMap(([name, m]) => [
        { match: `config get ${name} user.forge.repo`, stdout: m.repo },
        { match: `config get ${name} user.forge.mode`, stdout: m.mode },
        { match: `config get ${name} user.forge.role`, stdout: m.role },
        { match: `config get ${name} user.forge.task`, stdout: m.task },
      ]),
    ],
  });
}

test("templateContainerName keeps today's repo-container name", () => {
  assert.equal(templateContainerName("moroine/agent-forge"), "agent-moroine-agent-forge");
});

test("taskContainerName suffixes the task and sanitizes it", () => {
  assert.equal(taskContainerName("moroine/agent-forge", "cli"), "agent-moroine-agent-forge-cli");
  assert.equal(taskContainerName("Moroine/Agent_Forge", "Feat.A"), "agent-moroine-agent-forge-feat-a");
});

test("taskContainerName stays within LXD's 63 chars and never ends in a hyphen", () => {
  const name = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  assert.ok(name.length <= 63, `got ${name.length}: ${name}`);
  assert.ok(!name.endsWith("-"), name);
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
});

test("taskContainerName is deterministic and collision-resistant when truncated", () => {
  const a = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  const b = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  const c = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-agaix");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("describeContainers reads the fleet with a single lxc list", async () => {
  const ctx = fleetCtx();
  const all = await describeContainers(ctx);
  assert.deepEqual(all.map((c) => c.name), [
    "agent-moroine-agent-forge", "agent-moroine-agent-forge-cli",
    "agent-moroine-agent-forge-api", "agent-acme-widgets", "agent-legacy-thing",
  ]);
  assert.equal(ctx.calls.filter((c) => c[1] === "list").length, 1);
});

test("templateForRepo finds the role=template container, case-insensitively", async () => {
  const ctx = fleetCtx();
  const t = await templateForRepo(ctx, "Moroine/Agent-Forge");
  assert.equal(t?.name, "agent-moroine-agent-forge");
  assert.equal(t?.role, ROLE_TEMPLATE);
  assert.equal(t?.mode, "super");
});

test("templateForRepo ignores a legacy container with no role", async () => {
  assert.equal(await templateForRepo(fleetCtx(), "legacy/thing"), null);
});

test("requireTemplateForRepo names the repo and the fix", async () => {
  await assert.rejects(() => requireTemplateForRepo(fleetCtx(), "nobody/nothing"), /nobody\/nothing/);
  await assert.rejects(() => requireTemplateForRepo(fleetCtx(), "nobody/nothing"), /forge start/);
});

test("taskContainersForRepo returns only role=task, for that repo", async () => {
  const tasks = await taskContainersForRepo(fleetCtx(), "moroine/agent-forge");
  assert.deepEqual(tasks.map((c) => c.task), ["cli", "api"]);
  assert.deepEqual(tasks.map((c) => c.status), ["Running", "Stopped"]);
});

test("containerForTask matches on user.forge.task, not on the name", async () => {
  const c = await containerForTask(fleetCtx(), "moroine/agent-forge", "api");
  assert.equal(c?.name, "agent-moroine-agent-forge-api");
  assert.equal(await containerForTask(fleetCtx(), "moroine/agent-forge", "absent"), null);
});

test("requireContainerForTask throws a ForgeError naming the task", async () => {
  await assert.rejects(() => requireContainerForTask(fleetCtx(), "moroine/agent-forge", "absent"), ForgeError);
  await assert.rejects(() => requireContainerForTask(fleetCtx(), "moroine/agent-forge", "absent"), /absent/);
});

test("isLegacy flags a forge container with no role", async () => {
  const all = await describeContainers(fleetCtx());
  assert.deepEqual(all.filter(isLegacy).map((c) => c.name), ["agent-legacy-thing"]);
});

test("forgeRepos de-duplicates repos shared by several containers", async () => {
  assert.deepEqual(await forgeRepos(fleetCtx()), ["moroine/agent-forge", "acme/widgets", "legacy/thing"]);
});
