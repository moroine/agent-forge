// forge start [<owner/repo>] [<task>]
//
// La branche de la tâche est *résolue* au lieu de partir systématiquement de
// origin/main : c'est ce qui permet de reprendre une tâche existante — branche
// laissée par `forge finish`, ou branche déjà poussée depuis un autre
// container, typiquement une PR ouverte.
import { join } from "node:path";
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { sanitizeContainerName, validateGitRef, validateRepo, validateTaskName } from "../validate.ts";
import { checkNameCollision, forgeRepos, isRunning } from "../containers.ts";
import { hasOriginDevice, refreshMirror } from "../mirror.ts";
import { mirrorPath, workspacesDir } from "../paths.ts";
import { attachTask } from "../session.ts";
import { execAsAgent, instanceExists, startInstance } from "../incus.ts";
import { agentBranches, branchExists, taskNames } from "../worktrees.ts";
import { provisionContainer } from "./provision.ts";

const USAGE = "Usage: forge start <owner/repo> [<task>]";

type Choice = { task: string; ref: string };

export async function cmdStart(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await startResolveRepo(ctx, repo);
  validateRepo(ownerRepo);

  const container = sanitizeContainerName(ownerRepo);
  await checkNameCollision(ctx, container, ownerRepo);

  let taskName = task ?? "";
  let ref = "";
  let justCreated = false;

  if (!(await instanceExists(ctx, container))) {
    // Un container neuf n'a ni worktree ni branche à proposer : le menu
    // n'aurait rien à montrer, on demande simplement un nom.
    if (!taskName) {
      const asked = await ctx.prompt.ask("New task name");
      if (!asked) throw new ForgeError(USAGE);
      taskName = asked;
    }
    validateTaskName(taskName);
    // Un miroir tout juste cloné est déjà à jour : pas de second fetch GitHub.
    justCreated = (await provisionContainer(ctx, container, ownerRepo)).mirror === "created";
  }

  ctx.out(`Starting container ${container}...`);
  if (!(await isRunning(ctx, container))) await mustSucceed("incus start", startInstance(ctx, container));

  // Un container provisionné avant le miroir n'a pas de device `origin` : son
  // /workspace pointe encore vers GitHub, sans credential pour l'atteindre.
  if (!(await hasOriginDevice(ctx, container))) {
    throw new ForgeError(
      `${container} predates the read-only mirror (no 'origin' device). ` +
      `Retrieve its work, then: forge delete ${ownerRepo}, move ${join(workspacesDir(), container)} aside, ` +
      `and forge start ${ownerRepo} again.`);
  }

  // Avant le menu, pas après : les branches d'origin qu'il propose doivent
  // être à jour.
  await refreshMain(ctx, container, ownerRepo, { mirror: !justCreated });

  if (!taskName) {
    const choice = await pickStartTask(ctx, container);
    taskName = choice.task;
    ref = choice.ref;
  }

  validateTaskName(taskName);
  if (ref) validateGitRef(ref);

  await addWorktree(ctx, container, taskName, ref);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return attachTask(ctx, container, taskName);
}

// Comme resolveRepo, mais avec une entrée de plus : `forge start` est la seule
// commande qui peut travailler sur un repo pas encore provisionné.
async function startResolveRepo(ctx: Context, repo?: string): Promise<string> {
  if (repo) return repo;
  const repos = await forgeRepos(ctx);
  if (repos.length === 0) {
    throw new ForgeError("no forge container yet. Name the repo: forge start <owner/repo> <task>.");
  }
  const idx = await ctx.prompt.pick("Repo", [...repos, "other repo…"]);
  if (idx === null) throw new ForgeError(USAGE);
  if (idx > repos.length) {
    const typed = await ctx.prompt.ask("owner/repo");
    if (!typed) throw new ForgeError(USAGE);
    return typed;
  }
  return repos[idx - 1];
}

