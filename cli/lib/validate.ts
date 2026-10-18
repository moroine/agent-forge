// Ces jeux de caractères sont une frontière de sécurité, pas une politesse :
// les valeurs sont interpolées dans une chaîne `su -c "…"` exécutée dans le
// container. Voir §7 de la spec.
import { ForgeError } from "./context.ts";

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TASK = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;

export function validateRepo(ownerRepo: string): void {
  if (!REPO.test(ownerRepo)) {
    throw new ForgeError(`repo must be <owner>/<repo>, got: ${ownerRepo}`);
  }
}

export function validateTaskName(name: string): void {
  if (!TASK.test(name)) {
    throw new ForgeError(`task-name must only contain [A-Za-z0-9._-], got: ${name}`);
  }
}

// Le tiret initial est exclu à part : une ref commençant par "-" serait prise
// par git pour une option.
export function validateGitRef(ref: string): void {
  if (!REF.test(ref) || ref.startsWith("-")) {
    throw new ForgeError(`ref must only contain [A-Za-z0-9._/-] and must not start with '-', got: ${ref}`);
  }
}

// Nom de container déterministe : minuscules, puis toute suite de caractères
// hors [a-z0-9-] réduite à un seul "-".
export function sanitizeContainerName(ownerRepo: string): string {
  return `agent-${ownerRepo.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

// Nom de container tel que `forge upload-pack` le reçoit d'un client SSH :
// valeur non fiable, validée avant tout appel.
export function validateContainerName(name: string): void {
  if (!/^agent-[a-z0-9-]+$/.test(name)) {
    throw new ForgeError(`container must be agent-<name> with [a-z0-9-], got: ${name}`);
  }
}
