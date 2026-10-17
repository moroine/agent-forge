// Domaine : la correspondance container ↔ repo, le mode, et le tampon d'image.
// Ne sait rien d'argv ni des terminaux.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import type { Instance } from "./incus.ts";
import { configGet, forgeProject, imageProperty, instanceExists, instanceStatus, listInstances } from "./incus.ts";

export type BuildStatus = "unknown" | "up-to-date" | "behind";

// Séparé de listForgeContainers pour que `forge list`, qui a déjà besoin des
// statuts, puisse filtrer une liste déjà chargée au lieu de relancer
// `incus list` — la convention de nommage reste définie ici, à un seul endroit.
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

// Ne lit que des clés de config : aucun `incus exec`, pour rester assez rapide
// à alimenter une complétion sous TAB ou un menu interactif.
export async function forgeRepos(ctx: Context): Promise<string[]> {
  const repos: string[] = [];
  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    if (repo) repos.push(repo);
  }
  return repos;
}

export async function containerForRepo(ctx: Context, ownerRepo: string): Promise<string | null> {
  const wanted = ownerRepo.toLowerCase();
  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    if (repo.toLowerCase() === wanted) return name;
  }
  return null;
}

export async function requireContainerForRepo(ctx: Context, ownerRepo: string): Promise<string> {
  const container = await containerForRepo(ctx, ownerRepo);
  if (!container) {
    throw new ForgeError(`no container found for ${ownerRepo}. Run 'forge start ${ownerRepo}' first.`);
  }
  return container;
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
      `Refusing to reuse it — delete it first, or set the metadata manually: incus --project ${forgeProject()} config set ${container} user.forge.repo ${ownerRepo}`,
    );
  }
  if (existing.toLowerCase() !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `container ${container} already exists for a different repo (${existing}), refusing to reuse it for ${ownerRepo}.`,
    );
  }
}

export async function isRunning(ctx: Context, name: string): Promise<boolean> {
  return (await instanceStatus(ctx, name)) === "Running";
}

// L'image de base unique : construite par `forge image build`.
export const BASE_IMAGE = "agent-base";

export function containerImageCommit(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.image_commit");
}

export function buildStatus(containerCommit: string, latest: string): BuildStatus {
  if (!containerCommit || !latest) return "unknown";
  return containerCommit === latest ? "up-to-date" : "behind";
}

export function latestImageCommit(ctx: Context): Promise<string> {
  return imageProperty(ctx, BASE_IMAGE, "user.forge.commit");
}