// Deux sauts : GitHub -> miroir hôte (git hôte, sur le miroir de forge
// uniquement), puis miroir -> /workspace (dans le container, via son `origin`
// en lecture seule). Aucun container n'a de credential GitHub.
async function refreshMain(
  ctx: Context, container: string, ownerRepo: string, opts: { mirror: boolean },
): Promise<void> {
  if (opts.mirror) {
    ctx.out(`Refreshing the host mirror of ${ownerRepo}…`);
    // Non fatal, comme le fetch du container : hors ligne ou sans agent SSH
    // transmis, on repart des dernières refs connues du miroir.
    const mirrored = await refreshMirror(ctx, mirrorPath(container), ownerRepo);
    if (mirrored.code !== 0) {
      ctx.err(`WARNING: refreshing the mirror from GitHub failed: ${mirrored.stderr.trim() || `exit code ${mirrored.code}`}`);
      ctx.err("Continuing from the mirror's last-known refs (is your SSH agent forwarded? attach with ForwardAgent yes).");
    }
  }
  ctx.out("Refreshing main...");
  // Deux étapes distinctes, et pas un `&&` : seul le fetch conditionne le
  // point de départ des worktrees (addWorktree part d'origin/main, jamais du
  // ref local main). Les chaîner faisait accuser origin/main d'être périmé
  // alors qu'il venait d'être rafraîchi, dès que la seule avancée de main
  // échouait.
  //
  // Volontairement NON fatal, contrairement au reste des étapes mutantes : ce
  // rafraîchissement n'alimente que des entrées en lecture (le menu et le
  // point de départ origin/main). La branche supervised juste au-dessus part
  // déjà, par conception, des dernières refs connues — un opérateur hors
  // ligne doit pouvoir en faire autant plutôt que de voir `forge start`
  // refuser de démarrer. Ce qui n'est pas acceptable, c'est le silence : le
  // stderr de git est remonté tel quel, avec la conséquence énoncée.
  const fetched = await execAsAgent(ctx, container, "git -C /workspace fetch origin");
  if (fetched.code !== 0) {
    ctx.err(`WARNING: refreshing main failed: ${fetched.stderr.trim() || `exit code ${fetched.code}`}`);
    ctx.err("Continuing from the last-known origin refs — the task may branch from a stale origin/main.");
    return;
  }

  const advanced = await advanceMain(ctx, container);
  if (advanced.code !== 0) {
    ctx.err(`WARNING: fast-forwarding main in /workspace failed: ${advanced.stderr.trim() || `exit code ${advanced.code}`}`);
    ctx.err("origin refs are current, so the task still branches from an up-to-date origin/main; only /workspace's own main lags.");
  }
}

// Fait avancer le ref `main` du clone principal — jamais HEAD.
//
// `git merge --ff-only origin/main` fusionne dans la branche SORTIE dans
// /workspace. Le clone principal est censé être épinglé sur main, mais rien ne
// le garantit : retrouvé sur `agent/agent-forge` sur l'hôte réel, le refresh
// mourait sur « Not possible to fast-forward » alors que `main` était un
// ancêtre propre d'origin/main — et une branche agent/* simplement en retard
// aurait été avancée en silence, ce qu'on ne nous a jamais demandé de faire.
async function advanceMain(ctx: Context, container: string): Promise<ExecResult> {
  // Sonde : un code non nul (HEAD détaché) est une réponse, pas une panne.
  const head = await execAsAgent(ctx, container, "git -C /workspace symbolic-ref --quiet HEAD");
  if (head.stdout.trim() === "refs/heads/main") {
    // main est sorti ici : le ref et le working tree doivent bouger ensemble.
    return execAsAgent(ctx, container, "git -C /workspace merge --ff-only origin/main");
  }
  // main n'est pas sorti ici : on avance le ref seul. `fetch <src>:<dst>`
  // refuse un non-fast-forward ET refuse d'écrire dans une branche sortie dans
  // une worktree — deux garde-fous appliqués par git lui-même, sans que le
  // working tree de /workspace soit touché.
  return execAsAgent(ctx, container, "git -C /workspace fetch origin main:main");
}

