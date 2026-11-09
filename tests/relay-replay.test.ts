import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelayConfig, RelayError } from "../cli/lib/relay/config.ts";
import { checkAuthorship, checkCommits, validTask } from "../cli/lib/relay/policy.ts";
import { readCommit, replaySigned } from "../cli/lib/relay/replay.ts";
import { git, hybridContext } from "./lib/git-layout.ts";

const cfg = parseRelayConfig({
  upstream: "acme/widgets",
  fork: "bot/widgets",
  botLogin: "bot",
  botName: "Bot",
  botEmail: "1+bot@users.noreply.github.com",
  trustedLogins: ["maint"],
  coAuthorEmails: ["noreply@anthropic.com"],
  writesPerHour: 20,
});
type Ident = { name: string; email: string };
const bot: Ident = { name: cfg.botName, email: cfg.botEmail };
const ctx = hybridContext();
const id = (m: string) => m;

let root: string;
let repo: string;
let key: string;
let main0: string;
let n = 0;

// Runs git in the repository as `author` and `committer` (the bot unless
// given), at a date of the past that differs for each call: a replay that
// lost the original dates would show.
function gitAs(args: string[], who: { author?: Ident; committer?: Ident } = {}): string {
  const a = who.author ?? bot;
  const c = who.committer ?? bot;
  const at = 1767225600 + ++n * 60;
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: `${at} +0100`,
      GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: `${at + 7} -0530`,
    },
  });
}

// One commit adding a new file on `branch`, which is created from `from` when given.
function commit(branch: string, o: { from?: string; message?: string; author?: Ident; committer?: Ident } = {}): string {
  git(repo, "checkout", "-q", ...(o.from ? ["-b", branch, o.from] : [branch]));
  const file = `f${n}`;
  fs.writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, "add", file);
  gitAs(["commit", "-q", "-m", o.message ?? `add ${file}`], o);
  return git(repo, "rev-parse", "HEAD");
}

function merge(branch: string, other: string): string {
  git(repo, "checkout", "-q", branch);
  gitAs(["merge", "--no-ff", "-q", "-m", `Merge ${other}`, other]);
  return git(repo, "rev-parse", "HEAD");
}

// The commits a publish brings, oldest first, as the relay reads them.
const commitsOf = (tip: string, ...not: string[]) =>
  Promise.all(git(repo, "rev-list", "--topo-order", "--reverse", tip, ...not.map((x) => `^${x}`)).split("\n").map((s) => readCommit(ctx, repo, s)));

// Checks the branch at `tip` against upstream main; `not` leaves commits out of
// those it brings, as the relay does with what is already published.
async function check(tip: string, o: { base?: string; not?: string[] } = {}) {
  const upstreamMain = git(repo, "rev-parse", "main");
  const commits = await commitsOf(tip, upstreamMain, ...(o.base ? [o.base] : []), ...(o.not ?? []));
  await checkCommits(ctx, repo, { commits, tip, upstreamMain, base: o.base ?? null, cfg });
}

const refused = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e) => {
    assert.ok(e instanceof RelayError, String(e));
    assert.match(e.message, re);
    return true;
  });

// A on main0, a merge of main1, B: the agent's branch as it reaches the relay.
async function mergedBranch() {
  commit("agent", { from: main0 });
  const main1 = commit("main");
  merge("agent", "main");
  commit("agent");
  return { main1, commits: await commitsOf("agent", main1) };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-relay-replay-")));
  repo = path.join(root, "mirror");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  key = path.join(root, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key]);
  fs.writeFileSync(path.join(repo, "README"), "seed\n");
  git(repo, "add", "README");
  gitAs(["commit", "-q", "-m", "seed"]);
  main0 = git(repo, "rev-parse", "HEAD");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("validTask", () => {
  assert.equal(validTask("agent/fix-1.2_x"), "fix-1.2_x");
  for (const b of ["agent/", "agent/a..b", "agent/.x", "agent/x.lock", "agent/x.", "agent/a/b", "main", "refs/heads/agent/x"])
    assert.throws(() => validTask(b), RelayError, b);
});

