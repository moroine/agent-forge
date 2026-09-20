// Domaine : la correspondance container ↔ repo, le mode, et le tampon d'image.
// Ne sait rien d'argv ni des terminaux.
import { createHash } from "node:crypto";
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import type { Instance } from "./lxd.ts";
import { configGet, imageProperty, instanceExists, instanceStatus, listInstances } from "./lxd.ts";
import { sanitizeContainerName } from "./validate.ts";

export type BuildStatus = "unknown" | "up-to-date" | "behind";

// Séparé de listForgeContainers pour que `forge list`, qui a déjà besoin des
// statuts, puisse filtrer une liste déjà chargée au lieu de relancer
// `lxc list` — la convention de nommage reste définie ici, à un seul endroit.
export function forgeContainerNames(instances: Instance[]): string[] {
  return instances.map((i) => i.name).filter((n) => n.startsWith("agent-"));
}

export async function listForgeContainers(ctx: Context): Promise<string[]> {
  return forgeContainerNames(await listInstances(ctx));
}

export function containerRepo(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.repo");
}

export function containerMode(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.mode");
}

export type ForgeContainer = {
  name: string; status: string; repo: string; mode: string; role: string; task: string;
};

export const ROLE_TEMPLATE = "template";
export const ROLE_TASK = "task";

// Le template garde le nom que portait le container de repo : la distinction
// est portée par user.forge.role, pas par une convention de nom.
export function templateContainerName(ownerRepo: string): string {
  return sanitizeContainerName(ownerRepo);
}

const MAX_INSTANCE_NAME = 63;   // limite LXD (nom d'hôte valide)
const HASH_LEN = 8;

// Tronque en gardant un suffixe de hash : deux tâches longues et proches
// doivent rester distinctes, et un nom d'instance ne peut pas finir par '-'.
export function taskContainerName(ownerRepo: string, task: string): string {
  const slug = task.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const full = `${templateContainerName(ownerRepo)}-${slug}`;
  if (full.length <= MAX_INSTANCE_NAME) return full.replace(/-+$/, "");
  const hash = createHash("sha256").update(full).digest("hex").slice(0, HASH_LEN);
  const head = full.slice(0, MAX_INSTANCE_NAME - HASH_LEN - 1).replace(/-+$/, "");
  return `${head}-${hash}`;
}

// Un seul `lxc list` pour toute la flotte, puis les clés de config par
// container. Les commandes qui bouclaient sur listForgeContainers +
// containerRepo passent toutes par ici.
export async function describeContainers(ctx: Context): Promise<ForgeContainer[]> {
  const instances = await listInstances(ctx);
  const out: ForgeContainer[] = [];
  for (const name of forgeContainerNames(instances)) {
    out.push({
      name,
      status: instances.find((i) => i.name === name)?.status ?? "Unknown",
      repo: await configGet(ctx, name, "user.forge.repo"),
      mode: await configGet(ctx, name, "user.forge.mode"),
      role: await configGet(ctx, name, "user.forge.role"),
      task: await configGet(ctx, name, "user.forge.task"),
    });
  }
  return out;
}

// Exporté : la comparaison repo est insensible à la casse PARTOUT (githost,
// list, delete, stop, token). Elle était réécrite à la main à chaque site,
// dont un — `forge list` — l'avait perdue au passage.
export const sameRepo = (c: ForgeContainer, ownerRepo: string): boolean =>
  c.repo.toLowerCase() === ownerRepo.toLowerCase();

export async function templateForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer | null> {
  const all = await describeContainers(ctx);
  return all.find((c) => c.role === ROLE_TEMPLATE && sameRepo(c, ownerRepo)) ?? null;
}

export async function requireTemplateForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer> {
  const t = await templateForRepo(ctx, ownerRepo);
  if (!t) {
    throw new ForgeError(
      `no template container for ${ownerRepo}. Run 'forge start ${ownerRepo} <task>' to provision one.`,
    );
  }
  return t;
}

