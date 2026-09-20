// forge start [<owner/repo>] [<task>]
//
// La branche de la tâche est *résolue* au lieu de partir systématiquement de
// origin/main : c'est ce qui permet de reprendre une tâche existante — branche
// laissée par `forge finish`, ou branche déjà poussée depuis un autre
// container, typiquement une PR ouverte.
//
// Le container d'une tâche n'est jamais provisionné de zéro : il est copié
// depuis le TEMPLATE du repo (voir §1 de la spec container-per-task), lui-même
// provisionné une seule fois puis toujours stoppé. `lxc copy` sur une source
// stoppée est la seule façon d'obtenir une copie cohérente.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateGitRef, validateRepo, validateTaskName } from "../validate.ts";
import {
  baseImageFor, buildStatus, checkNameCollision, containerForTask, containerImageCommit,
  isRunning, latestImageCommitFor, ROLE_TASK, taskContainerName, taskContainersForRepo,
  templateContainerName, templateForRepo, forgeRepos,
} from "../containers.ts";
import type { ForgeContainer } from "../containers.ts";
import { attachArgv, copyInstance, execAsAgent, startInstance, stopInstance } from "../lxd.ts";
import { agentBranches, branchExists } from "../worktrees.ts";
import { provisionTemplate } from "./provision.ts";

const USAGE = "Usage: forge start <owner/repo> [<task>]";

type Choice = { task: string; ref: string };

export async function cmdStart(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await startResolveRepo(ctx, repo);
  validateRepo(ownerRepo);

  let template = await templateForRepo(ctx, ownerRepo);

  let taskName = task ?? "";
  let ref = "";
  if (!taskName) {
    if (!template) {
      const asked = await ctx.prompt.ask("New task name");
      if (!asked) throw new ForgeError(USAGE);
      taskName = asked;
    } else {
      const choice = await pickStartTask(ctx, ownerRepo, template);
      taskName = choice.task;
      ref = choice.ref;
    }
  }
  validateTaskName(taskName);
  if (ref) validateGitRef(ref);

  if (!template) {
    await checkNameCollision(ctx, templateContainerName(ownerRepo), ownerRepo);
    template = await provisionTemplate(ctx, ownerRepo);
  } else {
    await warnIfTemplateBehind(ctx, template);
  }

  const container = await ensureTaskContainer(ctx, ownerRepo, taskName, template);

  await refreshMain(ctx, container, template.mode);
  await addWorktree(ctx, container, taskName, ref);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container, taskName, process.env.TERM ?? "xterm-256color"));
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

// Copie le template si la tâche n'a pas encore de container ; sinon réutilise
// celui qui est là. Le template est stoppé par construction (provision.ts), ce
// qui rend la copie cohérente — c'est la raison d'être du template.
async function ensureTaskContainer(
  ctx: Context, ownerRepo: string, task: string, template: ForgeContainer,
): Promise<string> {
  const existing = await containerForTask(ctx, ownerRepo, task);
  if (existing) {
    if (existing.status !== "Running") {
      ctx.out(`Starting container ${existing.name}...`);
      await mustSucceed("lxc start", startInstance(ctx, existing.name));
    }
    return existing.name;
  }

  const name = taskContainerName(ownerRepo, task);
  // Garde-fou : un nom de tâche fait uniquement de séparateurs ("---", "...")
  // est légal pour validate.ts mais s'effondre, une fois slugifié et débarrassé
  // de ses tirets de fin, sur le nom du template lui-même. checkNameCollision
  // laisserait passer (le repo correspond bien), et `lxc copy X X` échouerait
  // avec un message qui ne dit rien de la vraie cause.
  if (name === template.name) {
    throw new ForgeError(
      `task name '${task}' sanitizes to the template container's own name (${template.name}); pick another task name.`,
    );
  }
  // Le template DOIT être arrêté au moment de la copie : `lxc copy` ne refuse
  // pas une instance démarrée, il en copie un rootfs en cours d'écriture — la
  // corruption même que le template existe pour éviter. Le statut qu'on tient
  // vient d'un `describeContainers` antérieur et peut être périmé : on le
  // relit ici. Arrêter est sans risque, un template n'héberge jamais de
  // travail ; et si un `acquireGitHost` concurrent s'en servait vraiment, sa
  // commande échoue bruyamment, ce qui vaut mieux qu'une copie corrompue en
  // silence.
  if (await isRunning(ctx, template.name)) {
    ctx.out(`Template ${template.name} is running — stopping it so the copy is consistent...`);
    await mustSucceed("lxc stop", stopInstance(ctx, template.name));
  }
  await checkNameCollision(ctx, name, ownerRepo);
  ctx.out(`Copying ${template.name} into ${name}...`);
  // Les deux clés sont posées PAR la copie, pas par des `lxc config set` qui
  // suivraient : la copie hérite de user.forge.role=template de la source, et
  // une interruption dans cette fenêtre laissait un container de tâche se
  // déclarant template — invisible de `forge list` (pas une ligne de tâche) et
  // de `forge finish` (containerForTask exige role=task), effaçable seulement
  // par un `forge delete` du repo entier.
  await mustSucceed("lxc copy", copyInstance(ctx, template.name, name, {
    "user.forge.role": ROLE_TASK,
    "user.forge.task": task,
  }));
  ctx.out(`Starting container ${name}...`);
  await mustSucceed("lxc start", startInstance(ctx, name));
  return name;
}

// Non bloquant, comme le flag `behind` de `forge list` : l'outil expose, et
// l'opérateur décide quand reconstruire.
async function warnIfTemplateBehind(ctx: Context, template: ForgeContainer): Promise<void> {
  const stamp = await containerImageCommit(ctx, template.name);
  const latest = await latestImageCommitFor(ctx, template.mode);
  if (buildStatus(stamp, latest) !== "behind") return;
  ctx.err(`WARNING: template ${template.name} is behind ${baseImageFor(template.mode)} (@${stamp} vs @${latest}).`);
  ctx.err(`Refresh it when convenient: forge template rebuild ${template.repo}`);
}

// Un container supervised n'a aucune credential pour joindre origin : on reste
// sur les refs déjà connues localement.
async function refreshMain(ctx: Context, container: string, mode: string): Promise<void> {
  if (mode === "supervised") {
    ctx.err("Supervised container: skipping origin fetch (no credential); working from the last-known origin refs.");
    return;
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

// Menu mélangeant les containers de tâche déjà provisionnés (une entrée par
// container, quel que soit son statut) et, seulement si le template tourne
// (les probes git ci-dessous ont besoin d'un /workspace vivant pour
// répondre), les branches agent/* qui n'ont pas encore de container — locales
// ou seulement sur origin —, plus "new task" et "other branch…".
async function pickStartTask(ctx: Context, ownerRepo: string, template: ForgeContainer): Promise<Choice> {
  const labels: string[] = ["new task"];
  const values: string[] = ["new"];
  const seen = new Set<string>();

  for (const c of await taskContainersForRepo(ctx, ownerRepo)) {
    seen.add(c.task);
    labels.push(`${c.task} (existing container — attach)`);
    values.push(`task:${c.task}`);
  }

  if (template.status === "Running") {
    for (const name of await agentBranches(ctx, template.name, "refs/heads/agent")) {
      if (seen.has(name)) continue;
      seen.add(name);
      labels.push(`${name} (local branch)`);
      values.push(`task:${name}`);
    }
    for (const name of await agentBranches(ctx, template.name, "refs/remotes/origin/agent")) {
      if (seen.has(name)) continue;
      seen.add(name);
      labels.push(`${name} (branch on origin)`);
      values.push(`task:${name}`);
    }
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
