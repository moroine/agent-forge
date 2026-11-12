// Le seam injecté : tout ce que le CLI fait au monde extérieur passe par ici,
// ce qui permet aux tests de le remplacer sans pty ni stub sur le PATH.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createPrompt } from "./prompt.ts";

// `timedOut` : présent, et vrai, seulement quand `timeoutMs` a coupé la commande.
export type ExecResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
// `cwd` absent : le répertoire courant de forge, hérité. `timeoutMs` : au-delà,
// la commande est tuée (voir run).
export type ExecOptions = { input?: string; env?: Record<string, string>; cwd?: string; timeoutMs?: number };
export type AttachOptions = { env?: Record<string, string>; cwd?: string };

export type Prompt = {
  // Le numéro affiché que l'utilisateur a choisi, de 1 à items.length (pas
  // un index : items[n - 1]), ou null sans terminal ni réponse.
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
  // Une attente courte entre deux regards sur un état ; les tests la rendent
  // immédiate. Absente : setTimeout.
  sleep?(ms: number): Promise<void>;
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
// Les sondes (test -e, show-ref, rev-parse, ps) ne passent JAMAIS par ici :
// leur code de sortie est une réponse, pas une panne.
export async function mustSucceed(step: string, result: Promise<ExecResult>): Promise<ExecResult> {
  const r = await result;
  if (r.code !== 0) {
    throw new ForgeError(`${step} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  return r;
}

// Le code de sortie d'un enfant, à la manière du shell : tué par un signal, il
// vaut 128 + le numéro du signal. Jamais 0 : git (upload-pack) croirait à un
// succès.
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + (signal ? constants.signals[signal] : 0);
}

// Ne rejette jamais sur un code non nul : plusieurs sondes (show-ref, test -e,
// pkill) se servent du code de sortie comme réponse. Un binaire absent est
// rapporté de la même façon, par un code non nul.
//
// Avec `timeoutMs`, l'enfant a son propre groupe de processus, et passé ce
// délai tout le groupe est tué (SIGKILL) : l'enfant et ce qu'il a lancé, git
// et son ssh par exemple. Le seul enfant ne suffirait pas : un petit-enfant
// qui garde stdout ou stderr ouvert retiendrait la fin de la commande. Le
// résultat porte alors le code 124, celui de timeout(1), et `timedOut`. Un
// délai en Node plutôt que timeout(1), absent d'un macOS sans coreutils.
function run(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // Les variables en plus se superposent à l'environnement hérité (PATH…).
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
      detached: opts.timeoutMs !== undefined,
    });
    let timedOut = false;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Le groupe a déjà fini.
      }
    }, opts.timeoutMs);
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
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(e) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(timedOut ? { code: 124, stdout, stderr, timedOut } : { code: exitCode(code, signal), stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// Hérite du terminal au lieu de capturer : c'est le cas de l'agent et
// d'ansible-playbook. L'agent doit rester la cible directe de `incus exec`,
// sinon SIGWINCH n'atteint jamais le client au redimensionnement. opts.env se
// superpose à l'environnement hérité ; opts.cwd absent : celui de forge.
function attach(argv: string[], opts?: AttachOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: "inherit",
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts?.cwd,
    });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(exitCode(code, signal)));
  });
}

export function createContext(): Context {
  return {
    exec: run,
    attach,
    prompt: createPrompt(),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
