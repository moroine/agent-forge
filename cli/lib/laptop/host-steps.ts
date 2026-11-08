// Host account and runtime steps of `forge install`, run from the laptop over
// the SSH alias: git identity, Claude login (or a cloud host's Claude token),
// `forge setup`, `agent-base` image.
import { ForgeError, mustSucceed } from "../context.ts";
import type { Context } from "../context.ts";
import { remoteAttach, remoteExec } from "./remote.ts";
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
