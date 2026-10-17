// Pré-vol avant toute opération destructrice. Le but est de faire apparaître
// du travail *oublié*, pas d'empêcher une perte de données : le workspace est
// monté depuis l'hôte et survit de toute façon.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { execAsAgent } from "./lxd.ts";
import { containerMode } from "./containers.ts";
import { worktreeDirs } from "./worktrees.ts";

const BRANCH = /^agent\/[A-Za-z0-9._-]+$/;

export async function checkWorktree(ctx: Context, container: string, dir: string): Promise<void> {
  const dirty = await execAsAgent(ctx, container, `cd ${dir} && git status --porcelain`);
  if (dirty.stdout.trim()) {
    throw new ForgeError(
      `${container} has uncommitted changes in ${dir}:\n${dirty.stdout.trimEnd()}\n` +
      `Commit/discard them, or pass --force.`,
    );
  }

  // Un container supervised n'a aucune credential pour avoir poussé : seule la
  // vérification de propreté s'y applique.
  if ((await containerMode(ctx, container)) === "supervised") return;

  const head = await execAsAgent(ctx, container, `cd ${dir} && git rev-parse --abbrev-ref HEAD`);
  const branch = head.stdout.trim();
  if (!BRANCH.test(branch)) {
    throw new ForgeError(`unexpected branch name '${branch}' in ${dir} (${container}); refusing to proceed.`);
  }

  const ahead = await execAsAgent(ctx, container, `cd ${dir} && git log --oneline origin/main..${branch}`);
  if (!ahead.stdout.trim()) return;

  const remote = await execAsAgent(ctx, container, `cd ${dir} && git rev-parse --verify origin/${branch}`);
  if (remote.code !== 0) {
    throw new ForgeError(
      `${container}'s branch ${branch} has no origin/${branch} — it has never been pushed.\n` +
      `Push it, or pass --force.`,
    );
  }

  const unpushed = await execAsAgent(ctx, container, `cd ${dir} && git log --oneline origin/${branch}..${branch}`);
  if (unpushed.stdout.trim()) {
    throw new ForgeError(
      `${container} has unpushed commits on ${branch}:\n${unpushed.stdout.trimEnd()}\n` +
      `Push them, or pass --force.`,
    );
  }
}

// Le clone principal (/workspace, sur main) ne reçoit jamais de commit : seuls
// les worktrees .trees/* sont vérifiés.
export async function checkAllWorktrees(ctx: Context, container: string): Promise<void> {
  for (const dir of await worktreeDirs(ctx, container)) {
    await checkWorktree(ctx, container, dir);
  }
}