// Menu mélangeant worktrees déjà là, branches agent/* sans worktree (locales
// ou seulement sur origin), plus "new task" et "other branch…".
async function pickStartTask(ctx: Context, container: string): Promise<Choice> {
  const labels: string[] = ["new task"];
  const values: string[] = ["new"];
  const seen = new Set<string>();

  for (const name of await taskNames(ctx, container)) {
    seen.add(name);
    labels.push(`${name} (existing worktree — attach)`);
    values.push(`task:${name}`);
  }
  for (const name of await agentBranches(ctx, container, "refs/heads/agent")) {
    if (seen.has(name)) continue;
    seen.add(name);
    labels.push(`${name} (local branch)`);
    values.push(`task:${name}`);
  }
  for (const name of await agentBranches(ctx, container, "refs/remotes/origin/agent")) {
    if (seen.has(name)) continue;
    seen.add(name);
    labels.push(`${name} (branch on origin)`);
    values.push(`task:${name}`);
  }
  labels.push("other branch…");
  values.push("other");

  const idx = await ctx.prompt.pick("Task", labels);
  if (idx === null) throw new ForgeError(USAGE);
  const value = values[idx - 1];

  if (value === "new") {
    const name = await ctx.prompt.ask("New task name");
    if (!name) throw new ForgeError(USAGE);
    return { task: name, ref: "" };
  }
  if (value === "other") {
    // La branche de départ peut être quelconque, mais on travaille toujours
    // sur agent/<task> : le hook pre-bash.sh n'autorise le push que là.
    const namedRef = await ctx.prompt.ask("Ref");
    if (!namedRef) throw new ForgeError(USAGE);
    const name = await ctx.prompt.ask("New task name");
    if (!name) throw new ForgeError(USAGE);
    return { task: name, ref: namedRef };
  }
  return { task: value.slice("task:".length), ref: "" };
}

async function addWorktree(ctx: Context, container: string, task: string, ref: string): Promise<void> {
  if ((await execAsAgent(ctx, container, `test -e /workspace/.trees/${task}`)).code === 0) {
    ctx.out(`Worktree .trees/${task} is already there — attaching to it.`);
    return;
  }

  if (ref) {
    if (await branchExists(ctx, container, `refs/heads/agent/${task}`)) {
      throw new ForgeError(
        `branch agent/${task} already exists; pick another task name so its history isn't overwritten.`,
      );
    }
    ctx.out(`Creating worktree .trees/${task} on a new agent/${task} from ${ref}...`);
    await mustSucceed("git worktree add",
      execAsAgent(ctx, container, `git -C /workspace worktree add .trees/${task} -b agent/${task} ${ref}`));
    return;
  }

  if (await branchExists(ctx, container, `refs/heads/agent/${task}`)) {
    ctx.out(`Resuming the existing local branch agent/${task} in .trees/${task}...`);
    await mustSucceed("git worktree add",
      execAsAgent(ctx, container, `git -C /workspace worktree add .trees/${task} agent/${task}`));
    return;
  }

  if (await branchExists(ctx, container, `refs/remotes/origin/agent/${task}`)) {
    ctx.out(`Resuming agent/${task} from origin in .trees/${task}...`);
    await mustSucceed("git worktree add", execAsAgent(ctx, container,
      `git -C /workspace worktree add .trees/${task} -b agent/${task} origin/agent/${task}`));
    return;
  }

  ctx.out(`Creating worktree .trees/${task} on a new agent/${task} from origin/main...`);
  await mustSucceed("git worktree add", execAsAgent(ctx, container,
    `git -C /workspace worktree add .trees/${task} -b agent/${task} origin/main`));
}
