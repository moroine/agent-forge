import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelayConfig, RelayError } from "../cli/lib/relay/config.ts";
import type { GitHub } from "../cli/lib/relay/github.ts";
import { RELAY_PATHS } from "../cli/lib/relay/paths.ts";
import { publish, type RelayDeps } from "../cli/lib/relay/publish.ts";
import { takeWrite, withState, type RelayState } from "../cli/lib/relay/state.ts";
import { git, hybridContext } from "./lib/git-layout.ts";
import type { FakeContext } from "./lib/fake-context.ts";

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
const TOKEN = "ghp_relay-test-token-0123456789";
const fakeBetterleaks = path.join(import.meta.dirname, "fixtures", "fake-betterleaks");

// The fake GitHub knows the fork, so ensureFork finds it.
const github: GitHub = {
  async request(method, p) {
    if (method === "GET" && p === `/repos/${cfg.fork}`) {
      return { status: 200, headers: new Headers(), json: { fork: true, parent: { full_name: cfg.upstream } }, text: "" };
    }
    return { status: 599, headers: new Headers(), json: null, text: "" };
  },
};

let root: string;
let githubBase: string;
let upstream: string;
let fork: string;
let dev: string;
let blLog: string;
let blEnv: Record<string, string>;
let ctx: FakeContext;
let n = 0;

// Every command the relay runs gets the fake Betterleaks first on its PATH,
// and the validation variables the relay must remove before a scan.
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-relay-publish-")));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(fakeBetterleaks, path.join(bin, "betterleaks"));
  blLog = path.join(root, "betterleaks.log");
  blEnv = { PATH: `${bin}:${process.env.PATH}`, FAKE_BL_LOG: blLog, BETTERLEAKS_VALIDATE: "true", BETTERLEAKS_ANALYZE: "true" };
  ctx = hybridContext();
  const exec = ctx.exec;
  ctx.exec = (argv, o) => exec(argv, { ...o, env: { ...blEnv, ...o?.env } });

  // GitHub: upstream main holds an ignore file; the fork starts empty.
  githubBase = path.join(root, "github");
  upstream = path.join(githubBase, "acme", "widgets.git");
  fork = path.join(githubBase, "bot", "widgets.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", fork]);
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  fs.writeFileSync(path.join(seed, "README"), "seed\n");
  fs.writeFileSync(path.join(seed, ".betterleaksignore"), "# main-entry\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=Maint", "-c", "user.email=maint@example.com", "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", upstream, "main");

  // The dev VM's clone, where the agent commits as the bot.
  dev = path.join(root, "dev");
  execFileSync("git", ["clone", "-q", upstream, dev], { stdio: "ignore" });
  git(dev, "config", "user.name", cfg.botName);
  git(dev, "config", "user.email", cfg.botEmail);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// A relay as the role lays it out: its mirror, state, signing key and token.
function relay(name = "relay"): RelayDeps {
  const dir = path.join(root, name);
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const mirror = path.join(dir, "mirror.git");
  execFileSync("git", ["init", "-q", "--bare", mirror]);
  git(mirror, "config", "transfer.fsckObjects", "true");
  git(mirror, "config", "core.hooksPath", "/dev/null");
  const signingKey = path.join(dir, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", signingKey]);
  const token = path.join(dir, "github-token");
  fs.writeFileSync(token, `${TOKEN}\n`, { mode: 0o600 });
  return {
    ctx, cfg, github,
    paths: { ...RELAY_PATHS, token, signingKey, mirror, stateDir, audit: path.join(dir, "audit.log"), githubBase },
    sleep: async () => {},
    now: () => Date.now(),
  };
}

const exists = (repo: string, ref: string): boolean => {
  try {
    git(repo, "rev-parse", "-q", "--verify", ref);
    return true;
  } catch {
    return false;
  }
};
const forkHead = (t: string): string | null => (exists(fork, `refs/heads/agent/${t}`) ? git(fork, "rev-parse", `refs/heads/agent/${t}`) : null);
const tree = (repo: string, rev: string): string => git(repo, "rev-parse", `${rev}^{tree}`);
const stateOf = (d: RelayDeps): RelayState => {
  const file = path.join(d.paths.stateDir, "state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { published: {}, writes: [] };
};

// One commit of `file` on agent/<t> in the dev clone, which is created from
// `from` (origin/main by default) when it does not exist.
function work(t: string, file: string, o: { content?: string; from?: string } = {}): string {
  const branch = `agent/${t}`;
  git(dev, "checkout", "-q", ...(exists(dev, `refs/heads/${branch}`) ? [branch] : ["-b", branch, o.from ?? "origin/main"]));
  fs.writeFileSync(path.join(dev, file), o.content ?? `${file} ${++n}\n`);
  git(dev, "add", file);
  git(dev, "commit", "-q", "-m", `add ${file}`);
  return git(dev, "rev-parse", "HEAD");
}

// The client's bundle: agent/<t> without what origin/main and the fork already have.
function bundle(t: string, ...extra: string[]): Buffer {
  const file = path.join(root, `bundle-${++n}`);
  const published = exists(dev, `refs/remotes/fork/agent/${t}`) ? [`^refs/remotes/fork/agent/${t}`] : [];
  git(dev, "bundle", "create", "-q", file, `refs/heads/agent/${t}`, ...extra, "^refs/remotes/origin/main", ...published);
  return fs.readFileSync(file);
}

// What the client does with the answer: fetch the published head, then move
// the agent's branch onto it (the same tree).
function align(t: string, answer: { head: string; bundle: Buffer }): void {
  const file = path.join(root, `answer-${++n}`);
  fs.writeFileSync(file, answer.bundle);
  git(dev, "fetch", "-q", file, `+refs/relay/published/agent/${t}:refs/remotes/fork/agent/${t}`);
  git(dev, "update-ref", `refs/heads/agent/${t}`, answer.head);
}

const refused = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e) => {
    assert.ok(e instanceof RelayError, String(e));
    assert.match(e.message, re);
    return true;
  });

