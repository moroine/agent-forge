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
import { describeContainers, isLegacy, sameRepo, ROLE_TASK, ROLE_TEMPLATE } from "./containers.ts";
import { startInstance, stopInstance } from "./lxd.ts";

export type GitHost = { name: string; release(): Promise<void> };

const noop = async (): Promise<void> => {};

export async function acquireGitHost(
  ctx: Context, ownerRepo: string, preferred?: string,
): Promise<GitHost> {
  const mine = (await describeContainers(ctx)).filter((c) => sameRepo(c, ownerRepo));
  if (mine.length === 0) throw new ForgeError(`no container for ${ownerRepo} to run git in.`);

  // Le dernier `?? running[0]` rattrape les containers HÉRITÉS (user.forge.repo
  // sans user.forge.role) : ils montent le même /workspace, donc ils font
  // tourner git pour ce repo aussi bien qu'un autre. Sans lui, `forge delete`
  // — la commande même que README et `forge list` prescrivent pour migrer un
  // container hérité — échouait sur son pré-vol WIP avec « no running
  // container and no template », les deux commandes se contredisant.
  const running = mine.filter((c) => c.status === "Running");
  const pick = running.find((c) => c.name === preferred)
    ?? running.find((c) => c.role === ROLE_TASK)
    ?? running.find((c) => c.role === ROLE_TEMPLATE)
    ?? running[0];
  if (pick) return { name: pick.name, release: noop };

  // Rien ne tourne : on réveille le template, ou à défaut un container hérité
  // (un repo pas encore migré n'a pas de template du tout).
  const woken = mine.find((c) => c.role === ROLE_TEMPLATE) ?? mine.find(isLegacy);
  if (!woken) throw new ForgeError(`no running container and no template for ${ownerRepo}.`);

  await mustSucceed("lxc start", startInstance(ctx, woken.name));
  return {
    name: woken.name,
    release: async () => {
      // Volontairement NON fatal : on est dans le chemin de libération, où
      // lever masquerait l'erreur déjà en vol. Mais le silence n'est pas
      // acceptable — un container réveillé pour git puis resté allumé doit se
      // voir, et c'est `forge start` qui en paierait le prix (il devra
      // l'arrêter avant de copier). Même compromis que le `finally` de
      // token.ts.
      const stopped = await stopInstance(ctx, woken.name);
      if (stopped.code !== 0) {
        ctx.err(`WARNING: could not stop ${woken.name} again: ${stopped.stderr.trim() || `exit code ${stopped.code}`}`);
        ctx.err("It was started only to run git for this repo — stop it by hand with 'lxc stop'.");
      }
    },
  };
}
