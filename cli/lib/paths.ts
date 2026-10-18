// Host paths forge reads or writes. Each one can be overridden by an
// environment variable so that tests never touch a real home; none has a
// personal default.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function forgeHome(): string {
  return process.env.FORGE_HOME ?? homedir();
}

// cli/lib/paths.ts → the repository (or release) root is two levels up. The
// shim resolves symlinks first, so an installed /usr/local/bin/forge lands on
// the release directory, where COMMIT lives.
export function repoRoot(): string {
  return process.env.FORGE_REPO_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function workspacesDir(): string {
  return process.env.FORGE_WORKSPACES ?? join(forgeHome(), "workspaces");
}

// An empty XDG_CONFIG_HOME counts as unset, as the XDG spec says.
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(forgeHome(), ".config");
  return join(base, "agent-forge", "config.json");
}

// Données de forge (miroirs git). Un XDG_DATA_HOME vide compte comme absent.
function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(forgeHome(), ".local", "share");
  return join(base, "agent-forge");
}

// FORGE_MIRRORS ne sert qu'aux tests.
export function mirrorsDir(): string {
  return process.env.FORGE_MIRRORS ?? join(dataDir(), "mirrors");
}

export function mirrorPath(container: string): string {
  return join(mirrorsDir(), `${container}.git`);
}
