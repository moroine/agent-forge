// scripts/lib/claude-dist.ts
// Distribution de claude-code depuis l'hôte : des installs versionnées,
// immuables, et un symlink `current` remplacé par rename atomique.
//
// C'est ce qui rend une mise à jour sûre pendant qu'une session tourne :
// claude-code importe paresseusement, donc écraser une install en place
// peut faire disparaître un module avant qu'il soit chargé. Ici personne
// n'écrase rien — on pose une nouvelle version à côté et on bascule le lien.
// Le shim du container résout `current` UNE fois, au lancement.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ForgeError } from "./context.ts";
import { claudeDist } from "./hostpaths.ts";

export function versionsDir(): string { return join(claudeDist(), "versions"); }
export function versionDir(version: string): string { return join(versionsDir(), version); }
export function currentLink(): string { return join(claudeDist(), "current"); }

// L'exécutable que le shim du container finit par exec : c'est LUI qui doit
// exister, pas seulement le répertoire de version (cf. switchCurrent).
export function versionBin(version: string): string {
  return join(versionDir(version), "node_modules", ".bin", "claude");
}

export function listVersions(): string[] {
  if (!existsSync(versionsDir())) return [];
  return readdirSync(versionsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function currentVersion(): string | null {
  // lstat, JAMAIS existsSync : existsSync SUIT le lien, donc un `current`
  // cassé (cible absente) était rapporté « none », comme si rien n'était
  // installé. Or c'est précisément l'état qui rend `claude` inexécutable dans
  // TOUS les containers : il doit remonter jusqu'à l'opérateur, pas se
  // confondre avec une install jamais faite.
  try {
    lstatSync(currentLink());
    return readlinkSync(currentLink()).split("/").pop() ?? null;
  } catch {
    return null;
  }
}

export function installArgv(version: string): string[] {
  return ["npm", "install", "--prefix", versionDir(version), `@anthropic-ai/claude-code@${version}`];
}

export function switchCurrent(version: string): void {
  // On vérifie l'EXÉCUTABLE, pas le répertoire : un `npm install` interrompu
  // laisse un versions/<v>/ derrière lui, et y faire pointer `current`
  // casserait `claude` dans tous les containers d'un coup.
  if (!existsSync(versionBin(version))) {
    throw new ForgeError(`claude-code ${version} is not installed. Run 'forge claude update ${version}' first.`);
  }
  mkdirSync(claudeDist(), { recursive: true });
  // symlink + rename, jamais unlink + symlink : le lien ne doit à aucun
  // instant être absent, sinon un shim qui démarre pile là échouerait.
  const tmp = `${currentLink()}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  // Cible RELATIVE (versions/<v>), jamais absolue : cet arbre est monté dans
  // les containers sous /opt/forge-claude, où le chemin hôte
  // (/home/<user>/.local/share/…) n'existe pas. Un lien absolu y pend dans le
  // vide et le shim échoue sur « claude-code is not installed on the host »
  // alors que la version est parfaitement installée.
  symlinkSync(join("versions", version), tmp);
  renameSync(tmp, currentLink());
}
