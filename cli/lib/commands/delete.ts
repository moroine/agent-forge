// forge delete [<owner/repo>] [--force]
// Pré-vol WIP sauf --force ou container déjà arrêté (stop l'a déjà fait). Le
// workspace est monté depuis l'hôte et survit de toute façon — un
// re-provisioning l'adopte tel quel au lieu de recloner par-dessus
// (provision.ts, workspaceIsReusable) : ce contrôle existe pour révéler du
// travail *oublié* tant que le container est encore là, pas pour empêcher une
// perte de données.
import type { Context } from "../context.ts";
import { mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { deleteInstance, instanceStatus } from "../lxd.ts";
import { checkAllWorktrees } from "../wip.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge delete <owner/repo> [--force]";

export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  if (!force && (await instanceStatus(ctx, container)) === "Running") {
    await checkAllWorktrees(ctx, container);
  }

  ctx.out(`Deleting container ${container}...`);
  await mustSucceed("lxc delete", deleteInstance(ctx, container));
  return 0;
}
