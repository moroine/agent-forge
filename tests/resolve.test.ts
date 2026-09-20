import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { resolveRepo, resolveTask } from "../scripts/lib/commands/resolve.ts";

const FLEET = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-moroine-agent-forge-cli", status: "Running" },
  { name: "agent-acme-widgets", status: "Running" },
]);

// Bâti comme fleetCtx dans tests/containers.test.ts : un `lxc list` unique
// puis les clés de config par container.
function fleetCtx(opts: { answers?: (number | string | null)[]; tty?: boolean } = {}) {
  const meta: Record<string, Record<string, string>> = {
    "agent-moroine-agent-forge":     { repo: "moroine/agent-forge", mode: "autonomous", role: "template", task: "" },
    "agent-moroine-agent-forge-cli": { repo: "moroine/agent-forge", mode: "autonomous", role: "task", task: "cli" },
    "agent-acme-widgets":            { repo: "acme/widgets", mode: "autonomous", role: "template", task: "" },
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
    answers: opts.answers,
    tty: opts.tty,
  });
}

test("a provided repo is returned untouched, with no prompt", async () => {
  const c = fleetCtx();
  assert.equal(await resolveRepo(c, "given/repo", "usage"), "given/repo");
  assert.equal(c.err_lines.length, 0);
});

test("a missing repo is picked from the managed repos", async () => {
  const c = fleetCtx({ answers: [2] });
  assert.equal(await resolveRepo(c, undefined, "usage"), "acme/widgets");
});

test("resolveRepo throws the usage when it cannot ask", async () => {
  const c = fleetCtx({ tty: false });
  await assert.rejects(() => resolveRepo(c, undefined, "Usage: forge stop <owner/repo>"), /Usage: forge stop/);
});

test("resolveRepo explains when no container exists at all", async () => {
  const c = fakeContext({ rules: [{ match: "lxc list", stdout: "[]" }] });
  await assert.rejects(() => resolveRepo(c, undefined, "usage"), /no forge container yet/);
});

test("resolveTask lists task containers and issues no lxc exec", async () => {
  const c = fleetCtx({ answers: [1] });
  assert.equal(await resolveTask(c, "moroine/agent-forge", undefined, "usage"), "cli");
  assert.ok(!c.calls.some((call) => call[1] === "exec"), "un menu doit rester instantané");
});

test("a named task passes straight through, with no lookup at all", async () => {
  const c = fleetCtx();
  assert.equal(await resolveTask(c, "moroine/agent-forge", "given-task", "usage"), "given-task");
  assert.equal(c.calls.length, 0);
});

test("resolveTask explains when the repo has no task container", async () => {
  const c = fleetCtx();
  await assert.rejects(() => resolveTask(c, "acme/widgets", undefined, "usage"), /forge start/);
});