test("a merge of upstream main is replayed as a merge, signed, with the same tree", async () => {
  const { main1, commits } = await mergedBranch();
  await checkCommits(ctx, repo, { commits, tip: git(repo, "rev-parse", "agent"), upstreamMain: main1, base: null, cfg });
  const tip = await replaySigned(ctx, repo, commits, key, (m) => `[relay] ${m}`);
  assert.equal(git(repo, "rev-parse", `${tip}^{tree}`), git(repo, "rev-parse", "agent^{tree}"));
  assert.equal(git(repo, "rev-parse", `${tip}^^2`), main1);
  for (const c of git(repo, "rev-list", tip, `^${main1}`).split("\n")) assert.match(git(repo, "cat-file", "commit", c), /^gpgsig /m);
  // The identities and dates are the agent's, which makes the replay reproducible; the message is rewritten.
  const meta = (c: string) => git(repo, "log", "-1", "--date=raw", "--format=%an %ae %ad %cn %ce %cd", c);
  assert.equal(meta(tip), meta("agent"));
  assert.equal(git(repo, "log", "-1", "--format=%s", tip), `[relay] ${git(repo, "log", "-1", "--format=%s", "agent")}`);
});

test("replaying twice gives the same commits", async () => {
  // The relay's Betterleaks fingerprints name commits: they must match those of CI, and of the next attempt.
  const { commits } = await mergedBranch();
  assert.equal(await replaySigned(ctx, repo, commits, key, id), await replaySigned(ctx, repo, commits, key, id));
});

test("refuses an author or a committer that is not the bot", async () => {
  const author = commit("a", { from: main0, author: { name: cfg.botName, email: "bot@example.com" } });
  await refused(check(author), /author/);
  const meta = await readCommit(ctx, repo, author);
  assert.throws(() => checkAuthorship(meta, cfg), /author/);
  await refused(check(commit("c", { from: main0, committer: { name: "Someone", email: cfg.botEmail } })), /committer/);
});

test("refuses a Co-authored-by outside the list, any case accepted", async () => {
  await check(commit("ok", { from: main0, message: "x\n\nco-authored-by: X <NoReply@Anthropic.com>" }));
  await refused(check(commit("bad", { from: main0, message: "x\n\nCo-Authored-By: Evil <evil@example.com>" })), /co-author/i);
  // Outside git's trailer block (GitHub does not parse as git does), and folded onto a second line.
  await refused(check(commit("prose", { from: main0, message: "x\n\nCo-authored-by: Evil <evil@example.com>\nmore text\nand more" })), /co-author/i);
  await refused(check(commit("folded", { from: main0, message: "x\n\nCo-authored-by: X <noreply@anthropic.com>\n <evil@example.com>" })), /co-author/i);
});

test("refuses a branch built on another task", async () => {
  // The other task's commit is not among those this publish brings, as when it was published.
  const other = commit("agent/u", { from: main0 });
  await refused(check(commit("agent/t", { from: other }), { not: [other] }), /no stacked tasks/);
  // Nor a history of its own: a commit without a parent.
  await refused(check(gitAs(["commit-tree", `${main0}^{tree}`, "-m", "root"]).trim()), /no parent/);
});

test("refuses a merge of anything but upstream main", async () => {
  commit("agent", { from: main0 });
  const side = commit("side", { from: main0 });
  await refused(check(merge("agent", side)), /only merges of origin\/main/);
});

test("refuses a commit message that refers to another repository", () =>
  refused(check(commit("agent", { from: main0, message: "fix: as in other/repo#3" })), /another repository/));

test("refuses a tip that does not descend from the published head", async () => {
  const published = commit("agent", { from: main0 });
  await refused(check(commit("rewritten", { from: main0 }), { base: published }), /not a fast-forward/);
  await check(commit("agent"), { base: published });
});
