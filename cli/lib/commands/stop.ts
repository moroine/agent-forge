// forge stop [<owner/repo>] [--force]
// Pré-vol WIP (arbre sale / commits non poussés) sauf --force.
import type { Context } from "../context.ts";
import { mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { stopInstance } from "../incus.ts";
import { checkAllWorktrees } from "../wip.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge stop <owner/repo> [--force]";

export async function cmdStop(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  if (!force) await checkAllWorktrees(ctx, container);

  ctx.out(`Stopping container ${container}...`);
  await mustSucceed("incus stop", stopInstance(ctx, container));
  return 0;
}
