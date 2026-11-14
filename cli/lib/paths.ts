// Host paths forge reads or writes. Each one can be overridden by an
// environment variable so that tests never touch a real home; none has a
// personal default.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function forgeHome(): string {
  return process.env.FORGE_HOME ?? homedir();
}

// La commande que herdr tape dans un onglet : le chemin par lequel l'utilisateur
// a lancé forge (exporté par le shim), rendu absolu mais pas résolu — un lien
// symbolique reste stable d'une release à l'autre. `forge` quand il est absent.
export function forgeCommand(): string {
  return process.env.FORGE_INVOKED_AS ? resolve(process.env.FORGE_INVOKED_AS) : "forge";
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
  return join(configDir(), "config.json");
}

// The egress allowlist sits next to the config.
export function allowlistPath(): string {
  return join(configDir(), "egress-allowlist");
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(forgeHome(), ".config");
  return join(base, "agent-forge");
}

// La config herdr de l'utilisateur forge : HERDR_CONFIG_PATH, sinon
// $XDG_CONFIG_HOME/herdr/config.toml (herdr 0.9.5 honore XDG_CONFIG_HOME),
// sinon <home forge>/.config/herdr/config.toml. Une valeur vide compte comme absente.
// Seul `forge setup` la lit encore, pour retirer les raccourcis d'avant les équipes.
export function herdrConfigPath(): string {
  return process.env.HERDR_CONFIG_PATH ||
    join(process.env.XDG_CONFIG_HOME || join(forgeHome(), ".config"), "herdr", "config.toml");
}

// The laptop-side record of installed hosts lives next to the config.
export function laptopStateDir(): string {
  return configDir();
}

export function laptopDataDir(): string {
  return dataDir();
}

// The directory forge keeps its own SSH files in on the laptop (FORGE_SSH_DIR
// is for tests), and Lima's home (LIMA_HOME is Lima's own variable).
export function sshDir(): string {
  return process.env.FORGE_SSH_DIR ?? join(forgeHome(), ".ssh");
}

export function limaHome(): string {
  return process.env.LIMA_HOME ?? join(forgeHome(), ".lima");
}

// Données de forge (miroirs git). Un XDG_DATA_HOME vide compte comme absent.
function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(forgeHome(), ".local", "share");
  return join(base, "agent-forge");
}

// Le journal de l'API entre containers y vit (DX 5, §5.4).
export function apiDataDir(): string {
  return join(dataDir(), "api");
}

// Les sockets de l'API sur l'hôte : un chemin court (une socket Unix tient en
// 107 octets), dans un dossier que seul l'utilisateur forge peut lire.
// FORGE_API_RUNTIME ne sert qu'aux tests.
export function apiRuntimeDir(): string {
  return process.env.FORGE_API_RUNTIME ?? `/run/user/${process.getuid!()}/forge-api`;
}

// FORGE_MIRRORS ne sert qu'aux tests.
export function mirrorsDir(): string {
  return process.env.FORGE_MIRRORS ?? join(dataDir(), "mirrors");
}

export function mirrorPath(container: string): string {
  return join(mirrorsDir(), `${container}.git`);
}
