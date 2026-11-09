// Host account and runtime steps of `forge install`, run from the laptop over
// the SSH alias: git identity, Claude login (or a cloud host's Claude token),
// `forge setup`, `agent-base` image; and a cloud host's relay credentials, as
// the admin.
import { ForgeError, mustSucceed } from "../context.ts";
import type { Context } from "../context.ts";
import { adminAttach, adminExec, remoteAttach, remoteExec } from "./remote.ts";
import type { LaptopHost } from "./state.ts";

type Identity = { name: string; email: string };

const trimmed = (r: { code: number; stdout: string }): string => (r.code === 0 ? r.stdout.trim() : "");

async function laptopIdentity(ctx: Context): Promise<Identity> {
  const read = async (key: string, label: string): Promise<string> => {
    const v = trimmed(await ctx.exec(["git", "config", "--global", key]));
    if (v) return v;
    const answer = (await ctx.prompt.ask(`git ${label} for the commits of the agents`))?.trim();
    if (!answer) throw new ForgeError(`git ${key} is not set on this machine: run git config --global ${key} <value>`);
    return answer;
  };
  return { name: await read("user.name", "name"), email: await read("user.email", "email") };
}

async function hostIdentity(ctx: Context, host: LaptopHost): Promise<Identity> {
  return {
    name: trimmed(await remoteExec(ctx, host, ["git", "config", "--global", "user.name"])),
    email: trimmed(await remoteExec(ctx, host, ["git", "config", "--global", "user.email"])),
  };
}

// The agents commit as the host's git identity: copy the laptop's when the host
// has none, and never overwrite a different one without asking.
export async function ensureGitIdentity(ctx: Context, host: LaptopHost): Promise<"set" | "already"> {
  const mine = await laptopIdentity(ctx);
  const theirs = await hostIdentity(ctx, host);
  if (theirs.name === mine.name && theirs.email === mine.email) return "already";
  if (theirs.name && theirs.email) {
    const pick = await ctx.prompt.pick(
      `the host's git identity is ${theirs.name} <${theirs.email}>, this machine's is ${mine.name} <${mine.email}>`,
      ["keep the host's", "replace it with this machine's"],
    );
    if (pick !== 2) return "already";
  }
  await mustSucceed("git config user.name on the host", remoteExec(ctx, host, ["git", "config", "--global", "user.name", mine.name]));
  await mustSucceed("git config user.email on the host", remoteExec(ctx, host, ["git", "config", "--global", "user.email", mine.email]));
  return "set";
}

export async function ensureClaudeLogin(ctx: Context, host: LaptopHost): Promise<"logged-in" | "already"> {
  // ssh lands in the forge user's home: the path is relative to it.
  if ((await remoteExec(ctx, host, ["test", "-e", ".claude/.credentials.json"])).code === 0) return "already";
  if ((await remoteAttach(ctx, host, ["claude", "auth", "login"], true)) !== 0) {
    throw new ForgeError("claude auth login did not finish");
  }
  return "logged-in";
}

// A cloud host's Claude credential (spec §5.3): a `claude setup-token` token,
// one year, model requests only, revocable in claude.ai (Settings > Claude
// Code). Relative to the forge user's home; the agent's launcher reads it.
export const CLAUDE_TOKEN_FILE = ".config/agent-forge/claude-token";
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

// Pasted at a prompt that does not echo it, then written on the host through
// ssh's stdin: never in an argv, a printed line or a file on this machine.
// An error never quotes it.
export async function ensureClaudeToken(ctx: Context, host: LaptopHost): Promise<"stored" | "already"> {
  if ((await remoteExec(ctx, host, ["test", "-s", CLAUDE_TOKEN_FILE])).code === 0) return "already";
  ctx.out(`Claude Code on ${host.name} needs a token: run claude setup-token on this machine, then paste the token it prints.`);
  const token = ((await ctx.prompt.askSecret("Claude token")) ?? "").trim();
  if (!token) throw new ForgeError("no Claude token given: paste the token claude setup-token prints");
  if (!TOKEN.test(token)) {
    throw new ForgeError("that is not a Claude token (letters, digits and . _ ~ + / = - only, no spaces): paste only what claude setup-token prints");
  }
  await mustSucceed("writing the Claude token on the host", remoteExec(ctx, host,
    // chmod as well: umask narrows a new file only, not one already there.
    ["sh", "-c", `umask 077 && mkdir -p .config/agent-forge && cat > ${CLAUDE_TOKEN_FILE} && chmod 600 ${CLAUDE_TOKEN_FILE}`],
    `${token}\n`));
  return "stored";
}

// The bot's GitHub token on the relay (cli/lib/relay/paths.ts). Like
// config.json, root:forge-relay 0640: the service reads it and cannot change
// it. Written to a temporary file next to it, then renamed: a token is never
// half there. `cat`, not `install /dev/stdin`, which uutils' install (Ubuntu
// 26.04) may refuse, stdin being no regular file. Fixed paths only, nothing
// in the script comes from outside; the token arrives on stdin.
const RELAY_TOKEN_FILE = "/etc/forge-relay/github-token";
const WRITE_RELAY_TOKEN = `umask 077 && cat > ${RELAY_TOKEN_FILE}.new && chown root:forge-relay ${RELAY_TOKEN_FILE}.new && ` +
  `chmod 0640 ${RELAY_TOKEN_FILE}.new && mv -f ${RELAY_TOKEN_FILE}.new ${RELAY_TOKEN_FILE}`;
