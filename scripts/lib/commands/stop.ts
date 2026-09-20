// forge stop [<owner/repo>] [<task>]
//
// `stop` n'est plus « couper le repo » mais « mettre cette tâche en pause ».
// Aucun pré-vol WIP : tout ce qu'il pourrait mettre en danger (code, commits,
// WIP, node_modules) vit dans le montage hôte et survit. Ajouter une friction
// ici découragerait précisément le geste qui libère RAM, CPU et Docker.
import type { Context } from "../context.ts";
import { mustSucceed } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { describeContainers, requireContainerForTask, sameRepo } from "../containers.ts";
import { stopInstance } from "../lxd.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge stop [<owner/repo>] [<task>]";

export async function cmdStop(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  if (task) {
    validateTaskName(task);
    const container = await requireContainerForTask(ctx, ownerRepo, task);
    if (container.status !== "Running") {
      ctx.out(`Task ${task} is already stopped.`);
      return 0;
    }
    ctx.out(`Stopping container ${container.name}...`);
    await mustSucceed("lxc stop", stopInstance(ctx, container.name));
    return 0;
  }

  const running = (await describeContainers(ctx))
    .filter((c) => sameRepo(c, ownerRepo) && c.status === "Running");
  if (running.length === 0) {
    ctx.out(`Nothing running for ${ownerRepo}.`);
    return 0;
  }
  for (const c of running) {
    ctx.out(`Stopping container ${c.name}...`);
    await mustSucceed("lxc stop", stopInstance(ctx, c.name));
  }
  return 0;
}
