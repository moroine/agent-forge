// The relay's setup check: the token, the fork and the signing key, in that
// order. Run by the maintainer after the bot's account is prepared.
import type { Context } from "../context.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { ensureFork, type GitHub } from "./github.ts";

// "ssh-ed25519 AAAA… comment" → "ssh-ed25519 AAAA…": the comment is free text.
const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(" ");

export async function relaySetup(ctx: Context, gh: GitHub, cfg: RelayConfig, signingPub: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  const me = await gh.request("GET", "/user");
  if (me.status !== 200) throw new RelayError(`GitHub GET /user answered ${me.status}: the token is not accepted`);
  const login = String((me.json as { login?: unknown } | null)?.login ?? "");
  if (login.toLowerCase() !== cfg.botLogin.toLowerCase()) throw new RelayError("the token belongs to another account than the bot's");
  // The token may do no more than push to a public fork and its workflows.
  const scopes = (me.headers.get("X-OAuth-Scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  if (scopes.join(",") !== "public_repo,workflow") {
    throw new RelayError(`the token's scopes are "${scopes.join(", ")}": they must be exactly public_repo and workflow`);
  }
  if (!me.headers.get("GitHub-Authentication-Token-Expiration")) throw new RelayError("the token has no expiry: create it with an expiration date");
  ctx.out(`token: ok (${cfg.botLogin}, scopes public_repo and workflow, with an expiry)`);

  ctx.out(`fork ${cfg.fork}: ${await ensureFork(gh, cfg, sleep)}`);

  const keys = await gh.request("GET", `/users/${cfg.botLogin}/ssh_signing_keys`);
  if (keys.status !== 200) throw new RelayError(`GitHub GET /users/${cfg.botLogin}/ssh_signing_keys answered ${keys.status}`);
  const want = keyId(signingPub);
  const registered = (Array.isArray(keys.json) ? keys.json : []).some((k) => keyId(String((k as { key?: unknown })?.key ?? "")) === want);
  if (!registered) {
    ctx.out("signing key, not registered yet:");
    ctx.out(signingPub.trim());
    ctx.out(`register it on ${cfg.botLogin}'s account: Settings → SSH and GPG keys → New SSH key, key type Signing Key. Then run the setup again.`);
    return 1;
  }
  ctx.out("signing key: registered");
  ctx.out("GitHub disables Actions on a new fork: check the fork's Actions tab once and enable them.");
  return 0;
}