// A classic personal access token: only those can open pull requests and
// comment on a public repository another account owns, the upstream (spec
// §5.4). The token is for GitHub's API only: the relay pushes over SSH.
const BOT_TOKEN = /^ghp_[A-Za-z0-9]{36}$/;

// The relay's credentials (spec §5.7), by the admin's SSH to the relay: the
// bot's token, pasted at a prompt that does not echo it and written through
// ssh's stdin, like the Claude token (never in an argv, a printed line, a
// file on this machine or an error); then `forge-relay setup`, which checks
// the token, creates the bot's fork, and checks that the two keys relay.yml
// made, the push key and the signing key, are registered on the bot's
// account. It exits non-zero until the maintainer has done what it prints,
// such as registering those keys.
// This step is not recorded yet whenever it runs, so a token already stored
// may be one the setup refused (wrong scopes, another account) or one revoked
// since: the maintainer keeps it or pastes a new one.
export async function ensureRelayCredentials(ctx: Context, host: LaptopHost): Promise<"stored" | "already"> {
  const relay = host.relayAddress;
  if (!relay) throw new ForgeError(`${host.name} has no relay address yet: run forge cloud create --host ${host.name}`);
  const stored = (await adminExec(ctx, host, relay, ["sudo", "test", "-s", RELAY_TOKEN_FILE])).code === 0;
  const replace = stored &&
    (await ctx.prompt.pick("A bot token is already stored on the relay", ["keep it", "paste a new one"])) === 2;
  if (!stored || replace) await storeBotToken(ctx, host, relay);
  if ((await adminAttach(ctx, host, relay, ["sudo", "-u", "forge-relay", "/usr/local/bin/forge-relay", "setup"])) !== 0) {
    throw new ForgeError(
      `the relay's setup is not complete: do what it says above, then run forge cloud create --host ${host.name} again; ` +
      `if the token itself was refused, run forge cloud create --host ${host.name} again and choose to paste a new one`,
    );
  }
  return !stored || replace ? "stored" : "already";
}

async function storeBotToken(ctx: Context, host: LaptopHost, relay: string): Promise<void> {
  ctx.out("The relay publishes as the bot, a GitHub account of its own. On GitHub:");
  ctx.out("  1. create the bot's account, with two-factor authentication on; never make it a collaborator of the repository;");
  ctx.out("  2. as the bot, create a classic personal access token with only the public_repo scope, and no expiration.");
  ctx.out("The relay creates the bot's fork itself, then prints two keys to register on the bot's account:");
  ctx.out("an Authentication Key, for its pushes, and a Signing Key, for its commit signatures.");
  const token = ((await ctx.prompt.askSecret("Bot token")) ?? "").trim();
  if (!token) throw new ForgeError("no bot token given: paste the bot's classic personal access token");
  if (!BOT_TOKEN.test(token)) {
    throw new ForgeError("that is not a classic GitHub token (ghp_ then 36 letters and digits): create a classic personal access token, not a fine-grained one");
  }
  await mustSucceed("writing the bot's token on the relay",
    adminExec(ctx, host, relay, ["sudo", "sh", "-c", WRITE_RELAY_TOKEN], `${token}\n`));
}

export async function runSetup(ctx: Context, host: LaptopHost): Promise<void> {
  if ((await remoteAttach(ctx, host, ["forge", "setup"])) !== 0) {
    throw new ForgeError("forge setup failed on the host: fix the error above");
  }
}

// Does the host's agent-base predate the last change to what builds it? When
// the checkout cannot answer, "ask": better than 10 minutes of silent build.
export async function imageDecision(
  ctx: Context, host: LaptopHost, checkout: string,
): Promise<"build" | "fresh" | "ask"> {
  const image = (await remoteExec(ctx, host, ["forge", "image", "commit"])).stdout.trim();
  if (!image) return "build";
  const git = (...args: string[]) => ctx.exec(["git", "-C", checkout, ...args]);
  if ((await git("cat-file", "-e", `${image}^{commit}`)).code !== 0) return "ask";
  const log = await git("log", "-1", "--format=%H", "--", "ansible/image.yml", "ansible/roles/forge_image", "cli/lib/commands/image.ts");
  const last = log.code === 0 ? log.stdout.trim() : "";
  if (!last) return "ask";
  // 0 = ancestor, 1 = not; anything else is a git error (shallow clone, ...).
  const { code } = await git("merge-base", "--is-ancestor", last, image);
  return code === 0 ? "fresh" : code === 1 ? "build" : "ask";
}

export async function ensureImage(ctx: Context, host: LaptopHost, checkout: string): Promise<"built" | "fresh"> {
  let decision = await imageDecision(ctx, host, checkout);
  if (decision === "ask") {
    const pick = await ctx.prompt.pick("agent-base was built from a commit this checkout does not know",
      ["rebuild it (about 10 minutes)", "keep it"]);
    decision = pick === 1 ? "build" : "fresh";
  }
  if (decision === "fresh") return "fresh";
  if ((await remoteAttach(ctx, host, ["forge", "image", "build"], true)) !== 0) {
    throw new ForgeError("the image build failed");
  }
  return "built";
}
