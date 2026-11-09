import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult } from "../cli/lib/context.ts";
import { cmdRelay } from "../cli/lib/commands/relay.ts";
import { git, hybridContext } from "./lib/git-layout.ts";
import type { FakeContext } from "./lib/fake-context.ts";

let root: string;
let dev: string;
let fork: string;
let configFile: string;
let ctx: FakeContext;
// What the fake relay does with one call: the operation, the parsed request.
let relay: (op: string, req: Record<string, unknown>) => Record<string, unknown> | ExecResult;
let sshCalls: string[][];

const ident = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-relay-client-")));
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  fs.writeFileSync(path.join(seed, "README"), "seed\n");
  git(seed, "add", ".");
  git(seed, ...ident, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", origin, "main");
  // The agent's clone, and the relay's side of the fork.
  dev = path.join(root, "dev");
  fork = path.join(root, "fork");
  for (const d of [dev, fork]) execFileSync("git", ["clone", "-q", origin, d], { stdio: "ignore" });
  git(dev, "config", "user.name", "Test");
  git(dev, "config", "user.email", "test@example.com");
  git(dev, "checkout", "-q", "-b", "agent/t");
  fs.writeFileSync(path.join(dev, "a.txt"), "a\n");
  git(dev, "add", "a.txt");
  git(dev, "commit", "-q", "-m", "add a");

  fs.mkdirSync(path.join(root, "keys"));
  configFile = path.join(root, "relay.json");
  fs.writeFileSync(configFile, JSON.stringify({
    address: "relay.example", user: "relay",
    key: path.join(root, "keys", "id"), knownHosts: path.join(root, "keys", "known_hosts"),
  }));

  sshCalls = [];
  ctx = hybridContext();
  const exec = ctx.exec;
  ctx.exec = async (argv, o) => {
    if (argv[0] !== "ssh") return exec(argv, o);
    sshCalls.push(argv);
    const out = relay(argv[argv.length - 1], JSON.parse(o?.input ?? "{}"));
    if ("code" in out) return out as ExecResult;
    return { code: 0, stdout: JSON.stringify(out) + "\n", stderr: "" };
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// The relay's publish: replays the bundle's tip as a commit with the same tree
// (standing for the signed one) and answers with a bundle of it.
function publishAnswer(req: Record<string, unknown>, before?: () => void): Record<string, unknown> {
  before?.();
  const incoming = path.join(root, "incoming.bundle");
  fs.writeFileSync(incoming, Buffer.from(req.bundle as string, "base64"));
  git(fork, "fetch", "-q", incoming, "+refs/heads/agent/t:refs/heads/agent/t");
  const tree = git(fork, "rev-parse", "refs/heads/agent/t^{tree}");
  const head = git(fork, ...ident, "commit-tree", tree, "-p", "refs/remotes/origin/main", "-m", "signed");
  git(fork, "update-ref", "refs/relay/published/agent/t", head);
  const out = path.join(root, "answer.bundle");
  git(fork, "bundle", "create", "-q", out, "refs/relay/published/agent/t", "^refs/remotes/origin/main");
  return { ok: true, head, url: "https://github.com/bot/widgets/tree/agent/t", bundle: fs.readFileSync(out).toString("base64") };
}

const run = (...args: string[]) => cmdRelay(ctx, args[0], args.slice(1), { cwd: dev, configFile });

test("publish aligns the local branch on the published head", async () => {
  relay = (op, req) => { assert.equal(op, "publish"); assert.equal(req.branch, "agent/t"); return publishAnswer(req); };
  assert.equal(await run("publish"), 0);
  const head = git(fork, "rev-parse", "refs/relay/published/agent/t");
  assert.equal(git(dev, "rev-parse", "refs/heads/agent/t"), head);
  assert.equal(git(dev, "rev-parse", "refs/remotes/fork/agent/t"), head);
  assert.equal(git(dev, "status", "--porcelain"), "");
  assert.ok(ctx.out_lines.join("\n").includes("https://github.com/bot/widgets/tree/agent/t"));
});

test("a commit made during the publish is kept, and the message gives commands the hook allows", async () => {
  relay = (_op, req) => publishAnswer(req, () => {
    fs.writeFileSync(path.join(dev, "b.txt"), "b\n");
    git(dev, "add", "b.txt");
    git(dev, "commit", "-q", "-m", "add b");
  });
  const before = git(dev, "rev-parse", "HEAD");
  const err = await run("publish").then(() => null, (e: Error) => e);
  const now = git(dev, "rev-parse", "refs/heads/agent/t");
  assert.notEqual(now, before);
  assert.equal(git(dev, "log", "-1", "--format=%s", "refs/heads/agent/t"), "add b");
  // The real commits: the tip that was sent, the branch's tip now.
  const command = `git reset --keep fork/agent/t && git cherry-pick ${before}..${now}`;
  assert.ok(err !== null && /moved during the publish/.test(err.message) && err.message.endsWith(command), String(err));

  // container/pre-bash.sh, in the dev VM's mode, lets the agent run it...
  const mode = path.join(root, "forge-mode");
  fs.writeFileSync(mode, "contributor");
  execFileSync("bash", [path.join(import.meta.dirname, "..", "container", "pre-bash.sh")], {
    input: JSON.stringify({ tool_input: { command } }),
    env: { ...process.env, FORGE_MODE_FILE: mode, FORGE_AUDIT_LOG: path.join(root, "bash-audit.log") },
  });
  // ...and it puts the new commit on the published head.
  execFileSync("bash", ["-c", command], { cwd: dev, stdio: "ignore" });
  assert.equal(git(dev, "rev-parse", "HEAD^"), git(fork, "rev-parse", "refs/relay/published/agent/t"));
  assert.equal(git(dev, "log", "-1", "--format=%s"), "add b");
  assert.equal(git(dev, "status", "--porcelain"), "");
});

test("a branch already at the fork's head is sent whole, for a rebuilt relay to record", async () => {
  relay = (_op, req) => publishAnswer(req);
  await run("publish");
  let sent = "";
  relay = (_op, req) => {
    sent = path.join(root, "sent.bundle");
    fs.writeFileSync(sent, Buffer.from(req.bundle as string, "base64"));
    return publishAnswer(req);
  };
  assert.equal(await run("publish"), 0);
  assert.equal(sshCalls.length, 2);
  assert.match(git(dev, "bundle", "list-heads", sent), / refs\/heads\/agent\/t$/);
});

test("a request over the relay's 64 MiB is refused before it is sent", async () => {
  relay = () => { throw new Error("must not reach the relay"); };
  const big = "x".repeat(64 * 1024 * 1024);
  await assert.rejects(cmdRelay(ctx, "comment", ["7"], { cwd: dev, configFile, bodyFile: "-", stdin: () => big }), /too big/);
  assert.equal(sshCalls.length, 0);
});

test("publish refuses a branch outside agent/*", async () => {
  git(dev, "checkout", "-q", "-b", "feature");
  relay = () => { throw new Error("must not reach the relay"); };
  await assert.rejects(run("publish"), /agent\//);
  assert.equal(sshCalls.length, 0);
});

test("ssh never forwards the agent and checks the relay's host key", async () => {
  relay = () => ({ ok: true, thread: { number: 3, kind: "issue", title: null, state: "open", items: [], hidden: 0 } });
  await run("read", "3");
  const argv = sshCalls[0];
  assert.ok(argv.includes("StrictHostKeyChecking=yes") && argv.includes("BatchMode=yes"));
  assert.ok(!argv.some((a) => /ForwardAgent=yes/.test(a)));
  assert.equal(argv[argv.length - 2], "relay@relay.example");
});

test("read prints each item and says how many were hidden, without control characters", async () => {
  relay = () => ({ ok: true, thread: {
    number: 3, kind: "pull", title: "T", state: "open", hidden: 2,
    items: [
      { kind: "review-comment", id: 9, author: "maint", createdAt: "2026-11-09", body: "fix\x1b[2Jthis", path: "a.ts", line: 4 },
      { kind: "review-comment", id: 10, author: "bot", createdAt: "2026-11-09", body: "done", path: "a.ts", line: 4, inReplyTo: 9 },
    ],
  } });
  await run("read", "3");
  const text = ctx.out_lines.join("\n");
  assert.ok(text.includes("--- review-comment 9 by maint, 2026-11-09, a.ts:4\n"));
  // A reply names its thread's first comment, the one a new reply must answer.
  assert.ok(text.includes("--- review-comment 10 by bot, 2026-11-09, a.ts:4, in reply to 9\n"), text);
  assert.ok(text.includes("fix[2Jthis") && !text.includes("\x1b"));
  assert.ok(text.includes("2 items from other accounts hidden"));
});

test("ci with a job id asks for its log; a relay refusal becomes an error, its lines kept", async () => {
  // Actions job IDs are past 1e10 now.
  relay = (op, req) => {
    assert.equal(op, "ci-log");
    assert.deepEqual(req, { pr: 5, job: 41_234_567_890 });
    return { ok: false, error: "nope\x1b[1m\n  second line" };
  };
  await assert.rejects(run("ci", "5", "41234567890"), (e: Error) => e.message.includes("nope[1m\n  second line") && !e.message.includes("\x1b"));
});

test("reply takes a comment ID as large as GitHub's, up to what a JSON number holds", async () => {
  relay = (op, req) => {
    assert.equal(op, "reply");
    assert.deepEqual(req, { pr: 7, commentId: 2_874_512_345, body: "ok" });
    return { ok: true, url: "https://x/r" };
  };
  const reply = (id: string) => cmdRelay(ctx, "reply", ["7", id], { cwd: dev, configFile, bodyFile: "-", stdin: () => "ok" });
  assert.equal(await reply("2874512345"), 0);
  await assert.rejects(reply("9007199254740993"), /comment-id/);
  assert.equal(sshCalls.length, 1);
});

test("a missing client config says there is no relay on this host", async () => {
  await assert.rejects(cmdRelay(ctx, "read", ["3"], { cwd: dev, configFile: path.join(root, "absent.json") }), /no relay on this host/);
});
