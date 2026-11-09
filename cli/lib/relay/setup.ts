// The relay's setup check: the token, the fork and the signing key, in that
// order. Run by the maintainer after the bot's account is prepared.
import type { Context } from "../context.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { ensureFork, type GitHub } from "./github.ts";

// "ssh-ed25519 AAAA… comment" → "ssh-ed25519 AAAA…": the comment is free text.
const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(" ");

export async function relaySetup(ctx: Context, gh: GitHub, cfg: RelayConfig, signingPub: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  // An empty or malformed key would match a malformed registered one (both have no id).
  if (!/^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}(\s|$)/.test(signingPub.trim())) throw new RelayError("the signing public key is empty or malformed: expected '<type> <base64> [comment]'");
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

  // The relay never enables Actions on the fork: the bot's branches would run
  // workflows there. Disabled is GitHub's default on a new fork.
  let actionsOk = true;
  const perms = await gh.request("GET", `/repos/${cfg.fork}/actions/permissions`);
  if (perms.status === 200) {
    if ((perms.json as { enabled?: unknown } | null)?.enabled !== false) {
      ctx.out(`Actions are enabled on ${cfg.fork}: disable them (the fork's Settings → Actions → General → Disable actions); the relay needs them off`);
      actionsOk = false;
    } else ctx.out("fork Actions: disabled");
  } else if (perms.status === 403 || perms.status === 404) {
    ctx.out(`could not check the Actions setting of ${cfg.fork} with this token: make sure the fork's Actions tab shows them disabled, which GitHub does by default on a new fork`);
  } else throw new RelayError(`GitHub GET /repos/${cfg.fork}/actions/permissions answered ${perms.status}`);

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
  return actionsOk ? 0 : 1;
}
