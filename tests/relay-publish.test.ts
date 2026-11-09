import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult } from "../cli/lib/context.ts";
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
// A test may stand between the relay and a command: to fail it, or to act
// around it (`run` runs it for real).
let intercept: ((argv: string[], run: () => Promise<ExecResult>) => Promise<ExecResult>) | null;
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
  intercept = null;
  const exec = ctx.exec;
  ctx.exec = (argv, o) => {
    const run = () => exec(argv, { ...o, env: { ...blEnv, ...o?.env } });
    return intercept === null ? run() : intercept(argv, run);
  };

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
// The push key is never made: git ignores GIT_SSH_COMMAND for a fork that is
// a local path, as pushBase makes it here, so the push never needs it.
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
    paths: {
      ...RELAY_PATHS, token, signingKey, mirror, stateDir, audit: path.join(dir, "audit.log"), githubBase,
      pushKey: path.join(dir, "push-key"), githubKnownHosts: path.join(dir, "github-known-hosts"), pushBase: `${githubBase}/`,
    },
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
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { published: {}, pending: {}, writes: [], attempts: [] };
};
const nothingRecorded = { published: {}, pending: {}, writes: [], attempts: [] };

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
    assert.ok(raw.split("\n").some((l) => l.startsWith(`author ${cfg.botName} <${cfg.botEmail}> `)), raw);
  }
  assert.deepEqual(stateOf(d).published, { t: res.head });
  assert.equal(res.url, "https://github.com/bot/widgets/tree/agent/t");
  // The scan covered the signed commits about to be pushed.
  assert.match(fs.readFileSync(blLog, "utf8"), new RegExp(`--log-opts=--diff-merges=remerge ${main}\\.\\.${res.head}`));

  // The answer's bundle carries the published head under its relay ref.
  align("t", res);
  assert.equal(git(dev, "rev-parse", "refs/remotes/fork/agent/t"), res.head);
  assert.equal(git(dev, "status", "--porcelain"), "");

  // The token never reaches git: in no argv and no environment, and no git
  // configuration through the environment either.
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  assert.ok(!ctx.calls.some((argv) => argv.join(" ").includes(TOKEN) || argv.join(" ").includes(basic)));
  for (const o of ctx.execOptions) {
    for (const [k, v] of Object.entries(o?.env ?? {})) {
      assert.ok(!k.startsWith("GIT_CONFIG_") && !v.includes(TOKEN) && !v.includes(basic), k);
    }
  }
  // The push goes to pushBase over SSH, with the push key and GitHub's pinned
  // host keys only, and bounded in time: by ssh, and as a whole, well inside
  // the state lock's 15 minutes.
  const push = ctx.calls.findIndex((argv) => argv.includes("push"));
  assert.equal(ctx.calls[push].at(-2), `${githubBase}/bot/widgets.git`);
  assert.ok(!ctx.calls[push].some((a) => a.startsWith("+") || a === "--force" || a === "-f"));
  assert.equal(ctx.execOptions[push]?.env?.GIT_SSH_COMMAND, [
    "ssh", "-F", "/dev/null", "-i", d.paths.pushKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", `UserKnownHostsFile=${d.paths.githubKnownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
  ].map((a) => `'${a}'`).join(" "));
  assert.equal(ctx.execOptions[push]?.timeoutMs, 600_000);
  assert.equal(RELAY_PATHS.pushBase, "git@github.com:");
});

test("a push cut short by its time bound is a failed push: never taken as a refusal, its pending head kept", async () => {
  const d = relay();
  work("t", "a.txt");
  // What git printed before it was killed counts for nothing: the push may have landed.
  intercept = async (argv, run) => (argv.includes("push")
    ? { code: 124, stdout: "!\tHEAD:refs/heads/agent/t\t[rejected] (fetch first)\n", stderr: "", timedOut: true }
    : run());
  await assert.rejects(publish(d, { branch: "agent/t", bundle: bundle("t") }), (e) => {
    assert.ok(!(e instanceof RelayError), String(e));
    assert.match((e as Error).message, /^pushing agent\/t to the fork failed: it did not finish within 600 s/);
    return true;
  });
  assert.deepEqual(Object.keys(stateOf(d).pending), ["t"]);
  assert.deepEqual(stateOf(d).published, {});
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

  // A published branch deleted from the fork is told apart.
  git(fork, "update-ref", "-d", "refs/heads/agent/t");
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), new RegExp(`agent/t is gone from the fork although the relay published it at ${first.head.slice(0, 12)}`));
  assert.deepEqual(stateOf(d).published, { t: first.head });
});

