// The relay's replay: the agent's commits re-created as the bot's signed
// commits, on the same trees, with merges kept as merges. `forge ship`'s
// replay cherry-picks, which cannot keep a merge of origin/main.
import { mustSucceed, type Context } from "../context.ts";
import { RelayError } from "./config.ts";

// Every git command of the relay runs without hooks: the repository is the
// relay's mirror, and its objects come from the dev VM.
export const gitIn = (repo: string, ...args: string[]): string[] => ["git", "-C", repo, "-c", "core.hooksPath=/dev/null", ...args];

export const shortSha = (sha: string): string => sha.slice(0, 12);

// Dates are raw, `<epoch> <tz>`, as git writes them in the object and as
// GIT_AUTHOR_DATE and GIT_COMMITTER_DATE accept them back.
export type CommitMeta = {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
};

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// `Name <email> <epoch> <tz>`, the form fsck accepts: neither part holds `<` or `>`.
const IDENT = /^([^<>\n]*) <([^<>\n]*)> (\d+ [+-]\d{4})$/;

// Reads a commit object. A header that is missing, repeated or malformed
// refuses the commit: what the checks read must be what GitHub shows.
export async function readCommit(ctx: Context, repo: string, sha: string): Promise<CommitMeta> {
  if (!SHA.test(sha)) throw new Error(`readCommit: not a commit ID: ${sha}`);
  const raw = (await mustSucceed(`git cat-file commit ${shortSha(sha)}`, ctx.exec(gitIn(repo, "cat-file", "commit", sha)))).stdout;
  // The headers end at the first blank line; a commit may have no message at
  // all. A line starting with a space continues a header (gpgsig, mergetag).
  const end = raw.indexOf("\n\n");
  const headers = (end === -1 ? raw : raw.slice(0, end)).split("\n").filter((l) => l !== "" && !l.startsWith(" "));
  const values = (key: string) => headers.filter((l) => l.startsWith(`${key} `)).map((l) => l.slice(key.length + 1));
  const one = (key: string, re: RegExp): RegExpExecArray => {
    const v = values(key);
    const m = v.length === 1 ? re.exec(v[0]) : null;
    if (m === null) throw new RelayError(`commit ${shortSha(sha)} has a malformed ${key} header`);
    return m;
  };
  const parents = values("parent");
  if (parents.some((p) => !SHA.test(p))) throw new RelayError(`commit ${shortSha(sha)} has a malformed parent header`);
  const author = one("author", IDENT);
  const committer = one("committer", IDENT);
  return {
    sha,
    tree: one("tree", SHA)[0],
    parents,
    authorName: author[1],
    authorEmail: author[2],
    authorDate: author[3],
    committerName: committer[1],
    committerEmail: committer[2],
    committerDate: committer[3],
    message: end === -1 ? "" : raw.slice(end + 2),
  };
}

// Re-creates `commits` (oldest first, each after its parents) signed with the
// SSH key at `signingKey`, and returns the new tip. A parent among the commits
// becomes its replayed commit; any other parent (upstream main, the published
// head) stays. Each commit keeps the agent's identities and dates, so the same
// commits replay to the same IDs: an Ed25519 signature is deterministic. The
// Betterleaks fingerprint of a false positive, which names the commit, then
// still holds at the next attempt and in CI.
export async function replaySigned(
  ctx: Context, repo: string, commits: CommitMeta[], signingKey: string, rewrite: (message: string) => string,
): Promise<string> {
  if (commits.length === 0) throw new Error("replaySigned: no commit to replay");
  const ours = new Set(commits.map((c) => c.sha));
  const replayed = new Map<string, string>();
  for (const c of commits) {
    const parents = c.parents.map((p) => {
      if (!ours.has(p)) return p;
      const mapped = replayed.get(p);
      // Keeping the original parent would publish the agent's unsigned commit.
      if (mapped === undefined) throw new Error(`replaySigned: commit ${shortSha(c.sha)} comes before its parent ${shortSha(p)}`);
      return mapped;
    });
    // commit-tree takes the message as it is: no cleanup, no hook.
    const r = await mustSucceed(`signing commit ${shortSha(c.sha)}`, ctx.exec(
      gitIn(repo, "-c", "gpg.format=ssh", "-c", `user.signingKey=${signingKey}`,
        "commit-tree", c.tree, "-S", ...parents.flatMap((p) => ["-p", p]), "-F", "-"),
      {
        input: rewrite(c.message),
        env: {
          GIT_AUTHOR_NAME: c.authorName, GIT_AUTHOR_EMAIL: c.authorEmail, GIT_AUTHOR_DATE: c.authorDate,
          GIT_COMMITTER_NAME: c.committerName, GIT_COMMITTER_EMAIL: c.committerEmail, GIT_COMMITTER_DATE: c.committerDate,
        },
      },
    ));
    replayed.set(c.sha, r.stdout.trim());
  }
  return replayed.get(commits[commits.length - 1].sha)!;
}
