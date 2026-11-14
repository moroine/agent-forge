import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { shellQuote } from "../cli/lib/shell.ts";
import { cmdCompletion, completionScript, FORGE_BIN } from "../cli/lib/commands/completion.ts";

const LIST = JSON.stringify([
  { name: "agent-alice-project", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "agent-alice-project user.forge.repo", stdout: "alice/project" },
      { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
      { match: "incus --project agent-forge list", stdout: LIST },
    ],
  });
}

test("repos prints one owner/repo per line", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos");
  assert.deepEqual(c.out_lines, ["alice/project", "acme/widgets"]);
});

test("repos never shells into a container, so TAB stays fast", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos");
  assert.ok(!c.calls.some((call) => call[1] === "exec"));
});

test("an unknown subcommand fails with usage", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "zsh"), /Usage: forge completion/);
});

test("the emitted bash script reads the machine subcommands, not the table", async () => {
  const c = ctx();
  await cmdCompletion(c, "bash");
  const script = c.out_lines.join("\n");
  assert.ok(script.includes("forge completion repos"));
  assert.ok(!script.includes("awk"));
  assert.ok(script.includes("complete -F _forge_completions forge"));
});

test("the emitted script calls forge by absolute path, not by name", async () => {
  const c = ctx();
  await cmdCompletion(c, "bash");
  const script = c.out_lines.join("\n");
  // Le `eval "$(forge completion bash)"` d'un .bashrc peut s'executer avant que
  // `forge` soit resolvable (alias ou PATH definis plus bas) : la fonction ne
  // doit donc pas dependre du nom. FORGE_BIN pointe le shim, pas forge.ts,
  // parce que c'est le shim qui est executable.
  assert.ok(FORGE_BIN.startsWith("/"), `FORGE_BIN must be absolute, got: ${FORGE_BIN}`);
  assert.ok(FORGE_BIN.endsWith("/forge"), `FORGE_BIN must point at the shim, got: ${FORGE_BIN}`);
  assert.ok(script.includes(`${FORGE_BIN} completion repos`),
    `script must call forge by absolute path, got: ${script}`);
  assert.ok(!/\$\(forge completion/.test(script),
    `script must not call bare "forge", got: ${script}`);
});

test("the completion script offers --force where it applies", () => {
  assert.ok(completionScript(FORGE_BIN).includes("--force"));
});

test("the completion script offers setup", () => {
  assert.match(completionScript("/x/forge"), /compgen -W "setup stop delete list egress image team api completion"/);
});

// Lance la fonction émise dans un vrai bash, contre un forge factice qui
// répond o/r et acme/w aux repos.
function complete(words: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "forge-compl-"));
  try {
    const stub = join(dir, "forge");
    writeFileSync(stub, '#!/bin/sh\n[ "$2" = repos ] && printf "o/r\\nacme/w\\n"\nexit 0\n', { mode: 0o755 });
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

test("stop and delete complete the repos, then --force", () => {
  assert.deepEqual(complete(["forge", "stop", ""]), ["o/r", "acme/w"]);
  assert.deepEqual(complete(["forge", "delete", "o/r", ""]), ["--force"]);
});

test("egress completes repos and log, then the modes, and log's repos", () => {
  assert.ok(completionScript("/x/forge").includes("egress"));
  assert.deepEqual(complete(["forge", "egress", ""]), ["log", "o/r", "acme/w"]);
  assert.deepEqual(complete(["forge", "egress", "o/r", ""]), ["strict", "open"]);
  assert.deepEqual(complete(["forge", "egress", "log", ""]), ["o/r", "acme/w"]);
});
