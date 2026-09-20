// forge delete [<owner/repo>] [--force]
//
// Niveau repo : toutes les tâches ET le template. Le montage hôte
// (~/workspaces/<container>) survit délibérément — il porte le clone, les
// branches et le WIP, et un re-provisioning l'adopte tel quel.
import type { Context } from "../context.ts";
import { mustSucceed, ForgeError } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { describeContainers, sameRepo, ROLE_TASK } from "../containers.ts";
import { deleteInstance } from "../lxd.ts";
import { checkAllWorktrees } from "../wip.ts";
import { acquireGitHost } from "../githost.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge delete <owner/repo> [--force]";

export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  const mine = (await describeContainers(ctx)).filter((c) => sameRepo(c, ownerRepo));
  if (mine.length === 0) throw new ForgeError(`no container for ${ownerRepo}.`);

  if (!force) {
    const host = await acquireGitHost(ctx, ownerRepo);
    try { await checkAllWorktrees(ctx, host.name); } finally { await host.release(); }
  }

  // Les tâches d'abord, le template en dernier : il est le seul git host
  // restant si une étape échoue en route.
  const tasks = mine.filter((c) => c.role === ROLE_TASK);
  const rest = mine.filter((c) => c.role !== ROLE_TASK);
  for (const c of [...tasks, ...rest]) {
    ctx.out(`Deleting container ${c.name}...`);
    await mustSucceed("lxc delete", deleteInstance(ctx, c.name));
  }
  ctx.out(`Deleted every container for ${ownerRepo}. The host workspace mount (clone, branches, WIP) survives.`);
  return 0;
}