export async function taskContainersForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer[]> {
  const all = await describeContainers(ctx);
  return all.filter((c) => c.role === ROLE_TASK && sameRepo(c, ownerRepo));
}

export async function containerForTask(
  ctx: Context, ownerRepo: string, task: string,
): Promise<ForgeContainer | null> {
  const tasks = await taskContainersForRepo(ctx, ownerRepo);
  return tasks.find((c) => c.task === task) ?? null;
}

export async function requireContainerForTask(
  ctx: Context, ownerRepo: string, task: string,
): Promise<ForgeContainer> {
  const c = await containerForTask(ctx, ownerRepo, task);
  if (!c) throw new ForgeError(`no container for task '${task}' in ${ownerRepo}.`);
  return c;
}

// Container forge d'avant ce modèle : aucune clé de rôle. `forge list` le
// signale au lieu de le confondre avec un template.
export function isLegacy(c: ForgeContainer): boolean {
  return c.repo !== "" && c.role === "";
}

// Ne lit que des clés de config : aucun `lxc exec`, pour rester assez rapide
// à alimenter une complétion sous TAB ou un menu interactif.
export async function forgeRepos(ctx: Context): Promise<string[]> {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const c of await describeContainers(ctx)) {
    if (!c.repo || seen.has(c.repo.toLowerCase())) continue;
    seen.add(c.repo.toLowerCase());
    repos.push(c.repo);
  }
  return repos;
}

// Échoue bruyamment si un container existe déjà sous le nom dérivé mais pour
// un *autre* repo, ou sans métadonnée forge du tout (container hérité, ou
// laissé par un provisioning interrompu avant l'enregistrement) — plutôt que
// de le réutiliser silencieusement.
export async function checkNameCollision(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  if (!(await instanceExists(ctx, container))) return;
  const existing = await containerRepo(ctx, container);
  if (!existing) {
    throw new ForgeError(
      `container ${container} already exists but has no user.forge.repo metadata (a legacy or partially-provisioned container). ` +
      `Refusing to reuse it — delete it first, or set the metadata manually: lxc config set ${container} user.forge.repo ${ownerRepo}`,
    );
  }
  if (existing.toLowerCase() !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `container ${container} already exists for a different repo (${existing}), refusing to reuse it for ${ownerRepo}.`,
    );
  }
  // Même repo, mais container du modèle d'avant (aucun user.forge.role) : le
  // nom que le template réclame est déjà pris. Sans ce garde-fou, `forge
  // start` passait ici (le repo correspond bien) pour mourir ensuite dans
  // `lxc launch` sur un « instance already exists » brut, qui ne dit rien de
  // la migration à faire.
  if (!(await configGet(ctx, container, "user.forge.role"))) {
    throw new ForgeError(
      `container ${container} is a legacy forge container for ${ownerRepo} (no user.forge.role) and already holds the name the template needs. ` +
      `Migrate it first: forge token import ${ownerRepo}, then forge delete ${ownerRepo}, then forge start again.`,
    );
  }
}

export async function isRunning(ctx: Context, name: string): Promise<boolean> {
  return (await instanceStatus(ctx, name)) === "Running";
}

// L'image de base dépend du mode : super embarque un LXD imbriqué, livré par
// une image dédiée agent-base-super (voir la spec super mode). Autonomous et
// supervised partagent agent-base.
export function baseImageFor(mode: string): string {
  return mode === "super" ? "agent-base-super" : "agent-base";
}

export function latestImageCommitFor(ctx: Context, mode: string): Promise<string> {
  return imageProperty(ctx, baseImageFor(mode), "user.forge.commit");
}

export function containerImageCommit(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.image_commit");
}

export function buildStatus(containerCommit: string, latest: string): BuildStatus {
  if (!containerCommit || !latest) return "unknown";
  return containerCommit === latest ? "up-to-date" : "behind";
}