test("a publish that fails after its push keeps it recorded, and its retry answers with the fork's head", async () => {
  const d = relay();
  work("t", "a.txt");
  const first = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  work("t", "b.txt");
  const sent = bundle("t");
  // The push lands, then the answer cannot be bundled: the dev VM never hears of it.
  intercept = (argv, run) => (argv.includes("bundle") && argv.includes("create") ? Promise.resolve({ code: 1, stdout: "", stderr: "simulated" }) : run());
  await assert.rejects(publish(d, { branch: "agent/t", bundle: sent }), /simulated/);
  const pushed = forkHead("t")!;
  assert.notEqual(pushed, first.head);
  assert.deepEqual(stateOf(d).published, { t: pushed });
  intercept = null;

  // The agent's branch still holds its unsigned commit: it sends it again.
  const retry = await publish(d, { branch: "agent/t", bundle: sent });
  assert.equal(retry.head, pushed);
  assert.equal(forkHead("t"), pushed);
  assert.equal(stateOf(d).writes.length, 2);
  align("t", retry);
  assert.equal(git(dev, "status", "--porcelain"), "");
});

test("a publish that dies between its push and its record is recognized by the next one", async () => {
  const d = relay();
  work("t", "a.txt");
  const first = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  work("t", "b.txt");
  const sent = bundle("t");
  intercept = async (argv, run) => {
    const r = await run();
    if (argv.includes("push")) throw new Error("the relay died");
    return r;
  };
  await assert.rejects(publish(d, { branch: "agent/t", bundle: sent }), /the relay died/);
  const pushed = forkHead("t")!;
  assert.deepEqual(stateOf(d).published, { t: first.head });
  assert.deepEqual(stateOf(d).pending, { t: pushed });
  intercept = null;

  const retry = await publish(d, { branch: "agent/t", bundle: sent });
  assert.equal(retry.head, pushed);
  assert.deepEqual(stateOf(d).published, { t: pushed });
  assert.deepEqual(stateOf(d).pending, {});
});

