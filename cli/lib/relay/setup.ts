// The relay's setup check: the token, the fork and its Actions, then the two
// keys the maintainer registers on the bot's account, the push key and the
// signing key. Run by the maintainer after the bot's account is prepared.
import { printable } from "../printable.ts";
import { RelayError } from "./config.ts";
import { ensureFork, type GitHub } from "./github.ts";
import { githubSsh } from "./paths.ts";
import type { RelayDeps } from "./publish.ts";

export type SetupDeps = Pick<RelayDeps, "ctx" | "github" | "cfg" | "paths" | "sleep">;
// The public halves of the relay's keys, as their .pub files hold them.
export type PublicKeys = { push: string; signing: string };

// "ssh-ed25519 AAAA… comment" → "ssh-ed25519 AAAA…": the comment is free text.
const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(" ");

// GitHub's answer to `ssh -T git@github.com` with a key it knows, on stderr
// and with exit code 1: "Hi <login>! You've successfully authenticated, …".
// For a deploy key, it names the key's repository instead of a login.
const GREETING = /^Hi ([^!\s]+)! You've successfully authenticated/m;

// Is this key among the bot's registered ones? `path` lists either its
// authentication keys or its signing keys; both lists are public.
async function registered(gh: GitHub, path: string, pub: string): Promise<boolean> {
  const keys = await gh.request("GET", path);
  if (keys.status !== 200) throw new RelayError(`GitHub GET ${path} answered ${keys.status}`);
  const want = keyId(pub);
  return (Array.isArray(keys.json) ? keys.json : []).some((k) => keyId(String((k as { key?: unknown })?.key ?? "")) === want);
}

function notRegistered(d: SetupDeps, name: string, pub: string, type: string): void {
  d.ctx.out(`${name}, not registered yet:`);
  d.ctx.out(pub.trim());
  d.ctx.out(`register it on ${d.cfg.botLogin}'s account: Settings → SSH and GPG keys → New SSH key, Key type: ${type}. Then run the setup again.`);
}

// The push key, registered as an authentication key, and accepted by GitHub
// as the bot's: the registration alone does not show that the relay holds
// its private half, nor that GitHub's pinned host keys are still current.
async function checkPushKey(d: SetupDeps, pub: string): Promise<boolean> {
  const { ctx, cfg } = d;
  if (!(await registered(d.github, `/users/${cfg.botLogin}/keys`, pub))) {
    notRegistered(d, "push key", pub, "Authentication Key");
    return false;
  }
  const r = await ctx.exec([...githubSsh(d.paths), "-T", "git@github.com"]);
  const login = GREETING.exec(r.stderr)?.[1];
  if (login === undefined) {
    // No greeting: ssh's own message (a host key that is not the pinned one,
    // a refused key, no network) says why.
    const why = r.stderr.trim().split("\n").map(printable).join(" / ").slice(0, 300) || `exit code ${r.code}`;
    ctx.out(`push key: github.com did not authenticate the push key as ${cfg.botLogin}: ${why}`);
    return false;
  }
  if (login.toLowerCase() !== cfg.botLogin.toLowerCase()) {
    ctx.out(`push key: github.com authenticates it as ${printable(login)}, not ${cfg.botLogin}: register it on ${cfg.botLogin}'s account only`);
    return false;
  }
  ctx.out(`push key: registered, and GitHub authenticates it as ${cfg.botLogin}`);
  return true;
}

export async function relaySetup(d: SetupDeps, pub: PublicKeys): Promise<number> {
  const { ctx, github: gh, cfg } = d;
  // An empty or malformed key would match a malformed registered one (both have no id).
  for (const [name, line] of [["push", pub.push], ["signing", pub.signing]] as const) {
    if (!/^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}(\s|$)/.test(line.trim())) {
      throw new RelayError(`the ${name} public key is empty or malformed: expected '<type> <base64> [comment]'`);
    }
  }
  const me = await gh.request("GET", "/user");
  if (me.status !== 200) throw new RelayError(`GitHub GET /user answered ${me.status}: the token is not accepted`);
  const login = String((me.json as { login?: unknown } | null)?.login ?? "");
  if (login.toLowerCase() !== cfg.botLogin.toLowerCase()) throw new RelayError("the token belongs to another account than the bot's");
  // The token is for GitHub's API only (pull requests, comments, the fork,
  // CI): pushes go over SSH, which no token scope limits. Without expiry, as
  // the maintainer creates it: its expiry is not checked.
  const scopes = (me.headers.get("X-OAuth-Scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  if (scopes.join(",") !== "public_repo") {
    throw new RelayError(`the token's scopes are [${scopes.join(", ")}]: it must have the public_repo scope only`);
  }
  ctx.out(`token: ok (${cfg.botLogin}, scope public_repo)`);

  ctx.out(`fork ${cfg.fork}: ${await ensureFork(gh, cfg, d.sleep)}`);

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

  // Both keys are reported before returning, so that the maintainer registers
  // them in one pass.
  const pushOk = await checkPushKey(d, pub.push);
  const signingOk = await registered(gh, `/users/${cfg.botLogin}/ssh_signing_keys`, pub.signing);
  if (signingOk) ctx.out("signing key: registered");
  else notRegistered(d, "signing key", pub.signing, "Signing Key");
  return actionsOk && pushOk && signingOk ? 0 : 1;
}
