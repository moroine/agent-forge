// Worktrees, branches agent/*, et sessions tmux d'un container.
//
// Les fonctions parse* sont pures et exportées à part : ce sont elles que les
// tests de contrat (couche 2) alimentent avec la sortie d'un *vrai* git et
// d'un *vrai* tmux, sans LXD.
import type { Context } from "./context.ts";
import { execAsAgent } from "./incus.ts";

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

// `tmux has-session` ne disait que « la session existe », donc une session que
// personne n'a ouverte était rapportée attachée. #{session_attached} distingue
// vraiment les deux. Sans serveur, tmux sort en 1 avec un message sur stderr :
// stdout est vide, la map l'est aussi.
export function parseSessionStates(output: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    const [name, flag] = line.trim().split(/\s+/);
    if (name && (flag === "0" || flag === "1")) states.set(name, flag === "1");
  }
  return states;
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

export async function sessionStates(ctx: Context, container: string): Promise<Map<string, boolean>> {
  const r = await execAsAgent(
    ctx, container,
    "tmux list-sessions -F '#{session_name} #{session_attached}'",
  );
  return parseSessionStates(r.code === 0 ? r.stdout : "");
}
