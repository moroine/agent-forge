// Le seam injecté : tout ce que le CLI fait au monde extérieur passe par ici,
// ce qui permet aux tests de le remplacer sans pty ni stub sur le PATH.
import { spawn } from "node:child_process";
import { createPrompt } from "./prompt.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { input?: string; env?: Record<string, string> };
export type AttachOptions = { env?: Record<string, string> };

export type Prompt = {
  pick(label: string, items: string[]): Promise<number | null>;
  ask(label: string): Promise<string | null>;
  askSecret(label: string): Promise<string | null>;
};

export type Context = {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  attach(argv: string[], opts?: AttachOptions): Promise<number>;
  prompt: Prompt;
  out(line: string): void;
  err(line: string): void;
};

// Erreur métier : le message est affiché tel quel par forge.ts, préfixé une
// seule fois par "Error: ".
export class ForgeError extends Error {}

// Le bash original tournait sous `set -e` : n'importe quelle étape mutante en
// échec interrompait la commande. Cette fonction restaure ce fail-fast pour
// chaque appel qui MODIFIE quelque chose (incus start/stop/delete/config set,
// git worktree add/remove, fetch…). Elle vit ici, à côté d'ExecResult et de
// ForgeError dont elle dépend, plutôt que dans un module dédié : toute la
// couche commandes importe déjà context.ts, aucun nouvel arc d'import.
//
// `ctx.exec` CAPTURE stderr là où bash en héritait : sans réinjecter
// `r.stderr` dans le message, le diagnostic d'incus/git — la seule chose que
// l'opérateur pouvait lire en bash — serait perdu.
//
// Les sondes (test -e, show-ref, rev-parse, list-sessions) ne passent JAMAIS
// par ici : leur code de sortie est une réponse, pas une panne.
export async function mustSucceed(step: string, result: Promise<ExecResult>): Promise<ExecResult> {
  const r = await result;
  if (r.code !== 0) {
    throw new ForgeError(`${step} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  return r;
}

// Ne rejette jamais sur un code non nul : plusieurs sondes (show-ref, test -e,
// tmux list-sessions) se servent du code de sortie comme réponse. Un binaire
// absent est rapporté de la même façon, par un code non nul.
function run(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // Les variables en plus se superposent à l'environnement hérité (PATH…).
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    // setEncoding AVANT toute concaténation : sans lui les chunks arrivent en
    // Buffer et `stdout += c` décode chacun isolément, ce qui casse tout
    // caractère multi-octets à cheval sur une frontière de chunk (messages de
    // commit accentués remontés par wip.ts) et corrompt un `incus list -f json`
    // de plus de 64 Ko — JSON.parse échouerait alors en silence.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// Hérite du terminal au lieu de capturer : c'est le cas de l'agent. Il doit
// rester la cible directe de `incus exec`, sinon SIGWINCH n'atteint jamais le
// client au redimensionnement. opts.env se superpose à l'environnement hérité.
function attach(argv: string[], opts?: AttachOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: "inherit",
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function createContext(): Context {
  return {
    exec: run,
    attach,
    prompt: createPrompt(),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}
