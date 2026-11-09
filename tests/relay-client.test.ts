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

test("a commit made during the publish is kept, and the message says how to continue", async () => {
  relay = (_op, req) => publishAnswer(req, () => {
    fs.writeFileSync(path.join(dev, "b.txt"), "b\n");
    git(dev, "add", "b.txt");
    git(dev, "commit", "-q", "-m", "add b");
  });
  const before = git(dev, "rev-parse", "HEAD");
  await assert.rejects(run("publish"), /moved during the publish/);
  assert.notEqual(git(dev, "rev-parse", "refs/heads/agent/t"), before);
  assert.equal(git(dev, "log", "-1", "--format=%s", "refs/heads/agent/t"), "add b");
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
    items: [{ kind: "review-comment", id: 9, author: "maint", createdAt: "2026-11-09", body: "fix\x1b[2Jthis", path: "a.ts", line: 4 }],
  } });
  await run("read", "3");
  const text = ctx.out_lines.join("\n");
  assert.ok(text.includes("--- review-comment 9 by maint, 2026-11-09, a.ts:4"));
  assert.ok(text.includes("fix[2Jthis") && !text.includes("\x1b"));
  assert.ok(text.includes("2 items from other accounts hidden"));
});

test("ci with a job id asks for its log; a relay refusal becomes an error", async () => {
  relay = (op, req) => {
    assert.equal(op, "ci-log");
    assert.deepEqual(req, { pr: 5, job: 77 });
    return { ok: false, error: "nope\x1b[1m" };
  };
  await assert.rejects(run("ci", "5", "77"), (e: Error) => e.message.includes("nope") && !e.message.includes("\x1b"));
});

test("a missing client config says there is no relay on this host", async () => {
  await assert.rejects(cmdRelay(ctx, "read", ["3"], { cwd: dev, configFile: path.join(root, "absent.json") }), /no relay on this host/);
});
