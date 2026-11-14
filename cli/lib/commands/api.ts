// forge api serve (DX 5, §5.4) : le service qui répond aux containers. Lancé par
// l'unité systemd de l'utilisateur forge, que le rôle Ansible forge_users installe.
import { readFileSync } from "node:fs";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { loadConfig } from "../config.ts";
import { Journal, journalPath } from "../api/journal.ts";
import { needsApi, serveApi } from "../api/server.ts";
import { configPath } from "../paths.ts";
import { members } from "../team.ts";
import { requireClaudeToken } from "./provision.ts";

const USAGE = "Usage: forge api serve";

// Avant `forge install` (le service démarre avec l'hôte) il n'y a pas de token,
// donc rien à refuser : `team converge` relance le service quand il y en a un.
function claudeToken(ctx: Context): string[] {
  try {
    return [readFileSync(requireClaudeToken(), "utf8").trim()];
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    ctx.out("forge api: no Claude token on this host yet");
    return [];
  }
}

export async function cmdApi(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub !== "serve") throw new ForgeError(USAGE);
  const cfg = loadConfig(configPath());
  // Les secrets que forge a distribués : un texte qui en contient un est refusé
  // avant le journal et avant tout autre agent.
  const secrets = claudeToken(ctx);
  const journal = Journal.open(journalPath());
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  ctx.out(`forge api: serving ${members(cfg).filter(needsApi).length} socket(s)`);
  await serveApi({ ctx, cfg, journal, secrets, now: () => new Date() }, stop.signal);
  return 0;
}
