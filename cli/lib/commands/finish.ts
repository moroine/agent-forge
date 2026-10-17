// forge finish [<owner/repo>] [<task>] [--force]
// Retire le worktree d'une tâche terminée. La ref agent/<task> reste dans
// .git : une branche mergée ou abandonnée peut encore être inspectée.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { execAsAgent } from "../lxd.ts";
import { worktreeAbsPath } from "../worktrees.ts";
import { checkWorktree } from "../wip.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge finish <owner/repo> <task> [--force]";

export async function cmdFinish(
  ctx: Context,
  repo: string | undefined,
  task: string | undefined,
  force: boolean,
): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  const taskName = await resolveTask(ctx, container, task, USAGE);
  validateTaskName(taskName);

  const dir = worktreeAbsPath(taskName);
  if ((await execAsAgent(ctx, container, `test -e ${dir}`)).code !== 0) {
    throw new ForgeError(`no worktree .trees/${taskName} in ${container}.`);
  }

  if (!force) await checkWorktree(ctx, container, dir);

  ctx.out(`Removing worktree .trees/${taskName}...`);
  const flag = force ? "--force " : "";
  await mustSucceed("git worktree remove",
    execAsAgent(ctx, container, `git -C /workspace worktree remove ${flag}.trees/${taskName}`));

  // Au mieux : on démonte la session si elle traîne encore.
  await execAsAgent(ctx, container, `tmux kill-session -t ${taskName} 2>/dev/null || true`);

  ctx.out(`Finished task ${taskName} (branch agent/${taskName} retained).`);
  return 0;
}
