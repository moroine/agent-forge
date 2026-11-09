// The relay's publish: the agent's branch arrives from the dev VM as a git
// bundle. The relay checks it, replays its new commits as the bot's signed
// commits, scans them with Betterleaks against upstream main's ignore file,
// and pushes them to the bot's fork over SSH, fast-forward only. Nothing is
// pushed or recorded unless every step before passed.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { printable } from "../printable.ts";
import { shellQuote } from "../shell.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { ensureFork, type GitHub } from "./github.ts";
import { githubSsh, type RelayPaths } from "./paths.ts";
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

// The push runs under the state lock, which another request takes as stale
// after 15 minutes: it is cut well before. ssh's keepalives drop a dead
// connection; this bounds a slow one, and the whole push.
const PUSH_TIMEOUT_MS = 600_000;

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

// The best common ancestor of two commits, or null when they have none.
async function mergeBase(ctx: Context, repo: string, a: string, b: string): Promise<string | null> {
  const r = await ctx.exec(gitIn(repo, "merge-base", a, b));
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return null;
  throw new ForgeError(`git merge-base failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
}

async function isAncestor(ctx: Context, repo: string, ancestor: string, of: string): Promise<boolean> {
  const r = await ctx.exec(gitIn(repo, "merge-base", "--is-ancestor", ancestor, of));
  if (r.code > 1) throw new ForgeError(`git merge-base failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  return r.code === 0;
}

// The refusal of a push, from git's --porcelain output, which marks a refused
// ref with `!` (`!\t<src>:<dst>\t[rejected] (non-fast-forward)`): null when
// the push was not refused but failed. Only a fork that moved is reported as
// such; any other refusal (GitHub's push protection, say) gives GitHub's
// reason.
function pushRefusal(porcelain: string, t: string): string | null {
  const summary = /^!\t[^\t]*\t(.*)$/m.exec(porcelain)?.[1];
  if (summary === undefined) return null;
  if (/^\[rejected\] \((non-fast-forward|fetch first)\)$/.test(summary)) return `the fork's agent/${t} moved during the publish`;
  const reason = /^\[[^\]]*\] \((.*)\)$/.exec(summary)?.[1] ?? summary;
  return `GitHub refused the push of agent/${t}: ${printable(reason).slice(0, 200)}. Nothing was published.`;
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
  return withState(paths.stateDir, async (s, save) => {
    // Commit IDs, read once: a concurrent request's fetch may move the refs.
    const upstreamMain = await commitAt(ctx, repo, UPSTREAM_MAIN);
    if (upstreamMain === null) throw new ForgeError("upstream main is missing from the mirror after fetching it");
    const forkHead = await commitAt(ctx, repo, ref("fork", t));
    const recorded = s.published[t] ?? null;
    let adopted = false;
    if (forkHead !== null && forkHead === s.pending[t]) {
      // An earlier publish pushed this head, then died before recording it.
      s.published[t] = forkHead;
    } else if (recorded !== null) {
      if (forkHead === null) {
        throw new RelayError(`agent/${t} is gone from the fork although the relay published it at ${shortSha(recorded)}: nothing was published; ask the maintainer`);
      }
      if (forkHead !== recorded) {
        throw new RelayError(`the fork's agent/${t} moved since the relay published it: nothing was published; the maintainer never commits to the bot's branches`);
      }
    } else if (forkHead !== null) {
      await adopt(d, t, forkHead, upstreamMain);
      adopted = true;
    }
    // Any other pending head was never pushed: the fork does not have it.
    delete s.pending[t];

    const tmp = await mkdtemp(path.join(os.tmpdir(), "forge-relay-publish-"));
    // Answered with a bundle the client fetches into its fork/agent/<t>: the
    // published head, without what `base` already has.
    const answer = async (head: string, base: string): Promise<{ head: string; url: string; bundle: Buffer }> => {
      await git(ctx, repo, "recording the published head", "update-ref", ref("published", t), head);
      const file = path.join(tmp, "published.bundle");
      await git(ctx, repo, "bundling the published branch", "bundle", "create", "-q", file, ref("published", t), `^${base}`);
      return { head, url: `https://github.com/${cfg.fork}/tree/agent/${t}`, bundle: await readFile(file) };
    };
    // Set once the bundle's branch is in the mirror. A publish that fails
    // after that forgets it: a refused bundle's objects are then referenced
    // by nothing, and git's own gc prunes them, so refused publishes do not
    // fill the relay's disk.
    let fetchedIncoming = false;
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
      fetchedIncoming = true;
      const incoming = (await git(ctx, repo, "reading the incoming branch", "rev-parse", "--verify", ref("incoming", t))).stdout.trim();
      if ((await git(ctx, repo, "reading the incoming branch", "cat-file", "-t", incoming)).stdout.trim() !== "commit") {
        // A tag or a blob is not kept (forgotten below, as for any refusal):
        // the other tasks' refs must be commits.
        throw new RelayError(`the bundle's agent/${t} is not a commit`);
      }

      // What the branch builds on, of the fork's branch: its head, unless an
      // earlier publish pushed without its answer reaching the dev VM. The
      // agent's branch then still holds the commits that publish replayed,
      // and builds on an older published commit. Replayed again from there,
      // they give the same commits (the replay is deterministic), and the
      // fork's head is checked below.
      const since = forkHead === null ? null : await mergeBase(ctx, repo, incoming, forkHead);

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
        `--max-count=${MAX_COMMITS + 1}`, incoming, `^${upstreamMain}`, ...(since === null ? [] : [`^${since}`]),
        ...(others.length > 0 ? ["--not", ...others] : []))).stdout);
      if (shas.length > MAX_COMMITS) throw new RelayError(`this publish brings more than ${MAX_COMMITS} commits: squash some of them`);
      if (shas.length === 0) {
        if (!adopted || forkHead === null) {
          throw new RelayError(`nothing new to publish: every commit of agent/${t} is on upstream main, on the fork, or was sent for another task`);
        }
        // A branch an earlier relay published (before a rebuild), sent again
        // with nothing new: recorded as it is on the fork, so that open-pr
        // accepts it, and answered with its head. Nothing reaches GitHub.
        s.published[t] = forkHead;
        await save();
        return await answer(forkHead, upstreamMain);
      }
      const commits = [];
      for (const sha of shas) commits.push(await readCommit(ctx, repo, sha));
      await checkCommits(ctx, repo, { commits, tip: incoming, upstreamMain, base: since, cfg });

      const allowed = [...cfg.trustedLogins, cfg.botLogin].map((l) => l.toLowerCase());
      const head = await replaySigned(ctx, repo, commits, paths.signingKey, (m) => neutralizeMentions(m, allowed));
      const tree = async (rev: string) => (await git(ctx, repo, "reading a tree", "rev-parse", `${rev}^{tree}`)).stdout.trim();
      if ((await tree(head)) !== (await tree(incoming))) throw new ForgeError(`the replay of agent/${t} does not have the agent's tree`);
      // Equal when this publish replays what an earlier one pushed: nothing to push.
      if (forkHead !== null && head !== forkHead && !(await isAncestor(ctx, repo, forkHead, head))) {
        throw new RelayError(`agent/${t} does not build on the fork's agent/${t}, which is at ${shortSha(forkHead)}: nothing was published; build on what was published, never rewrite it (an earlier publish may have pushed without its answer reaching you: fetch the fork's agent/${t} anonymously)`);
      }

      // The commits about to be pushed, as CI will scan them, with main's ignore file.
      const ignoreText = await fileAt(ctx, repo, upstreamMain, ".betterleaksignore");
      const found = await scanCommits(ctx, repo, `${since ?? upstreamMain}..${head}`, ignoreText, upstreamMain);
      if (found.length > 0) {
        throw new RelayError([
          `Betterleaks found ${found.length === 1 ? "a possible secret" : `${found.length} possible secrets`} in agent/${t}:`,
          ...found.map((f) => `  ${f.rule} in ${f.file}:${f.line} (commit ${shortSha(f.commit)}, fingerprint ${f.fingerprint})`),
          "Nothing was published. A false positive is cleared by the maintainer: its fingerprint goes into .betterleaksignore on main.",
        ].join("\n"));
      }

      if (head !== forkHead) {
        // The cap is checked before the push, and the write counted once it is done.
        const now = d.now();
        takeWrite({ ...s, writes: [...s.writes] }, now, cfg.writesPerHour);
        // Durable before the push: if the relay dies after it, the next
        // publish recognizes the fork's head as its own.
        s.pending[t] = head;
        await save();

        // No `+` and no --force: GitHub refuses anything but a fast-forward or
        // the branch's creation. Over SSH, with the bot's push key: the token
        // is for the API only and never reaches git. GIT_SSH_COMMAND is a
        // shell string, hence the quoting; git ignores it for a pushBase that
        // is a local path (the tests').
        const pushed = await ctx.exec(gitIn(repo, "push", "--porcelain", `${paths.pushBase}${cfg.fork}.git`, `${head}:refs/heads/agent/${t}`), {
          env: { ...NO_PROMPT, GIT_SSH_COMMAND: githubSsh(paths).map(shellQuote).join(" ") },
          timeoutMs: PUSH_TIMEOUT_MS,
        });
        if (pushed.timedOut) {
          // Cut short, whatever git printed before: the push may have landed,
          // so pending stays, and the next publish recognizes the fork's head.
          throw new ForgeError(`pushing agent/${t} to the fork failed: it did not finish within ${PUSH_TIMEOUT_MS / 1000} s`);
        }
        if (pushed.code !== 0) {
          const refusal = pushRefusal(pushed.stdout, t);
          if (refusal !== null) {
            delete s.pending[t];
            await save();
            throw new RelayError(refusal);
          }
          // Not refused, failed: the push may have landed, so pending stays.
          throw new ForgeError(`pushing agent/${t} to the fork failed: ${oneLine(pushed.stderr)}`);
        }
        // Recorded at once: whatever fails after this, the fork's head is the relay's.
        s.published[t] = head;
        delete s.pending[t];
        takeWrite(s, now, cfg.writesPerHour);
        await save();
      }
      s.published[t] = head;
      return await answer(head, since ?? upstreamMain);
    } catch (e) {
      // Best effort: the failure is what the agent must hear, and a ref left
      // behind is forgotten by this task's next publish, which replaces it.
      if (fetchedIncoming) await ctx.exec(gitIn(repo, "update-ref", "-d", ref("incoming", t))).catch(() => {});
      throw e;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}
