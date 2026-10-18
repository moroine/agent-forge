// Worktrees, branches agent/* et tâches en cours d'un container.
//
// Les fonctions parse* sont pures et exportées à part : ce sont elles que les
// tests de contrat (couche 2) alimentent avec la sortie d'un *vrai* git et
// de `ps`, sans LXD.
import type { Context } from "./context.ts";
import { execAsAgent, execAsAgentArgv } from "./incus.ts";
import { AGENT } from "./agent.ts";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function worktreeRelPath(task: string): string { return `.trees/${task}`; }
export function worktreeAbsPath(task: string): string { return `/workspace/.trees/${task}`; }

// `git worktree list --porcelain` sort des strophes séparées par une ligne
// vide ; seule la ligne "worktree <path>" nous intéresse. Le clone principal
// est exclu — pas en comparant au chemin littéral "/workspace" (le contrat
// réel montre que le clone principal d'un dépôt jetable, utilisé par
// tests/contract/git.test.ts, ne vit jamais à ce chemin-là), mais en ne
// gardant que les chemins situés sous ".trees/", le seul endroit où
// worktreeAbsPath crée effectivement une worktree.
//
// Défense en profondeur : on écarte aussi tout basename hors du charset imposé
// aux noms de branche, avant qu'il ne reparte dans un `su -c`. Un worktree ne
// peut être créé que via validate.ts, donc cela ne devrait jamais se
// déclencher — c'est un filtre, pas une erreur fatale, pour qu'une entrée
// hostile n'interrompe pas le reste.
export function parseWorktreeDirs(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((dir) => dir.includes("/.trees/"))
    .filter((dir) => SAFE_NAME.test(dir.split("/").pop() ?? ""));
}

// `for-each-ref --format='%(refname:short)'` rend déjà `agent/cli` (et
// `origin/agent/api`), pas `refs/heads/agent/cli` : on ne retire donc que le
// préfixe court. Vérifié contre un vrai git dans tests/contract/git.test.ts.
export function parseAgentBranches(refs: string): string[] {
  return refs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(origin\/)?agent\//, ""))
    .filter((name) => SAFE_NAME.test(name));
}

// Une tâche tourne tant que le processus de son agent existe : sa ligne de
// commande porte `--remote-control <container>-<task>` (AGENT.marker). Le nom
// doit finir à un blanc ou en fin de ligne, sinon `agent-x-a;rm` passerait pour
// la tâche « a » ; un nom hors du charset sûr est ignoré.
export function parseRunningTasks(ps: string, container: string): Set<string> {
  const flag = AGENT.marker(container, "").trimEnd().split(" ")[0];
  const prefix = `${container}-`;
  const tasks = new Set<string>();
  for (const line of ps.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i] !== flag || !tokens[i + 1].startsWith(prefix)) continue;
      const task = tokens[i + 1].slice(prefix.length);
      if (task && SAFE_NAME.test(task)) tasks.add(task);
    }
  }
  return tasks;
}

export async function worktreeDirs(ctx: Context, container: string): Promise<string[]> {
  const r = await execAsAgent(ctx, container, "cd /workspace && git worktree list --porcelain");
  return r.code === 0 ? parseWorktreeDirs(r.stdout) : [];
}

export async function taskNames(ctx: Context, container: string): Promise<string[]> {
  return (await worktreeDirs(ctx, container)).map((d) => d.split("/").pop() as string);
}

export async function agentBranches(ctx: Context, container: string, refspace: string): Promise<string[]> {
  const r = await execAsAgent(
    ctx, container,
    `git -C /workspace for-each-ref --format='%(refname:short)' ${refspace}`,
  );
  return r.code === 0 ? parseAgentBranches(r.stdout) : [];
}

export async function branchExists(ctx: Context, container: string, ref: string): Promise<boolean> {
  const r = await execAsAgent(ctx, container, `git -C /workspace show-ref --verify --quiet ${ref}`);
  return r.code === 0;
}

// Sonde : un `ps` en échec (container qui s'arrête) donne « rien ne tourne ».
export async function runningTasks(ctx: Context, container: string): Promise<Set<string>> {
  const r = await execAsAgentArgv(ctx, container, ["ps", "-u", "1001", "-o", "args="]);
  return parseRunningTasks(r.code === 0 ? r.stdout : "", container);
}
