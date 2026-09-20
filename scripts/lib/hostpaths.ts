// scripts/lib/hostpaths.ts
// Un seul endroit où les chemins hôte sont résolus. Chaque fonction relit
// process.env à l'appel : les tests surchargent l'environnement par test, et
// une constante capturée à l'import les rendrait ininspectables.
import { join } from "node:path";

export function home(): string { return process.env.FORGE_HOME ?? "/home/moroine"; }
export function repoDir(): string { return process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge"); }
export function workspaces(): string { return process.env.FORGE_WORKSPACES ?? join(home(), "workspaces"); }

// Hors de workspaces() délibérément : tout ce qui vit sous le montage est
// lisible par l'agent via /workspace.
export function configHome(): string {
  return process.env.FORGE_CONFIG_HOME ?? join(home(), ".config", "agent-forge");
}

export function claudeDist(): string {
  return process.env.FORGE_CLAUDE_DIST ?? join(home(), ".local", "share", "agent-forge", "claude");
}
