// forge finish [<owner/repo>] [<task>] [--force]
// Retire le worktree d'une tâche terminée. La ref agent/<task> reste dans
// .git : une branche mergée ou abandonnée peut encore être inspectée.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { containerForTask } from "../containers.ts";
import { acquireGitHost } from "../githost.ts";
import { deleteInstance, execAsAgent } from "../lxd.ts";
import { worktreeAbsPath } from "../worktrees.ts";
import { checkWorktree } from "../wip.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge finish <owner/repo> <task> [--force]";

export async function cmdFinish(
  ctx: Context, repo: string | undefined, task: string | undefined, force: boolean,
): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const taskName = await resolveTask(ctx, ownerRepo, task, USAGE);
  validateTaskName(taskName);

  const container = await containerForTask(ctx, ownerRepo, taskName);
  const host = await acquireGitHost(ctx, ownerRepo, container?.name);
  try {
    const dir = worktreeAbsPath(taskName);
    if ((await execAsAgent(ctx, host.name, `test -e ${dir}`)).code !== 0 && !container) {
      throw new ForgeError(`no worktree .trees/${taskName} and no container for task '${taskName}' in ${ownerRepo}.`);
    }

    // checkWorktree lit le mode du container qu'on lui passe. Ici c'est le git
    // host, qui peut être le template plutôt que le container de la tâche — et
    // c'est correct : toute tâche est une copie du template, donc porte le même
    // user.forge.mode. Si ça cessait d'être vrai, ce contrôle mentirait.
    if (!force) await checkWorktree(ctx, host.name, dir);

    if (container && container.status === "Running") {
      await execAsAgent(ctx, container.name, `tmux kill-session -t ${taskName} 2>/dev/null || true`);
    }

    ctx.out(`Removing worktree .trees/${taskName}...`);
    const flag = force ? "--force " : "";
    await mustSucceed("git worktree remove", execAsAgent(ctx, host.name,
      `git -C /workspace worktree remove ${flag}.trees/${taskName}`));
  } finally {
    await host.release();
  }

  // Après la worktree, jamais avant : supprimer le container d'abord
  // laisserait .git/worktrees/<task> orpheline dans le montage partagé.
  if (container) {
    ctx.out(`Deleting container ${container.name}...`);
    await mustSucceed("lxc delete", deleteInstance(ctx, container.name));
  }

  ctx.out(`Finished task ${taskName} (branch agent/${taskName} retained).`);
  return 0;
}
