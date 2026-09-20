// scripts/lib/commands/token.ts
// forge token set|rm|import [<owner/repo>]
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { readToken, removeToken, writeToken } from "../credentials.ts";
import { describeContainers, isRunning, sameRepo } from "../containers.ts";
import { execAsAgent, startInstance, stopInstance } from "../lxd.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge token set|rm|import [<owner/repo>]";

export async function cmdToken(ctx: Context, sub: string | undefined, repo?: string): Promise<number> {
  if (sub !== "set" && sub !== "rm" && sub !== "import") throw new ForgeError(USAGE);
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  if (sub === "rm") {
    ctx.out(removeToken(ownerRepo) ? `Removed the stored token for ${ownerRepo}.` : `no stored token for ${ownerRepo}.`);
    return 0;
  }

  if (sub === "set") {
    ctx.err(`Fine-grained PAT for ${ownerRepo} (Contents RW, Pull requests RW, Metadata R).`);
    const token = await ctx.prompt.askSecret("Paste the token (input hidden)");
    if (!token || !token.trim()) throw new ForgeError("empty token.");
    writeToken(ownerRepo, token);
    ctx.out(`Stored a token for ${ownerRepo}.`);
    return 0;
  }

  // import : récupère le token du container existant du repo, pour migrer sans
  // ressortir un PAT. `gh auth token` n'existe que dans un container démarré.
  const all = await describeContainers(ctx);
  const source = all.find((c) => sameRepo(c, ownerRepo));
  if (!source) throw new ForgeError(`no container for ${ownerRepo} to import a token from.`);

  const wasRunning = await isRunning(ctx, source.name);
  if (!wasRunning) await mustSucceed("lxc start", startInstance(ctx, source.name));
  try {
    const r = await execAsAgent(ctx, source.name, "gh auth token");
    const token = r.stdout.trim();
    if (r.code !== 0 || !token) {
      throw new ForgeError(`no token available in ${source.name}: ${r.stderr.trim() || "gh auth token returned nothing"}`);
    }
    writeToken(ownerRepo, token);
    ctx.out(`Imported ${source.name}'s token into the host store for ${ownerRepo}.`);
  } finally {
    // On rend la machine dans l'état où on l'a trouvée, y compris en cas
    // d'échec : `import` ne doit pas laisser un container allumé derrière lui.
    //
    // Volontairement NON fatal : on est dans un `finally`, où lever masquerait
    // l'erreur déjà en vol. Mais le silence n'est pas acceptable non plus — un
    // container resté allumé doit se voir. Même compromis que l'étape des hooks
    // git-lfs dans provision.ts.
    if (!wasRunning) {
      const stopped = await stopInstance(ctx, source.name);
      if (stopped.code !== 0) {
        ctx.err(`WARNING: could not stop ${source.name} again: ${stopped.stderr.trim() || `exit code ${stopped.code}`}`);
        ctx.err("It was started only to read the token — stop it by hand with 'forge stop'.");
      }
    }
  }
  return 0;
}
