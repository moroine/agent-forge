// « Quel container peut faire tourner git pour ce repo ? »
//
// Le montage est partagé : il n'y a qu'un .git, visible depuis le template
// comme depuis n'importe quelle tâche. C'est ce qui permet à `finish` de
// retirer la worktree d'une tâche dont le container est éteint — sans quoi
// chaque nettoyage laisserait une entrée .git/worktrees/<task> orpheline.
//
// On préfère toujours un container DÉJÀ démarré : réveiller le template pour
// une commande git est le dernier recours, et on le rendort ensuite.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { describeContainers, ROLE_TASK, ROLE_TEMPLATE } from "./containers.ts";
import { startInstance, stopInstance } from "./lxd.ts";

export type GitHost = { name: string; release(): Promise<void> };

const noop = async (): Promise<void> => {};

export async function acquireGitHost(
  ctx: Context, ownerRepo: string, preferred?: string,
): Promise<GitHost> {
  const mine = (await describeContainers(ctx))
    .filter((c) => c.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (mine.length === 0) throw new ForgeError(`no container for ${ownerRepo} to run git in.`);

  const running = mine.filter((c) => c.status === "Running");
  const pick = running.find((c) => c.name === preferred)
    ?? running.find((c) => c.role === ROLE_TASK)
    ?? running.find((c) => c.role === ROLE_TEMPLATE);
  if (pick) return { name: pick.name, release: noop };

  const template = mine.find((c) => c.role === ROLE_TEMPLATE);
  if (!template) throw new ForgeError(`no running container and no template for ${ownerRepo}.`);

  await mustSucceed("lxc start", startInstance(ctx, template.name));
  return {
    name: template.name,
    release: async () => { await stopInstance(ctx, template.name); },
  };
}
