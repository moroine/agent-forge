// forge delete [<owner/repo>] [--force]
// Pré-vol WIP sauf --force ou container déjà arrêté (stop l'a déjà fait). Le
// workspace est monté depuis l'hôte et survit de toute façon — un
// re-provisioning le réutilise quand le miroir du même repo en répond, et
// réaligne son origin sur le miroir (provision.ts, workspaceIsReusable) : ce
// contrôle existe pour révéler du travail *oublié* tant que le container est
// encore là, pas pour empêcher une perte de données.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { deleteInstance, instanceStatus } from "../incus.ts";
import { mirrorPath, workspacesDir } from "../paths.ts";
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
  await mustSucceed("incus delete", deleteInstance(ctx, container));
  // Le workspace et le miroir sont hors du container : ils survivent. Un
  // container d'avant le miroir n'en a pas.
  const workspace = join(workspacesDir(), container);
  const mirror = mirrorPath(container);
  ctx.out(existsSync(mirror)
    ? `Kept ${workspace} and ${mirror}: 'forge start ${ownerRepo}' reuses them.`
    : `Kept ${workspace}: 'forge start ${ownerRepo}' reuses it.`);
  return 0;
}
