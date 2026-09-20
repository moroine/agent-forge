// forge template rebuild [<owner/repo>]
//
// Reconstruit le template depuis l'image de base courante. Le PAT vit dans le
// store hôte (credentials.ts), donc rien n'est à recoller : c'est ce qui rend
// cette commande utilisable à chaque fois que `forge list` affiche `behind`.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireTemplateForRepo, taskContainersForRepo } from "../containers.ts";
import { deleteInstance } from "../lxd.ts";
import { readToken } from "../credentials.ts";
import { provisionTemplate } from "./provision.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge template rebuild [<owner/repo>]";

export async function cmdTemplate(ctx: Context, sub: string | undefined, repo?: string): Promise<number> {
  if (sub !== "rebuild") throw new ForgeError(USAGE);
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  const template = await requireTemplateForRepo(ctx, ownerRepo);

  // Les tâches en cours ne sont PAS touchées : elles ont déjà leur copie, et
  // les recréer perdrait leur état Docker. Elles rattraperont la nouvelle base
  // à leur prochain `forge finish` + `forge start`.
  const tasks = await taskContainersForRepo(ctx, ownerRepo);
  if (tasks.length > 0) {
    ctx.err(`Note: ${tasks.length} existing task container(s) keep the old base until they are finished and restarted.`);
  }
  if (!readToken(ownerRepo)) {
    ctx.err(`No stored token for ${ownerRepo} — provisioning will ask for one and store it.`);
  }

  ctx.out(`Deleting the old template ${template.name}...`);
  await mustSucceed("lxc delete", deleteInstance(ctx, template.name));

  // Si provisionTemplate échoue ici (réseau, token refusé, image de base
  // absente), le repo se retrouve sans template jusqu'au prochain essai — on
  // l'accepte : puisque le PAT vit désormais sur l'hôte, "réessayer" est
  // exactement `forge template rebuild` à nouveau, sans rien à recoller. Un
  // aller-retour delete/provision plus prudent (garder l'ancien tant que le
  // nouveau n'est pas prêt) ajouterait de la complexité pour un échec que
  // l'opérateur corrige en relançant la même commande.
  await provisionTemplate(ctx, ownerRepo);
  ctx.out(`Template for ${ownerRepo} rebuilt.`);
  return 0;
}
