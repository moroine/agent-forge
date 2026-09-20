// scripts/lib/claude-dist.ts
// Distribution de claude-code depuis l'hôte : des installs versionnées,
// immuables, et un symlink `current` remplacé par rename atomique.
//
// C'est ce qui rend une mise à jour sûre pendant qu'une session tourne :
// claude-code importe paresseusement, donc écraser une install en place
// peut faire disparaître un module avant qu'il soit chargé. Ici personne
// n'écrase rien — on pose une nouvelle version à côté et on bascule le lien.
// Le shim du container résout `current` UNE fois, au lancement.
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ForgeError } from "./context.ts";
import { claudeDist } from "./hostpaths.ts";

export function versionsDir(): string { return join(claudeDist(), "versions"); }
export function versionDir(version: string): string { return join(versionsDir(), version); }
export function currentLink(): string { return join(claudeDist(), "current"); }

export function listVersions(): string[] {
  if (!existsSync(versionsDir())) return [];
  return readdirSync(versionsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function currentVersion(): string | null {
  if (!existsSync(currentLink())) return null;
  return readlinkSync(currentLink()).split("/").pop() ?? null;
}

export function installArgv(version: string): string[] {
  return ["npm", "install", "--prefix", versionDir(version), `@anthropic-ai/claude-code@${version}`];
}

export function switchCurrent(version: string): void {
  if (!existsSync(versionDir(version))) {
    throw new ForgeError(`claude-code ${version} is not installed. Run 'forge claude update ${version}' first.`);
  }
  mkdirSync(claudeDist(), { recursive: true });
  // symlink + rename, jamais unlink + symlink : le lien ne doit à aucun
  // instant être absent, sinon un shim qui démarre pile là échouerait.
  const tmp = `${currentLink()}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(versionDir(version), tmp);
  renameSync(tmp, currentLink());
}
