// scripts/lib/credentials.ts
// Store hôte des PAT GitHub, un fichier par repo.
//
// La spec du 2026-07-17 gardait le token hors du disque hôte. Sur une machine
// dédiée, cette précaution ne défend contre rien : qui tient l'hôte fait
// `lxc exec` en root dans n'importe quel container et y lit déjà le token.
// La règle qui compte est l'emplacement : JAMAIS sous FORGE_WORKSPACES, dont
// tout le contenu est lisible par l'agent via /workspace.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./hostpaths.ts";

function credentialsDir(): string { return join(configHome(), "credentials"); }

export function credentialPath(ownerRepo: string): string {
  return join(credentialsDir(), ownerRepo.toLowerCase().replace(/\//g, "-"));
}

export function readToken(ownerRepo: string): string | null {
  const file = credentialPath(ownerRepo);
  if (!existsSync(file)) return null;
  const token = readFileSync(file, "utf8").trim();
  return token === "" ? null : token;
}

export function writeToken(ownerRepo: string, token: string): void {
  mkdirSync(credentialsDir(), { recursive: true, mode: 0o700 });
  // mkdirSync n'applique `mode` qu'à la création : un répertoire préexistant
  // trop ouvert resterait tel quel.
  chmodSync(credentialsDir(), 0o700);
  const file = credentialPath(ownerRepo);
  writeFileSync(file, token.trim(), { mode: 0o600 });
  // Même piège que pour le répertoire : `mode` de writeFileSync est ignoré si
  // le fichier existe déjà, donc un écrasement garderait les permissions de
  // l'ancien fichier sans ce chmod explicite.
  chmodSync(file, 0o600);
}

export function removeToken(ownerRepo: string): boolean {
  const file = credentialPath(ownerRepo);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
