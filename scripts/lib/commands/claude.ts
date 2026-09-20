// scripts/lib/commands/claude.ts
// forge claude update [<version>] | list
import { mkdirSync } from "node:fs";
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { currentVersion, installArgv, listVersions, switchCurrent, versionDir } from "../claude-dist.ts";

const USAGE = "Usage: forge claude update [<version>] | list";
const PACKAGE = "@anthropic-ai/claude-code";
const VERSION = /^[0-9][0-9A-Za-z.\-+]*$/;

export async function cmdClaude(ctx: Context, sub: string | undefined, version?: string): Promise<number> {
  if (sub === "list") {
    const current = currentVersion();
    const versions = listVersions();
    ctx.out(`current: ${current ?? "none"}`);
    if (versions.length === 0) ctx.out("no version installed — run 'forge claude update'");
    for (const v of versions) ctx.out(`  ${v}${v === current ? "  <- current" : ""}`);
    return 0;
  }

  if (sub !== "update") throw new ForgeError(USAGE);

  let target = version ?? "";
  if (!target) {
    const view = await mustSucceed("npm view", ctx.exec(["npm", "view", PACKAGE, "version"]));
    target = view.stdout.trim();
    if (!target) throw new ForgeError(`npm view returned no version for ${PACKAGE}.`);
  }
  // Interpolée dans un chemin et dans un spec npm : même discipline que
  // validate.ts pour les noms de tâche.
  if (!VERSION.test(target)) throw new ForgeError(`version must look like a semver, got: ${target}`);

  // npm crée --prefix récursivement en usage réel ; on le fait nous-mêmes ici
  // pour que le répertoire existe déjà au moment du switchCurrent qui suit
  // (le contexte scripté des tests ne lance jamais réellement npm).
  mkdirSync(versionDir(target), { recursive: true });

  ctx.out(`Installing ${PACKAGE}@${target}...`);
  await mustSucceed("npm install", ctx.exec(installArgv(target)));

  // Bascule APRÈS l'install : une install ratée ne doit jamais laisser
  // `current` pointer sur un répertoire à moitié écrit.
  switchCurrent(target);
  ctx.out(`claude-code ${target} is now current. Running sessions keep their version until they exit.`);
  return 0;
}
