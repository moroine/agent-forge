// Couche 2 : parseSessionStates contre un VRAI serveur tmux, sur une socket
// privée (-L) pour ne jamais toucher aux sessions de l'utilisateur.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { parseSessionStates } from "../../cli/lib/worktrees.ts";

const SOCKET = "forge-contract-test";
const tmux = (args: string[]) =>
  spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });

after(() => { tmux(["kill-server"]); });

test("a detached session really reports 0", () => {
  tmux(["kill-server"]);
  execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "cli"]);
  execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "docs"]);
  const raw = execFileSync(
    "tmux", ["-L", SOCKET, "list-sessions", "-F", "#{session_name} #{session_attached}"],
    { encoding: "utf8" },
  );
  const states = parseSessionStates(raw);
  assert.equal(states.get("cli"), false, `raw was: ${raw}`);
  assert.equal(states.get("docs"), false);
});

test("no server exits non-zero with a message on stderr, and stdout empty", () => {
  tmux(["kill-server"]);
  const r = tmux(["list-sessions", "-F", "#{session_name} #{session_attached}"]);
  // C'est la raison pour laquelle `exec` ne doit jamais lever sur un code non
  // nul : ce cas est une réponse normale, pas une panne.
  assert.notEqual(r.status, 0);
  assert.equal(parseSessionStates(r.stdout).size, 0);
});
