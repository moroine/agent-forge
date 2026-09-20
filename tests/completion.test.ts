import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdCompletion, completionScript, FORGE_BIN } from "../scripts/lib/commands/completion.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
      { match: "lxc list", stdout: LIST },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
    ],
  });
}

test("repos prints one owner/repo per line", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos", undefined);
  assert.deepEqual(c.out_lines, ["moroine/agent-forge", "acme/widgets"]);
});

test("repos never shells into a container, so TAB stays fast", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos", undefined);
  assert.ok(!c.calls.some((call) => call[1] === "exec"));
});

// Une tâche est désormais son propre container (user.forge.role=task), pas
// une entrée `git worktree list` sondée dans le container du repo — même
// construction que fleetCtx dans tests/list.test.ts.
function fleetCtx(opts: { repo?: string; tasks?: Record<string, string> } = {}) {
  const repo = opts.repo ?? "o/r";
  const tasks = opts.tasks ?? {};
  const slug = repo.replace(/\//g, "-");
  const templateName = `agent-${slug}`;
  const instances: { name: string; status: string }[] = [{ name: templateName, status: "Stopped" }];
  const meta: Record<string, Record<string, string>> = {
    [templateName]: { repo, mode: "autonomous", role: "template", task: "" },
  };
  for (const [task, status] of Object.entries(tasks)) {
    const name = `${templateName}-${task}`;
    instances.push({ name, status });
    meta[name] = { repo, mode: "autonomous", role: "task", task };
  }

  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify(instances) },
      ...Object.entries(meta).flatMap(([name, m]) => [
        { match: `${name} user.forge.repo`, stdout: m.repo },
        { match: `${name} user.forge.mode`, stdout: m.mode },
        { match: `${name} user.forge.role`, stdout: m.role },
        { match: `${name} user.forge.task`, stdout: m.task },
      ]),
    ],
  });
}

test("completion tasks lists task containers without any lxc exec", async () => {
  const c = fleetCtx({ tasks: { cli: "Running", api: "Stopped" } });
  await cmdCompletion(c, "tasks", "o/r");
  assert.deepEqual(c.out_lines, ["cli", "api"]);
  assert.ok(!c.calls.some((call) => call[1] === "exec"));
});

test("completion tasks on an unknown repo prints nothing and does not throw", async () => {
  const c = fleetCtx({ tasks: {} });
  assert.equal(await cmdCompletion(c, "tasks", "nobody/nothing"), 0);
  assert.deepEqual(c.out_lines, []);
});

test("tasks without a repo argument fails with usage", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "tasks", undefined), /Usage: forge completion/);
});

test("an unknown subcommand fails with usage", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "zsh", undefined), /Usage: forge completion/);
});

test("the emitted bash script reads the machine subcommands, not the table", async () => {
  const c = ctx();
  await cmdCompletion(c, "bash", undefined);
  const script = c.out_lines.join("\n");
  assert.ok(script.includes("forge completion repos"));
  assert.ok(script.includes("forge completion tasks"));
  assert.ok(!script.includes("awk"));
  assert.ok(script.includes("complete -F _forge_completions forge"));
});

test("the emitted script calls forge by absolute path, not by name", async () => {
  const c = ctx();
  await cmdCompletion(c, "bash", undefined);
  const script = c.out_lines.join("\n");
  // Le `eval "$(forge completion bash)"` d'un .bashrc peut s'executer avant que
  // `forge` soit resolvable (alias ou PATH definis plus bas) : la fonction ne
  // doit donc pas dependre du nom. FORGE_BIN pointe le shim, pas forge.ts,
  // parce que c'est le shim qui est executable.
  assert.ok(FORGE_BIN.startsWith("/"), `FORGE_BIN must be absolute, got: ${FORGE_BIN}`);
  assert.ok(FORGE_BIN.endsWith("/forge"), `FORGE_BIN must point at the shim, got: ${FORGE_BIN}`);
  assert.ok(script.includes(`${FORGE_BIN} completion repos`),
    `script must call forge by absolute path, got: ${script}`);
  assert.ok(script.includes(`${FORGE_BIN} completion tasks`));
  assert.ok(!/\$\(forge completion/.test(script),
    `script must not call bare "forge", got: ${script}`);
});

test("the completion script offers tasks in third position and --force where it applies", () => {
  assert.ok(completionScript(FORGE_BIN).includes("start|resume|finish"));
  assert.ok(completionScript(FORGE_BIN).includes("--force"));
});

test("the emitted bash function offers the new top-level commands", () => {
  const script = completionScript("/abs/forge");
  assert.match(script, /start resume finish stop delete list template token claude image completion/);
  assert.match(script, /template\)/);
  assert.match(script, /token\)/);
  assert.match(script, /claude\)/);
});