test("publishes a new branch: signed commits on the fork, the agent's tree, recorded", async () => {
  const d = relay();
  work("t", "a.txt");
  const tip = work("t", "b.txt", { content: "hello @someone\n" });
  const res = await publish(d, { branch: "agent/t", bundle: bundle("t") });

  assert.equal(forkHead("t"), res.head);
  assert.equal(tree(fork, res.head), tree(dev, tip));
  const main = git(upstream, "rev-parse", "main");
  const published = git(fork, "rev-list", res.head, `^${main}`).split("\n");
  assert.equal(published.length, 2);
  for (const c of published) {
    const raw = git(fork, "cat-file", "commit", c);
    assert.match(raw, /^gpgsig /m);
    assert.match(raw, new RegExp(`^author ${cfg.botName} <${cfg.botEmail.replace(/[.+]/g, "\\$&")}>`, "m"));
  }
  assert.deepEqual(stateOf(d).published, { t: res.head });
  assert.equal(res.url, "https://github.com/bot/widgets/tree/agent/t");
  // The scan covered the signed commits about to be pushed.
  assert.match(fs.readFileSync(blLog, "utf8"), new RegExp(`--log-opts=--diff-merges=remerge ${main}\\.\\.${res.head}`));

  // The answer's bundle carries the published head under its relay ref.
  align("t", res);
  assert.equal(git(dev, "rev-parse", "refs/remotes/fork/agent/t"), res.head);
  assert.equal(git(dev, "status", "--porcelain"), "");

  // The token reached git only through its environment, and only for the push.
  assert.ok(!ctx.calls.some((argv) => argv.join(" ").includes(TOKEN)));
  const withHeader = ctx.execOptions.flatMap((o, i) => (o?.env?.GIT_CONFIG_VALUE_0 ? [ctx.calls[i]] : []));
  assert.deepEqual(withHeader.map((argv) => argv.includes("push")), [true]);
  const push = ctx.calls.findIndex((argv) => argv.includes("push"));
  assert.equal(ctx.execOptions[push]?.env?.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(ctx.execOptions[push]?.env?.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
  assert.ok(!ctx.calls[push].some((a) => a.startsWith("+") || a === "--force" || a === "-f"));
});

test("a second publish replays only the new commits and fast-forwards", async () => {
  const d = relay();
  work("t", "a.txt");
  const first = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  const tip = work("t", "c.txt");
  const second = await publish(d, { branch: "agent/t", bundle: bundle("t") });

  assert.equal(git(fork, "rev-parse", `${second.head}^`), first.head);
  assert.equal(forkHead("t"), second.head);
  assert.equal(tree(fork, second.head), tree(dev, tip));
  assert.deepEqual(stateOf(d).published, { t: second.head });
  assert.match(fs.readFileSync(blLog, "utf8"), new RegExp(`remerge ${first.head}\\.\\.${second.head}`));
});

test("refuses when the fork's branch moved since the relay published it", async () => {
  const d = relay();
  work("t", "a.txt");
  const first = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  // Someone pushes to the bot's branch by hand.
  const theirs = git(fork, "-c", "user.name=Maint", "-c", "user.email=maint@example.com", "commit-tree", `${first.head}^{tree}`, "-p", first.head, "-m", "suggestion");
  git(fork, "update-ref", "refs/heads/agent/t", theirs);
  work("t", "b.txt");

  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /moved since the relay published it/);
  assert.equal(forkHead("t"), theirs);
  assert.deepEqual(stateOf(d).published, { t: first.head });
});

test("adopts an unrecorded fork branch of the bot's commits, refuses one with another author", async () => {
  work("t", "a.txt");
  const first = await publish(relay("old"), { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  // The relay is rebuilt: a new mirror, no state.
  const d = relay("new");
  const tip = work("t", "b.txt");
  const res = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  assert.equal(git(fork, "rev-parse", `${res.head}^`), first.head);
  assert.equal(tree(fork, res.head), tree(dev, tip));
  assert.deepEqual(stateOf(d).published, { t: res.head });

  // A branch holding someone else's commit is not adopted.
  const main = git(upstream, "rev-parse", "main");
  const theirs = git(fork, "-c", "user.name=Someone", "-c", "user.email=someone@example.com", "commit-tree", `${main}^{tree}`, "-p", main, "-m", "x");
  git(fork, "update-ref", "refs/heads/agent/u", theirs);
  work("u", "c.txt");
  await refused(publish(d, { branch: "agent/u", bundle: bundle("u") }), /not the bot/);
  assert.equal(forkHead("u"), theirs);
  assert.equal(stateOf(d).published.u, undefined);
});

test("a Betterleaks finding refuses the publish and pushes nothing", async () => {
  const d = relay();
  blEnv.FAKE_BL_FIND = "1";
  work("t", "a.txt");
  await refused(
    publish(d, { branch: "agent/t", bundle: bundle("t") }),
    /generic-api-key in secret\.txt:3 \(commit 0123456789ab, fingerprint 0123456789abcdef0123456789abcdef01234567:secret\.txt:generic-api-key:3\)[\s\S]*Nothing was published\. A false positive is cleared by the maintainer/,
  );
  assert.equal(forkHead("t"), null);
  assert.deepEqual(stateOf(d), { published: {}, writes: [] });
});

test("the scan reads upstream main's .betterleaksignore, never the branch's", async () => {
  const d = relay();
  // main's file holds "main-entry", the branch changes it to hold "branch-entry".
  work("t", ".betterleaksignore", { content: "# branch-entry\n" });
  await publish(d, { branch: "agent/t", bundle: bundle("t") });
  const log = fs.readFileSync(blLog, "utf8");
  assert.match(log, /main-entry/);
  assert.doesNotMatch(log, /branch-entry/);
});

test("a bundle's other refs are ignored", async () => {
  const d = relay();
  work("t", "a.txt");
  // The dev VM's own main moved, and the bundle carries it too.
  git(dev, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dev, "evil.txt"), "evil\n");
  git(dev, "add", "evil.txt");
  git(dev, "commit", "-q", "-m", "evil");
  const evil = git(dev, "rev-parse", "main");
  const main = git(upstream, "rev-parse", "main");

  await publish(d, { branch: "agent/t", bundle: bundle("t", "refs/heads/main") });
  assert.equal(git(d.paths.mirror, "rev-parse", "refs/relay/upstream/main"), main);
  const refs = git(d.paths.mirror, "for-each-ref", "--format=%(objectname) %(refname)");
  assert.doesNotMatch(refs, new RegExp(evil));
  assert.doesNotMatch(refs, / refs\/heads\//);
  assert.equal(git(upstream, "rev-parse", "main"), main);
});

test("a bundle whose objects fail git's checks is refused", async () => {
  const d = relay();
  // A tree with a .git entry: a checkout would write into the repository itself.
  const blob = execFileSync("git", ["-C", dev, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8" }).trim();
  const bad = execFileSync("git", ["-C", dev, "mktree"], { input: `100644 blob ${blob}\t.git\n`, encoding: "utf8" }).trim();
  git(dev, "update-ref", "refs/heads/agent/t", git(dev, "commit-tree", bad, "-p", "origin/main", "-m", "x"));
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /could not be fetched/);
  assert.equal(exists(d.paths.mirror, "refs/relay/incoming/agent/t"), false);
  assert.equal(forkHead("t"), null);
});

test("a branch that names a blob is refused and leaves nothing that breaks the next publish", async () => {
  const d = relay();
  // git refuses a branch on a blob, so the bundle's header is written by hand.
  const blob = execFileSync("git", ["-C", dev, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8" }).trim();
  git(dev, "tag", "blob", blob);
  const file = path.join(root, "blob-bundle");
  git(dev, "bundle", "create", "-q", file, "refs/tags/blob");
  const raw = fs.readFileSync(file);
  const header = raw.subarray(0, raw.indexOf("\n\n") + 2).toString("latin1").replace("refs/tags/blob", "refs/heads/agent/x");
  await refused(publish(d, { branch: "agent/x", bundle: Buffer.concat([Buffer.from(header, "latin1"), raw.subarray(raw.indexOf("\n\n") + 2)]) }), /not a commit/);
  assert.equal(exists(d.paths.mirror, "refs/relay/incoming/agent/x"), false);
  work("t", "a.txt");
  const res = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  assert.equal(forkHead("t"), res.head);
});

test("a rejected push records nothing", async () => {
  const d = relay();
  fs.writeFileSync(path.join(fork, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  work("t", "a.txt");
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /moved during the publish/);
  assert.equal(forkHead("t"), null);
  assert.deepEqual(stateOf(d), { published: {}, writes: [] });
  assert.equal(exists(d.paths.mirror, "refs/relay/published/agent/t"), false);
});

test("refuses a task built on another task, published or only sent", async () => {
  const d = relay();
  const original = work("u", "u.txt");
  const u = await publish(d, { branch: "agent/u", bundle: bundle("u") });
  align("u", u);
  // t starts from u as the fork has it.
  work("t", "t.txt", { from: "agent/u" });
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /no stacked tasks/);
  // s starts from u's unsigned original, which the mirror still holds as what u sent.
  work("s", "s.txt", { from: original });
  await refused(publish(d, { branch: "agent/s", bundle: bundle("s") }), /no stacked tasks/);
  assert.equal(forkHead("t"), null);
  assert.equal(forkHead("s"), null);
  assert.deepEqual(stateOf(d).published, { u: u.head });
});

test("refuses more than 200 commits before reading any of them", async () => {
  const d = relay();
  // 201 empty commits of the bot on agent/t, in one fast-import stream.
  let stream = "";
  for (let i = 1; i <= 201; i++) {
    stream += `commit refs/heads/agent/t\ncommitter ${cfg.botName} <${cfg.botEmail}> ${1767225600 + i} +0000\ndata 3\nc${i % 10}\n`;
    if (i === 1) stream += `from ${git(dev, "rev-parse", "origin/main")}\n`;
    stream += "\n";
  }
  execFileSync("git", ["-C", dev, "fast-import", "--quiet"], { input: stream });
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /more than 200 commits/);
  assert.ok(!ctx.calls.some((argv) => argv.includes("cat-file") && argv.includes("commit")));
  assert.equal(forkHead("t"), null);
});

test("takeWrite refuses past the hourly cap", () => {
  const s: RelayState = { published: {}, writes: [] };
  takeWrite(s, 0, 2);
  takeWrite(s, 60_000, 2);
  assert.throws(() => takeWrite(s, 120_000, 2), (e) => e instanceof RelayError && /write cap/.test(e.message));
  takeWrite(s, 3_600_000, 2);
  assert.deepEqual(s.writes, [60_000, 3_600_000]);
});

test("withState removes a lock older than 15 minutes", async () => {
  const dir = path.join(root, "state");
  fs.mkdirSync(path.join(dir, "lock"), { recursive: true });
  const old = new Date(Date.now() - 16 * 60_000);
  fs.utimesSync(path.join(dir, "lock"), old, old);
  const started = Date.now();
  assert.equal(await withState(dir, async () => "ran"), "ran");
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(path.join(dir, "lock")), false);
});

test("two withState calls at once run one after the other", async () => {
  const dir = path.join(root, "state");
  fs.mkdirSync(dir);
  let counter = 0;
  const bump = () =>
    withState(dir, async (s) => {
      const read = counter;
      await new Promise((r) => setTimeout(r, 150));
      counter = read + 1;
      s.writes.push(counter);
    });
  await Promise.all([bump(), bump()]);
  assert.equal(counter, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).writes, [1, 2]);
});
