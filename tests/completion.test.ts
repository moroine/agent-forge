import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { shellQuote } from "../cli/lib/shell.ts";
import { cmdCompletion, completionScript, FORGE_BIN } from "../cli/lib/commands/completion.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
      { match: "incus --project agent-forge list", stdout: LIST },
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

test("tasks prints one task per line for a running container", async () => {
  const c = ctx();
  await cmdCompletion(c, "tasks", "moroine/agent-forge");
  assert.deepEqual(c.out_lines, ["cli", "docs"]);
});

test("tasks on a stopped container prints nothing and succeeds", async () => {
  const c = ctx();
  assert.equal(await cmdCompletion(c, "tasks", "acme/widgets"), 0);
  assert.deepEqual(c.out_lines, []);
});

test("tasks on an unknown repo fails", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "tasks", "nobody/nothing"), ForgeError);
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

test("the completion script offers setup", () => {
  assert.match(completionScript("/x/forge"), /compgen -W "setup start resume finish stop delete list egress image completion"/);
});

// Lance la fonction émise dans un vrai bash, contre un forge factice qui
// répond o/r et acme/w aux repos, et cli aux tâches de n'importe quel argument.
function complete(words: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "forge-compl-"));
  try {
    const stub = join(dir, "forge");
    writeFileSync(stub, '#!/bin/sh\n[ "$2" = repos ] && printf "o/r\\nacme/w\\n"\n[ "$2" = tasks ] && echo cli\nexit 0\n', { mode: 0o755 });
    const r = spawnSync("bash", ["-c", [
      completionScript(stub),
      `COMP_WORDS=(${words.map(shellQuote).join(" ")}); COMP_CWORD=${words.length - 1}`,
      '_forge_completions; printf "%s\\n" "${COMPREPLY[@]}"',
    ].join("\n")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n").filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resume completes --all beside the repos, and only resume does", () => {
  assert.deepEqual(complete(["forge", "resume", ""]).sort(), ["--all", "acme/w", "o/r"]);
  assert.deepEqual(complete(["forge", "resume", "--"]), ["--all"]);
  assert.deepEqual(complete(["forge", "start", ""]), ["o/r", "acme/w"]);
  assert.deepEqual(complete(["forge", "resume", "o/r", ""]), ["cli"]);
});

test("nothing is offered after resume --all", () => {
  assert.deepEqual(complete(["forge", "resume", "--all", ""]), []);
});

test("egress completes repos and log, then the modes, and log's repos", () => {
  assert.ok(completionScript("/x/forge").includes("egress"));
  assert.deepEqual(complete(["forge", "egress", ""]), ["log", "o/r", "acme/w"]);
  assert.deepEqual(complete(["forge", "egress", "o/r", ""]), ["strict", "open"]);
  assert.deepEqual(complete(["forge", "egress", "log", ""]), ["o/r", "acme/w"]);
});
