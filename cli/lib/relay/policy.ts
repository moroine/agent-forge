// What the relay agrees to publish: a task branch's name, and commits that are
// the bot's, start from upstream main and only merge upstream main. All of it
// comes from the dev VM, so every check refuses what it cannot read as allowed,
// naming the commit by its short SHA (its subject is the agent's text).
import { mustSucceed, ForgeError, type Context } from "../context.ts";
import { printable } from "../printable.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { gitIn, shortSha, type CommitMeta } from "./replay.ts";
import { crossReferences } from "./text.ts";

const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_COMMITS = 200;

// agent/<task> → <task>: one ref component that git accepts (no `..`, no
// trailing `.lock` or `.`) and that cannot leave refs/heads/agent/.
export function validTask(branch: string): string {
  const task = branch.startsWith("agent/") ? branch.slice("agent/".length) : "";
  if (!TASK.test(task) || task.includes("..") || task.endsWith(".lock") || task.endsWith(".")) {
    throw new RelayError("the branch must be agent/<task>, where <task> starts with a letter or a digit and holds at most 100 letters, digits, '.', '_' or '-'");
  }
  return task;
}

// A co-author is `Name <email>`, with one of the configured emails in any case.
function checkCoAuthor(c: CommitMeta, value: string, cfg: RelayConfig): void {
  const email = /^[^<>]*<([^<>]+)>$/.exec(value.trim())?.[1];
  if (email === undefined || !cfg.coAuthorEmails.some((e) => e.toLowerCase() === email.toLowerCase())) {
    throw new RelayError(`commit ${shortSha(c.sha)} names a co-author outside the allowed list (Co-authored-by: ${printable(value.trim())}); allowed emails: ${cfg.coAuthorEmails.join(", ") || "none"}`);
  }
}

// The author and the committer are the bot, and every line that reads as a
// Co-authored-by names an allowed email. The lines are read anywhere in the
// message, not only in git's trailer block: GitHub's parser is not git's, and
// a line it might credit must not get through.
export function checkAuthorship(c: CommitMeta, cfg: RelayConfig): void {
  for (const [role, name, email] of [["author", c.authorName, c.authorEmail], ["committer", c.committerName, c.committerEmail]]) {
    if (name !== cfg.botName || email !== cfg.botEmail) {
      throw new RelayError(`commit ${shortSha(c.sha)}: its ${role}, ${printable(name)} <${printable(email)}>, is not the bot (${cfg.botName} <${cfg.botEmail}>)`);
    }
  }
  // [\s\S], not `.`: a U+2028 in the value must not stop the match.
  for (const line of c.message.split(/[\r\n]/)) {
    const m = /^\s*co-authored-by\s*:([\s\S]*)$/i.exec(line);
    if (m) checkCoAuthor(c, m[1], cfg);
  }
}

// The Co-authored-by trailers as git reads a commit message: a `---` line does
// not end it (--no-divider), and a value folded onto several lines is joined,
// which a line-by-line reading would cut.
async function coAuthorTrailers(ctx: Context, repo: string, message: string): Promise<string[]> {
  const r = await mustSucceed("git interpret-trailers", ctx.exec(gitIn(repo, "interpret-trailers", "--parse", "--no-divider"), { input: message }));
  return r.stdout.split("\n").flatMap((l) => {
    const m = /^co-authored-by\s*:([\s\S]*)$/i.exec(l);
    return m ? [m[1]] : [];
  });
}

async function isAncestor(ctx: Context, repo: string, ancestor: string, of: string): Promise<boolean> {
  const r = await ctx.exec(gitIn(repo, "merge-base", "--is-ancestor", ancestor, of));
  if (r.code > 1) throw new ForgeError(`git merge-base failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  return r.code === 0;
}

// `commits` are those the publish brings (not on upstream main, not yet
// published), `tip` the branch's head, `upstreamMain` upstream's main and
// `base` the fork's published head (null for a first publish), all commit IDs.
export async function checkCommits(
  ctx: Context, repo: string,
  o: { commits: CommitMeta[]; tip: string; upstreamMain: string; base: string | null; cfg: RelayConfig },
): Promise<void> {
  const { commits, tip, upstreamMain, base, cfg } = o;
  if (commits.length > MAX_COMMITS) throw new RelayError(`this publish brings ${commits.length} commits, more than ${MAX_COMMITS}: squash some of them`);
  if (base !== null && !(await isAncestor(ctx, repo, base, tip))) {
    throw new RelayError(`the branch is not a fast-forward of the published branch (${shortSha(base)}): build on what was published, never rewrite it`);
  }
  const brought = new Set(commits.map((c) => c.sha));
  for (const c of commits) {
    checkAuthorship(c, cfg);
    for (const value of await coAuthorTrailers(ctx, repo, c.message)) checkCoAuthor(c, value, cfg);
    // A commit without a parent starts a history of its own, not upstream main's.
    if (c.parents.length === 0) throw new RelayError(`commit ${shortSha(c.sha)} has no parent: start every task from origin/main`);
    // The only merge the agent may make is `git merge origin/main`: its second
    // parent is on upstream main. Checked before the parents, which would
    // otherwise call a merge of another task a stacked task.
    if (c.parents.length > 2) throw new RelayError(`commit ${shortSha(c.sha)} merges more than one branch: only merges of origin/main are published`);
    if (c.parents.length === 2 && !(await isAncestor(ctx, repo, c.parents[1], upstreamMain))) {
      throw new RelayError(`commit ${shortSha(c.sha)} merges ${shortSha(c.parents[1])}: only merges of origin/main are published`);
    }
    for (const p of c.parents) {
      if (brought.has(p) || p === base || (await isAncestor(ctx, repo, p, upstreamMain))) continue;
      throw new RelayError(`commit ${shortSha(c.sha)} builds on ${shortSha(p)}, which is neither upstream main nor this branch as published: start every task from origin/main (no stacked tasks)`);
    }
    const refs = crossReferences(c.message, cfg.upstream);
    if (refs.length > 0) {
      throw new RelayError(`commit ${shortSha(c.sha)}'s message refers to another repository (${refs.join(", ")}): only ${cfg.upstream} may be referenced`);
    }
  }
}
