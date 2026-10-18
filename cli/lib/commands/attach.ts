// forge attach <container> <task>
//
// Runs a task's agent in this terminal. This is what a herdr tab runs. The
// worktree must already exist: creating one is `forge start`'s job.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { containerRepo } from "../containers.ts";
import { attachTask, ensureRunning } from "../session.ts";
import { validateContainerName, validateTaskName } from "../validate.ts";
import { worktreeExists } from "../worktrees.ts";

export async function cmdAttach(ctx: Context, container?: string, task?: string): Promise<number> {
  if (!container || !task) throw new ForgeError("Usage: forge attach <container> <task>");
  validateContainerName(container);
  validateTaskName(task);

  const ownerRepo = await containerRepo(ctx, container);
  if (!ownerRepo) {
    throw new ForgeError(`${container} is not a forge container`);
  }
  await ensureRunning(ctx, container);

  if (!(await worktreeExists(ctx, container, task))) {
    throw new ForgeError(`no worktree .trees/${task} in ${container}. Start it with 'forge start'.`);
  }
  return attachTask(ctx, container, task, ownerRepo);
}
