// tests/claude-dist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  versionsDir, currentLink, versionDir, listVersions, currentVersion,
  installArgv, switchCurrent,
} from "../scripts/lib/claude-dist.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-claude-"));
  process.env.FORGE_CLAUDE_DIST = dir;
  return dir;
}

// Simule ce que `npm install --prefix versions/<v>` laisse derrière lui :
// le répertoire NE SUFFIT PAS, c'est node_modules/.bin/claude que le shim
// du container exec — et que switchCurrent exige désormais.
function installed(dir: string, version: string): void {
  mkdirSync(join(dir, "versions", version, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "versions", version, "node_modules", ".bin", "claude"), "#!/bin/sh\n");
}

test("the layout is versions/<v> plus a current symlink", () => {
  const dir = sandbox();
  assert.equal(versionsDir(), join(dir, "versions"));
  assert.equal(versionDir("2.0.14"), join(dir, "versions", "2.0.14"));
  assert.equal(currentLink(), join(dir, "current"));
});

test("listVersions is empty before anything is installed", () => {
  sandbox();
  assert.deepEqual(listVersions(), []);
});

test("listVersions lists directories only, sorted", () => {
  const dir = sandbox();
  installed(dir, "2.0.14");
  installed(dir, "2.0.9");
  writeFileSync(join(dir, "versions", "README"), "not a version");
  assert.deepEqual(listVersions(), ["2.0.14", "2.0.9"]);
});

test("currentVersion is null with no symlink, and the basename otherwise", () => {
  const dir = sandbox();
  assert.equal(currentVersion(), null);
  installed(dir, "2.0.14");
  symlinkSync(join("versions", "2.0.14"), join(dir, "current"));
  assert.equal(currentVersion(), "2.0.14");
});

// Régression : existsSync SUIT le lien, donc un `current` pendouillant
// (version supprimée à la main, arbre à moitié copié) se rapportait « none ».
// L'opérateur croyait à une install manquante alors que c'est le lien qui est
// cassé — et c'est ce lien qui rend `claude` inexécutable dans les containers.
test("currentVersion still names the version behind a dangling symlink", () => {
  const dir = sandbox();
  symlinkSync(join("versions", "2.0.14"), join(dir, "current"));
  assert.equal(currentVersion(), "2.0.14");
});

test("installArgv installs into the version directory, pinned", () => {
  const dir = sandbox();
  assert.deepEqual(installArgv("2.0.14"), [
    "npm", "install", "--prefix", join(dir, "versions", "2.0.14"),
    "@anthropic-ai/claude-code@2.0.14",
  ]);
});

test("switchCurrent replaces an existing symlink atomically", () => {
  const dir = sandbox();
  installed(dir, "2.0.9");
  installed(dir, "2.0.14");
  switchCurrent("2.0.9");
  assert.equal(currentVersion(), "2.0.9");
  switchCurrent("2.0.14");
  assert.equal(currentVersion(), "2.0.14");
  assert.equal(readlinkSync(join(dir, "current")), join("versions", "2.0.14"));
});

// LE bug qui rendait `claude` inexécutable partout : le lien portait le chemin
// HÔTE absolu, qui n'existe pas dans un container (l'arbre y est monté sous
// /opt/forge-claude). Relatif, il se résout des deux côtés du montage.
test("current points at versions/<v> relatively, so it resolves inside a container", () => {
  const dir = sandbox();
  installed(dir, "2.0.14");
  switchCurrent("2.0.14");
  const target = readlinkSync(join(dir, "current"));
  assert.equal(target, join("versions", "2.0.14"));
  assert.ok(!target.startsWith("/"), `cible absolue: ${target}`);
});

test("switchCurrent refuses a version that is not installed", () => {
  sandbox();
  assert.throws(() => switchCurrent("9.9.9"), /9\.9\.9/);
});

// Un `npm install` tué en route laisse le répertoire de version derrière lui,
// sans node_modules/.bin/claude. Y faire pointer `current` casserait le shim
// de TOUS les containers — la vérification porte donc sur l'exécutable.
test("switchCurrent refuses a version directory left behind by a failed install", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  assert.throws(() => switchCurrent("2.0.14"), /2\.0\.14/);
  assert.equal(currentVersion(), null);
});
