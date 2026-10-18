// forge resume [<owner/repo>] [<task>]
// Rattache l'agent d'une tâche existante. Ni fetch ni rebranch —
// c'est le rôle de `forge start`.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { ensureRunning } from "../session.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { containerRepo, requireContainerForRepo } from "../containers.ts";
import { herdrEnv } from "../herdr.ts";
import { resumeAll, runTask } from "../tabs.ts";
import { worktreeExists } from "../worktrees.ts";
import { egressAfterStart, egressBeforeStart } from "../strict.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge resume <owner/repo> <task>\n       forge resume --all";

export async function cmdResume(
  ctx: Context, repo?: string, task?: string, all = false,
): Promise<number> {
  if (all) {
    if (repo || task) throw new ForgeError(USAGE);
    const h = herdrEnv();
    if (!h) throw new ForgeError("resume --all only works inside herdr (prefix+shift+f).");
    return resumeAll(ctx, h);
  }
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  // Avant le démarrage, même d'un container qui tourne déjà.
  const egress = await egressBeforeStart(ctx, container);

  ctx.out(`Starting container ${container}...`);
  await ensureRunning(ctx, container);

  const taskName = await resolveTask(ctx, container, task, USAGE);
  validateTaskName(taskName);

  if (!(await worktreeExists(ctx, container, taskName))) {
    throw new ForgeError(
      `no worktree .trees/${taskName} in ${container}. Start it with 'forge start ${ownerRepo} ${taskName}'.`,
    );
  }

  await egressAfterStart(ctx, container, egress);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return runTask(ctx, { container, ownerRepo: await containerRepo(ctx, container), task: taskName });
}
