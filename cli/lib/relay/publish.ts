// The relay's publish: the agent's branch arrives from the dev VM as a git
// bundle. The relay checks it, replays its new commits as the bot's signed
// commits, scans them with Betterleaks against upstream main's ignore file,
// and pushes them to the bot's fork, fast-forward only. Nothing is pushed or
// recorded unless every step before passed.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { printable } from "../printable.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { ensureFork, type GitHub } from "./github.ts";
import type { RelayPaths } from "./paths.ts";
import { checkAuthorship, checkCommits, validTask } from "./policy.ts";
import { gitIn, readCommit, replaySigned, shortSha } from "./replay.ts";
import { fileAt, scanCommits, UPSTREAM_MAIN } from "./scan.ts";
import { takeWrite, withState } from "./state.ts";
import { neutralizeMentions } from "./text.ts";

export type RelayDeps = {
  ctx: Context;
  cfg: RelayConfig;
  paths: RelayPaths;
  github: GitHub;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const MAX_COMMITS = 200;
// The relay's own refs for a task, in its mirror: the fork's branch as last
// fetched, the head the relay published, and the branch the dev VM sent.
const KINDS = ["fork", "published", "incoming"] as const;
const ref = (kind: (typeof KINDS)[number], task: string): string => `refs/relay/${kind}/agent/${task}`;

// No git command of the relay may wait for a password on a terminal.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

const git = (ctx: Context, repo: string, step: string, ...args: string[]) => mustSucceed(step, ctx.exec(gitIn(repo, ...args)));

// git's stderr, on one printable line.
const oneLine = (text: string): string => text.trim().split("\n").map(printable).join(" / ");

// A ref of the mirror as a commit ID, or null when the ref does not exist.
async function commitAt(ctx: Context, repo: string, name: string): Promise<string | null> {
  const r = await ctx.exec(gitIn(repo, "rev-parse", "--verify", "-q", `${name}^{commit}`));
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return null;
  throw new ForgeError(`git rev-parse ${name} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
}

const lines = (text: string): string[] => text.split("\n").filter((l) => l !== "");

// The bot's token, read for the push only. Neither it nor its file's content
// ever appears in an error.
function readToken(file: string): string {
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    throw new ForgeError(`cannot read the bot's token from ${file}`);
  }
  if (token === "" || /\s/.test(token)) throw new ForgeError(`the bot's token in ${file} is empty or malformed`);
  return token;
}

// Step 2, before the lock: upstream main and the fork's branch, fetched
// anonymously into the mirror. A fork without the branch is a first publish.
async function fetchGitHub(d: RelayDeps, t: string): Promise<void> {
  const { ctx, cfg, paths } = d;
  const repo = paths.mirror;
  const anon = { env: NO_PROMPT };
  await mustSucceed("fetching upstream main", ctx.exec(gitIn(repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head",
    `${paths.githubBase}/${cfg.upstream}.git`, `+refs/heads/main:${UPSTREAM_MAIN}`), anon));
  const forkUrl = `${paths.githubBase}/${cfg.fork}.git`;
  const branch = `refs/heads/agent/${t}`;
  // ls-remote matches the end of a ref name: keep the exact name only.
  const listed = await mustSucceed("listing the fork's branch", ctx.exec(gitIn(repo, "ls-remote", forkUrl, branch), anon));
  if (lines(listed.stdout).some((l) => l.split("\t")[1] === branch)) {
    await mustSucceed("fetching the fork's branch", ctx.exec(gitIn(repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head",
      forkUrl, `+${branch}:${ref("fork", t)}`), anon));
  } else {
    await git(ctx, repo, "forgetting the fork's branch", "update-ref", "-d", ref("fork", t));
  }
}

// A fork branch the relay has no record of (after a relay rebuild) is taken as
// published when every commit on it is the bot's.
async function adopt(d: RelayDeps, t: string, forkHead: string, upstreamMain: string): Promise<void> {
  const { ctx, cfg, paths } = d;
  const shas = lines((await git(ctx, paths.mirror, "listing the fork's commits", "rev-list", forkHead, `^${upstreamMain}`)).stdout);
  for (const sha of shas) {
    try {
      checkAuthorship(await readCommit(ctx, paths.mirror, sha), cfg);
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      throw new RelayError(`the fork's agent/${t} was not published by this relay and holds a commit that is not the bot's: nothing was published; ${e.message}`);
    }
  }
}

export async function publish(d: RelayDeps, req: { branch: string; bundle: Buffer }): Promise<{ head: string; url: string; bundle: Buffer }> {
  const { ctx, cfg, paths } = d;
  const repo = paths.mirror;
  const t = validTask(req.branch);
  await ensureFork(d.github, cfg, d.sleep);
  await fetchGitHub(d, t);

  // One lock from reading the fork's head to recording what was pushed: two
  // publishes never interleave.
  return withState(paths.stateDir, async (s) => {
    // Commit IDs, read once: a concurrent request's fetch may move the refs.
    const upstreamMain = await commitAt(ctx, repo, UPSTREAM_MAIN);
    if (upstreamMain === null) throw new ForgeError("upstream main is missing from the mirror after fetching it");
    const forkHead = await commitAt(ctx, repo, ref("fork", t));
    const recorded = s.published[t] ?? null;
    if (recorded !== null) {
      if (forkHead !== recorded) {
        throw new RelayError(`the fork's agent/${t} moved since the relay published it: nothing was published; the maintainer never commits to the bot's branches`);
      }
    } else if (forkHead !== null) {
      await adopt(d, t, forkHead, upstreamMain);
    }
    const base = forkHead ?? upstreamMain;

    const tmp = await mkdtemp(path.join(os.tmpdir(), "forge-relay-publish-"));
    try {
      // Only refs/heads/agent/<t> is taken from the bundle, into the relay's
      // own namespace; whatever else it carries is ignored. Its objects are
      // checked as they come in (git fsck's rules), as the mirror's
      // transfer.fsckObjects already asks: said again here, where it matters.
      const incomingBundle = path.join(tmp, "incoming.bundle");
      await writeFile(incomingBundle, req.bundle);
      if ((await ctx.exec(gitIn(repo, "bundle", "verify", "-q", incomingBundle))).code !== 0) {
        throw new RelayError("the branch needs commits the relay does not have: start from origin/main");
      }
      const fetched = await ctx.exec(gitIn(repo, "-c", "transfer.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head",
        incomingBundle, `+refs/heads/agent/${t}:${ref("incoming", t)}`));
      if (fetched.code !== 0) throw new RelayError(`the bundle's agent/${t} could not be fetched: ${oneLine(fetched.stderr)}`);
      const incoming = (await git(ctx, repo, "reading the incoming branch", "rev-parse", "--verify", ref("incoming", t))).stdout.trim();
      if ((await git(ctx, repo, "reading the incoming branch", "cat-file", "-t", incoming)).stdout.trim() !== "commit") {
        // A tag or a blob is not kept: the other tasks' refs must be commits.
        await git(ctx, repo, "forgetting the incoming branch", "update-ref", "-d", ref("incoming", t));
        throw new RelayError(`the bundle's agent/${t} is not a commit`);
      }

      // The new commits: neither on upstream main nor on the fork, nor any
      // other task's (as fetched, published or sent). A commit built on
      // another task then has a parent checkCommits refuses: no stacked tasks.
      const own = new Set(KINDS.map((k) => ref(k, t)));
      const others = lines((await git(ctx, repo, "listing the relay's refs", "for-each-ref", "--format=%(objecttype) %(refname)",
        ...KINDS.map((k) => `refs/relay/${k}/agent`))).stdout)
        .flatMap((l) => (l.startsWith("commit ") ? [l.slice("commit ".length)] : []))
        .filter((r) => !own.has(r));
      // One more than the cap is enough to refuse, before reading any commit.
      const shas = lines((await git(ctx, repo, "listing the new commits", "rev-list", "--topo-order", "--reverse",
        `--max-count=${MAX_COMMITS + 1}`, incoming, `^${upstreamMain}`, ...(forkHead === null ? [] : [`^${forkHead}`]),
        ...(others.length > 0 ? ["--not", ...others] : []))).stdout);
      if (shas.length > MAX_COMMITS) throw new RelayError(`this publish brings more than ${MAX_COMMITS} commits: squash some of them`);
      if (shas.length === 0) {
        throw new RelayError(`nothing new to publish: every commit of agent/${t} is on upstream main, on the fork, or was sent for another task`);
      }
      const commits = [];
      for (const sha of shas) commits.push(await readCommit(ctx, repo, sha));
      await checkCommits(ctx, repo, { commits, tip: incoming, upstreamMain, base: forkHead, cfg });

      const allowed = [...cfg.trustedLogins, cfg.botLogin].map((l) => l.toLowerCase());
      const head = await replaySigned(ctx, repo, commits, paths.signingKey, (m) => neutralizeMentions(m, allowed));
      const tree = async (rev: string) => (await git(ctx, repo, "reading a tree", "rev-parse", `${rev}^{tree}`)).stdout.trim();
      if ((await tree(head)) !== (await tree(incoming))) throw new ForgeError(`the replay of agent/${t} does not have the agent's tree`);

      // The commits about to be pushed, as CI will scan them, with main's ignore file.
      const ignoreText = await fileAt(ctx, repo, upstreamMain, ".betterleaksignore");
      const found = await scanCommits(ctx, repo, `${base}..${head}`, ignoreText);
      if (found.length > 0) {
        throw new RelayError([
          `Betterleaks found ${found.length === 1 ? "a possible secret" : `${found.length} possible secrets`} in agent/${t}:`,
          ...found.map((f) => `  ${f.rule} in ${f.file}:${f.line} (commit ${shortSha(f.commit)}, fingerprint ${f.fingerprint})`),
          "Nothing was published. A false positive is cleared by the maintainer: its fingerprint goes into .betterleaksignore on main.",
        ].join("\n"));
      }

      takeWrite(s, d.now(), cfg.writesPerHour);

      // No `+` and no --force: GitHub refuses anything but a fast-forward or
      // the branch's creation. The token goes to git in its environment only.
      const token = readToken(paths.token);
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      const pushed = await ctx.exec(gitIn(repo, "push", "--porcelain", `${paths.githubBase}/${cfg.fork}.git`, `${head}:refs/heads/agent/${t}`), {
        env: {
          ...NO_PROMPT,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
        },
      });
      if (pushed.code !== 0) {
        // --porcelain marks a ref the remote refused with `!`.
        if (/^!\t/m.test(pushed.stdout)) throw new RelayError(`the fork's agent/${t} moved during the publish`);
        // git does not print the header; redacted all the same, in both forms.
        const detail = oneLine(pushed.stderr).split(token).join("***").split(basic).join("***");
        throw new ForgeError(`pushing agent/${t} to the fork failed: ${detail}`);
      }

      // Pushed: recorded, then answered with a bundle the client fetches into
      // its fork/agent/<t>.
      await git(ctx, repo, "recording the published head", "update-ref", ref("published", t), head);
      s.published[t] = head;
      const answer = path.join(tmp, "published.bundle");
      await git(ctx, repo, "bundling the published branch", "bundle", "create", "-q", answer, ref("published", t), `^${base}`);
      return { head, url: `https://github.com/${cfg.fork}/tree/agent/${t}`, bundle: await readFile(answer) };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}
