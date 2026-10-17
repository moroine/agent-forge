// Résolution des arguments manquants. Le prompting vit dans la couche des
// commandes : containers.ts et worktrees.ts ne doivent rien savoir des
// terminaux.
//
// Quand on ne peut pas demander — pas de TTY, liste vide, saisie interrompue —
// on lève l'usage de l'appelant : un appel scripté obtient un message et un
// code 1, jamais un blocage sur une invite que personne ne lira.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { forgeRepos, isRunning } from "../containers.ts";
import { taskNames } from "../worktrees.ts";

export async function resolveRepo(
  ctx: Context,
  repo: string | undefined,
  usage: string,
): Promise<string> {
  if (repo) return repo;

  const repos = await forgeRepos(ctx);
  if (repos.length === 0) {
    throw new ForgeError("no forge container yet. Run 'forge start <owner/repo> <task>' first.");
  }

  const idx = await ctx.prompt.pick("Repo", repos);
  if (idx === null) throw new ForgeError(usage);
  return repos[idx - 1];
}

// Ne sert qu'aux commandes qui agissent sur une tâche *déjà là* (resume,
// finish) ; `forge start` a son propre menu, qui propose aussi de créer.
export async function resolveTask(
  ctx: Context,
  container: string,
  task: string | undefined,
  usage: string,
): Promise<string> {
  if (task) return task;

  if (!(await isRunning(ctx, container))) {
    throw new ForgeError(
      `container ${container} is stopped, so its tasks can't be listed. Name the task explicitly, or start it.`,
    );
  }

  const tasks = await taskNames(ctx, container);
  if (tasks.length === 0) {
    throw new ForgeError(`no task worktree in ${container}. Create one with 'forge start'.`);
  }

  const idx = await ctx.prompt.pick("Task", tasks);
  if (idx === null) throw new ForgeError(usage);
  return tasks[idx - 1];
}
