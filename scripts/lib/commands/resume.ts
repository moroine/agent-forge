// forge resume [<owner/repo>] [<task>]
// Rattache la session tmux du container d'une tâche déjà provisionnée. Ni
// fetch ni rebranch, ni création — c'est le rôle de `forge start`.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { containerForTask } from "../containers.ts";
import { attachArgv, startInstance } from "../lxd.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge resume <owner/repo> <task>";

export async function cmdResume(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const taskName = await resolveTask(ctx, ownerRepo, task, USAGE);
  validateTaskName(taskName);

  // Chaque tâche a désormais son propre container : contrairement à `start`,
  // `resume` n'en crée jamais — il pointe vers la commande qui le ferait.
  const container = await containerForTask(ctx, ownerRepo, taskName);
  if (!container) {
    throw new ForgeError(
      `no container for task '${taskName}' in ${ownerRepo}. Start it with 'forge start ${ownerRepo} ${taskName}'.`,
    );
  }
  if (container.status !== "Running") {
    ctx.out(`Starting container ${container.name}...`);
    await mustSucceed("lxc start", startInstance(ctx, container.name));
  }

  ctx.out(`Attaching to ${container.name} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container.name, taskName, process.env.TERM ?? "xterm-256color"));
}
