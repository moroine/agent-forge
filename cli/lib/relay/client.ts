// The dev VM's side of the relay: one JSON request per ssh call, and, after a
// publish, the agent's local branch aligned on the signed commits the relay
// pushed. The ssh key can run nothing but the relay's forced command, so what
// this file sends is all the relay will ever hear from the agent.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { configPath } from "../paths.ts";
import { printable } from "../printable.ts";
import { validTask } from "./policy.ts";

export type RelayClientConfig = { address: string; user: string; key: string; knownHosts: string };

export function relayClientConfigPath(): string {
  return join(dirname(configPath()), "relay.json");
}

// The fields end up in an ssh argv: a leading "-" would be an option, and
// whitespace or a control character has no place in a host or a login.
const HOSTISH = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

export function loadRelayClientConfig(file: string = relayClientConfigPath()): RelayClientConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ForgeError("no relay on this host: forge relay works on the contributor's dev VM");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ForgeError(`${file} is not valid JSON`);
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const field = (name: string, ok: (s: string) => boolean, want: string): string => {
    const v = o[name];
    if (typeof v !== "string" || !ok(v)) throw new ForgeError(`${file}: "${name}" must be ${want}`);
    return v;
  };
  const path = (s: string) => isAbsolute(s) && !/[\x00-\x1f\x7f]/.test(s);
  return {
    address: field("address", (s) => HOSTISH.test(s), "a host name or an address"),
    user: field("user", (s) => HOSTISH.test(s), "a login name"),
    key: field("key", path, "an absolute path"),
    knownHosts: field("knownHosts", path, "an absolute path"),
  };
}

// The agent is never forwarded (no ForwardAgent), the relay's host key must
// match the pinned file, and nothing is ever asked on a terminal.
export async function relayCall(ctx: Context, cfg: RelayClientConfig, op: string, request: object): Promise<Record<string, unknown>> {
  const argv = [
    "ssh", "-F", "/dev/null", "-i", cfg.key, "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${cfg.knownHosts}`, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(dirname(cfg.key), "cm-%C")}`, "-o", "ControlPersist=60",
    `${cfg.user}@${cfg.address}`, op,
  ];
  const r = await ctx.exec(argv, { input: JSON.stringify(request) });
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  let answer: unknown;
  try {
    answer = JSON.parse(lines[lines.length - 1] ?? "");
  } catch {
    throw new ForgeError(`the relay did not answer: ${printable(r.stderr.trim()) || `ssh exit code ${r.code}`}`);
  }
  const a = (typeof answer === "object" && answer !== null ? answer : {}) as Record<string, unknown>;
  if (a.ok !== true) {
    throw new ForgeError(`the relay refused: ${printable(typeof a.error === "string" ? a.error : "no reason given")}`);
  }
  return a;
}

// The agent's tree is its own, but every git command runs without hooks, as
// everywhere else in the relay code.
const gitArgs = (root: string, args: string[]): string[] => ["git", "-C", root, "-c", "core.hooksPath=/dev/null", ...args];

async function gitOut(ctx: Context, root: string, ...args: string[]): Promise<string | null> {
  const r = await ctx.exec(gitArgs(root, args));
  return r.code === 0 ? r.stdout.trim() : null;
}

function taskBranch(task: string): string {
  try {
    validTask(`agent/${task}`);
  } catch (e) {
    throw new ForgeError((e as Error).message);
  }
  return `agent/${task}`;
}

// Sends the branch's new commits and aligns agent/<t> on what the relay pushed.
export async function publishBranch(ctx: Context, cfg: RelayClientConfig, cwd: string | undefined, taskArg?: string): Promise<{ head: string; url: string }> {
  const top = await ctx.exec(["git", "-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) throw new ForgeError("forge relay publish works in a git repository");
  const root = top.stdout.trim();

  let name = taskArg;
  if (name === undefined) {
    const current = await gitOut(ctx, root, "symbolic-ref", "--short", "-q", "HEAD");
    if (current === null) throw new ForgeError("HEAD is detached: name the task, forge relay publish <task>");
    if (!current.startsWith("agent/")) throw new ForgeError(`the current branch is ${current}: only agent/<task> branches are published`);
    name = current.slice("agent/".length);
  }
  const branch = taskBranch(name);
  const tip = await gitOut(ctx, root, "rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`);
  if (tip === null) throw new ForgeError(`there is no branch ${branch} in this repository`);
  if (await gitOut(ctx, root, "rev-parse", "--verify", "-q", "refs/remotes/origin/main") === null) {
    throw new ForgeError("refs/remotes/origin/main is missing: run git fetch origin");
  }
  const forkRef = `refs/remotes/fork/${branch}`;
  const known = await gitOut(ctx, root, "rev-parse", "--verify", "-q", forkRef);

  const tmp = await mkdtemp(join(tmpdir(), "forge-relay-"));
  try {
    const file = join(tmp, "out.bundle");
    const made = await ctx.exec(gitArgs(root, ["bundle", "create", "-q", file, `refs/heads/${branch}`, "^refs/remotes/origin/main", ...(known === null ? [] : [`^${forkRef}`])]));
    if (made.code !== 0) throw new ForgeError(`nothing to publish from ${branch}: ${printable(made.stderr.trim())}`);
    const bundle = (await readFile(file)).toString("base64");
    const answer = await relayCall(ctx, cfg, "publish", { branch, bundle });
    const { head, url, bundle: back } = answer;
    if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head) || typeof url !== "string" || typeof back !== "string") {
      throw new ForgeError("the relay's publish answer is malformed");
    }

    // The answer's bundle holds the signed commits under refs/relay/published/.
    const incoming = join(tmp, "published.bundle");
    await writeFile(incoming, Buffer.from(back, "base64"));
    await mustSucceed("fetching the published branch", ctx.exec(gitArgs(root, [
      "fetch", "-q", "--no-tags", incoming, `+refs/relay/published/${branch}:${forkRef}`,
    ])));
    // The relay re-signs, it does not rewrite: same tree as what was sent.
    const got = await gitOut(ctx, root, "rev-parse", "--verify", "-q", `${forkRef}^{commit}`);
    const gotTree = await gitOut(ctx, root, "rev-parse", "--verify", "-q", `${head}^{tree}`);
    const sentTree = await gitOut(ctx, root, "rev-parse", "--verify", "-q", `${tip}^{tree}`);
    if (got !== head || gotTree === null || gotTree !== sentTree) {
      throw new ForgeError("the published branch does not hold the tree that was sent: the local branch is untouched");
    }

    // Moves the branch only if it is still where it was sent from.
    const moved = await ctx.exec(gitArgs(root, ["update-ref", `refs/heads/${branch}`, head, tip]));
    if (moved.code !== 0) {
      throw new ForgeError(`${branch} moved during the publish: it was published at ${head.slice(0, 12)}; ` +
        `move your new commits onto fork/${branch} (git rebase fork/${branch})`);
    }
    return { head, url };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
