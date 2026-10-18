// forge resume [<owner/repo>] [<task>]
// Rattache l'agent d'une tâche existante. Ni fetch ni rebranch —
// c'est le rôle de `forge start`.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { isRunning, requireContainerForRepo } from "../containers.ts";
import { attachTask } from "../session.ts";
import { execAsAgent, startInstance } from "../incus.ts";
import { egressAfterStart, egressBeforeStart } from "../strict.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge resume <owner/repo> <task>";

export async function cmdResume(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  // Avant le démarrage, même d'un container qui tourne déjà.
  const egress = await egressBeforeStart(ctx, container);

  ctx.out(`Starting container ${container}...`);
  if (!(await isRunning(ctx, container))) await mustSucceed("incus start", startInstance(ctx, container));

  const taskName = await resolveTask(ctx, container, task, USAGE);
  validateTaskName(taskName);

  const present = await execAsAgent(ctx, container, `test -e /workspace/.trees/${taskName}`);
  if (present.code !== 0) {
    throw new ForgeError(
      `no worktree .trees/${taskName} in ${container}. Start it with 'forge start ${ownerRepo} ${taskName}'.`,
    );
  }

  await egressAfterStart(ctx, container, egress);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return attachTask(ctx, container, taskName);
}