test("a pending head the fork never got does not block the next publish", async () => {
  const d = relay();
  work("t", "a.txt");
  const first = await publish(d, { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  work("t", "b.txt");
  const sent = bundle("t");
  // The relay dies after recording the pending head, before pushing it.
  intercept = (argv, run) => (argv.includes("push") ? Promise.reject(new Error("the relay died")) : run());
  await assert.rejects(publish(d, { branch: "agent/t", bundle: sent }), /the relay died/);
  assert.equal(forkHead("t"), first.head);
  assert.equal(Object.keys(stateOf(d).pending).length, 1);
  intercept = null;

  const second = await publish(d, { branch: "agent/t", bundle: sent });
  assert.equal(git(fork, "rev-parse", `${second.head}^`), first.head);
  assert.deepEqual(stateOf(d).published, { t: second.head });
  assert.deepEqual(stateOf(d).pending, {});
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

test("after a rebuild, a published branch with nothing new is adopted and recorded, not refused", async () => {
  work("t", "a.txt");
  const first = await publish(relay("old"), { branch: "agent/t", bundle: bundle("t") });
  align("t", first);
  const d = relay("new");
  // The client sends a branch already at the fork's head whole, from origin/main.
  const file = path.join(root, "whole.bundle");
  git(dev, "bundle", "create", "-q", file, "refs/heads/agent/t", "^refs/remotes/origin/main");
  const res = await publish(d, { branch: "agent/t", bundle: fs.readFileSync(file) });
  assert.equal(res.head, first.head);
  assert.equal(forkHead("t"), first.head);
  // Recorded, so open-pr accepts it; nothing reached GitHub, so no write counted.
  assert.deepEqual(stateOf(d).published, { t: first.head });
  assert.deepEqual(stateOf(d).writes, []);
  align("t", res);
  assert.equal(git(dev, "rev-parse", "refs/heads/agent/t"), first.head);

  // Recorded now, the same branch is nothing new.
  await refused(publish(d, { branch: "agent/t", bundle: fs.readFileSync(file) }), /nothing new to publish/);
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
  assert.deepEqual(stateOf(d), nothingRecorded);
  // The refused branch is forgotten: its objects are left to git's gc.
  assert.equal(exists(d.paths.mirror, "refs/relay/incoming/agent/t"), false);
});

test("the scans run in a fresh directory and refuse a mirror holding an ignore file", async () => {
  // Betterleaks reads one at the root of the repository it scans, on top of -i.
  const d = relay();
  work("t", "a.txt");
  fs.writeFileSync(path.join(d.paths.mirror, ".betterleaksignore"), "anything\n");
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /mirror holds a \.betterleaksignore/);
  assert.equal(forkHead("t"), null);
  fs.rmSync(path.join(d.paths.mirror, ".betterleaksignore"));
  await publish(d, { branch: "agent/t", bundle: bundle("t") });
  assert.match(fs.readFileSync(blLog, "utf8"), /^cwd: .*\/forge-relay-scan-[^/]+$/m);
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

test("a push GitHub refuses gives its reason and records nothing", async () => {
  // As GitHub's push protection would.
  const d = relay();
  fs.writeFileSync(path.join(fork, "hooks", "pre-receive"), "#!/bin/sh\necho 'push declined: a secret was found' >&2\nexit 1\n", { mode: 0o755 });
  work("t", "a.txt");
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /^GitHub refused the push of agent\/t: pre-receive hook declined\. Nothing was published\.$/);
  assert.equal(forkHead("t"), null);
  assert.deepEqual(stateOf(d), nothingRecorded);
  assert.equal(exists(d.paths.mirror, "refs/relay/published/agent/t"), false);
});

test("a push refused because the fork moved meanwhile says so and records nothing", async () => {
  const d = relay();
  work("t", "a.txt");
  // The fork's branch appears between the relay's fetch and its push.
  intercept = (argv, run) => {
    if (argv.includes("push")) {
      // The empty tree is the one object the empty fork has.
      const race = git(fork, "-c", "user.name=M", "-c", "user.email=m@example.com", "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "race");
      git(fork, "update-ref", "refs/heads/agent/t", race);
    }
    return run();
  };
  await refused(publish(d, { branch: "agent/t", bundle: bundle("t") }), /^the fork's agent\/t moved during the publish$/);
  assert.deepEqual(stateOf(d), nothingRecorded);
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
  // The refused tasks' branches are forgotten, the published one's is kept.
  assert.equal(exists(d.paths.mirror, "refs/relay/incoming/agent/t"), false);
  assert.equal(exists(d.paths.mirror, "refs/relay/incoming/agent/s"), false);
  assert.equal(git(d.paths.mirror, "rev-parse", "refs/relay/incoming/agent/u"), original);
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
  const s: RelayState = { published: {}, pending: {}, writes: [], attempts: [] };
  takeWrite(s, 0, 2);
  takeWrite(s, 60_000, 2);
  assert.throws(() => takeWrite(s, 120_000, 2), (e) => e instanceof RelayError && /write cap/.test(e.message));
  takeWrite(s, 3_600_000, 2);
  assert.deepEqual(s.writes, [60_000, 3_600_000]);
});

test("withState removes a lock older than 15 minutes", async () => {
  const dir = path.join(root, "state");
  fs.mkdirSync(path.join(dir, "lock"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lock", "owner"), "a request that died");
  const old = new Date(Date.now() - 16 * 60_000);
  fs.utimesSync(path.join(dir, "lock"), old, old);
  const started = Date.now();
  assert.equal(await withState(dir, async () => "ran"), "ran");
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(path.join(dir, "lock")), false);
});

test("a request that lost its lock writes nothing and leaves the next holder's lock", async () => {
  const dir = path.join(root, "state");
  fs.mkdirSync(dir);
  await assert.rejects(
    withState(dir, async (s, save) => {
      // Taken as stale while this request ran, then taken by another one.
      fs.writeFileSync(path.join(dir, "lock", "owner"), "the next holder");
      s.writes.push(1);
      await save();
    }),
    /lost the lock/,
  );
  assert.equal(fs.existsSync(path.join(dir, "state.json")), false);
  assert.equal(fs.readFileSync(path.join(dir, "lock", "owner"), "utf8"), "the next holder");
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
