// forge finish [<owner/repo>] [<task>] [--force]
// Retire le worktree d'une tâche terminée. La ref agent/<task> reste dans
// .git : une branche mergée ou abandonnée peut encore être inspectée.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { containerRepo, requireContainerForRepo } from "../containers.ts";
import { herdrEnv } from "../herdr.ts";
import { closeBareTab } from "../tabs.ts";
import { execAsAgent } from "../incus.ts";
import { worktreeAbsPath } from "../worktrees.ts";
import { setTranscriptsAside, stopAgent } from "../session.ts";
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

  // On arrête l'agent avant de retirer son worktree : il y a son cwd.
  await stopAgent(ctx, container, taskName);

  ctx.out(`Removing worktree .trees/${taskName}...`);
  const flag = force ? "--force " : "";
  await mustSucceed("git worktree remove",
    execAsAgent(ctx, container, `git -C /workspace worktree remove ${flag}.trees/${taskName}`));

  // Une tâche réutilisée repart d'une conversation neuve.
  await setTranscriptsAside(ctx, container, taskName);

  // Dans herdr, l'onglet de la tâche n'a plus de raison d'être s'il est
  // retombé sur un shell nu.
  // Au mieux : le worktree est déjà retiré, un échec ici ne doit pas faire
  // échouer le finish.
  try {
    const h = herdrEnv();
    if (h) await closeBareTab(ctx, h, { container, ownerRepo: await containerRepo(ctx, container), task: taskName });
  } catch (e) {
    ctx.err(`WARNING: closing the herdr tab of ${taskName} failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  ctx.out(`Finished task ${taskName} (branch agent/${taskName} retained).`);
  return 0;
}
