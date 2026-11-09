import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelayConfig } from "../cli/lib/relay/config.ts";
import type { GitHub } from "../cli/lib/relay/github.ts";
import { RELAY_PATHS } from "../cli/lib/relay/paths.ts";
import type { RelayDeps } from "../cli/lib/relay/publish.ts";
import { serve } from "../cli/lib/relay/serve.ts";
import { withState } from "../cli/lib/relay/state.ts";
import { hybridContext } from "./lib/git-layout.ts";
import type { FakeContext } from "./lib/fake-context.ts";

const fakeBetterleaks = path.join(import.meta.dirname, "fixtures", "fake-betterleaks");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

let root: string;
let calls: string[];
let ctx: FakeContext;
let d: RelayDeps;
let finding: boolean;

// A GitHub that records every call and answers what the bot's own pull
// request 7 needs.
const github: GitHub = {
  async request(method, p) {
    calls.push(`${method} ${p}`);
    const ok = (json: unknown) => ({ status: 200, headers: new Headers(), json, text: "" });
    if (method === "GET" && p === "/repos/acme/widgets/pulls/7") return ok({ user: { login: "bot" }, head: { sha: HEAD, repo: { full_name: "bot/widgets" } } });
    if (method === "POST" && p === "/repos/acme/widgets/issues/7/comments") return ok({ html_url: "https://github.com/acme/widgets/pull/7#c1" });
    if (method === "POST" && p === "/repos/acme/widgets/pulls") return ok({ number: 8, html_url: "https://github.com/acme/widgets/pull/8" });
    return { status: 599, headers: new Headers(), json: null, text: "" };
  },
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-relay-serve-")));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(fakeBetterleaks, path.join(bin, "betterleaks"));
  finding = false;
  ctx = hybridContext();
  const exec = ctx.exec;
  ctx.exec = (argv, o) => exec(argv, { ...o, env: { PATH: `${bin}:${process.env.PATH}`, FAKE_BL_LOG: path.join(root, "bl.log"), ...(finding ? { FAKE_BL_FIND: "1" } : {}), ...o?.env } });
  calls = [];
  const stateDir = path.join(root, "state");
  const mirror = path.join(root, "mirror.git");
  fs.mkdirSync(stateDir);
  execFileSync("git", ["init", "-q", "--bare", mirror]);
  d = {
    ctx,
    cfg: parseRelayConfig({
      upstream: "acme/widgets", fork: "bot/widgets", botLogin: "bot", botName: "Bot", botEmail: "1+bot@users.noreply.github.com",
      trustedLogins: ["maint"], coAuthorEmails: ["noreply@anthropic.com"], writesPerHour: 2,
    }),
    paths: { ...RELAY_PATHS, mirror, stateDir, audit: path.join(root, "logs", "audit.log") },
    github,
    sleep: async () => {},
    now: () => Date.now(),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (o: unknown) => Buffer.from(JSON.stringify(o));
const answer = async (op: string, o: unknown) => {
  const line = await serve(d, op, json(o));
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1, "one line");
  return JSON.parse(line) as Record<string, unknown>;
};
const audit = () => fs.readFileSync(d.paths.audit, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("an unknown operation is refused and audited", async () => {
  const a = await answer("merge", {});
  assert.equal(a.ok, false);
  assert.equal(audit().at(-1)?.outcome, "refused");
  assert.equal((fs.statSync(d.paths.audit).mode & 0o777).toString(8), "600");
  assert.deepEqual(calls, []);
});

test("a malformed request or an unknown field is refused", async () => {
  for (const [op, body] of [
    ["comment", { pr: 7, body: "x", extra: 1 }],
    ["comment", { pr: "7", body: "x" }],
    ["comment", { pr: 0, body: "x" }],
    ["comment", { pr: 1.5, body: "x" }],
    ["comment", { pr: 2e9, body: "x" }],
    ["comment", { pr: 7 }],
    ["comment", { pr: 7, body: 3 }],
    ["ci-log", { pr: 7, job: -1 }],
    ["publish", { branch: "agent/t", bundle: "not base64!" }],
    ["publish", { branch: "agent/t", bundle: "" }],
  ] as [string, unknown][]) {
    assert.equal((await answer(op, body)).ok, false, `${op} ${JSON.stringify(body)}`);
  }
  for (const raw of ["not json", "[]", "null"]) assert.equal(JSON.parse(await serve(d, "read", Buffer.from(raw))).ok, false);
  assert.deepEqual(calls, []);
});

test("a comment referring to another repository is refused before any GitHub call", async () => {
  const a = await answer("comment", { pr: 7, body: "see other/repo#3" });
  assert.equal(a.ok, false);
  assert.match(String(a.error), /another repository/);
  assert.deepEqual(calls, []);
});

test("a Betterleaks finding in a pull request body refuses it before any GitHub call", async () => {
  await withState(d.paths.stateDir, async (s) => { s.published.t = HEAD; });
  finding = true;
  const a = await answer("open-pr", { branch: "agent/t", title: "title", body: "a body" });
  assert.equal(a.ok, false);
  assert.match(String(a.error), /Betterleaks found a possible secret in the pull request title \(rule generic-api-key\)/);
  assert.deepEqual(calls, []);
  // A refused request does not use the cap.
  await withState(d.paths.stateDir, async (s) => assert.deepEqual(s.writes, []));
});

test("open-pr is refused for a branch the relay has not published", async () => {
  const a = await answer("open-pr", { branch: "agent/t", title: "title", body: "body" });
  assert.equal(a.ok, false);
  assert.match(String(a.error), /has not been published/);
  assert.deepEqual(calls, []);
  await withState(d.paths.stateDir, async (s) => assert.deepEqual(s.writes, []));
  // Pending is not published.
  await withState(d.paths.stateDir, async (s) => { s.pending.t = HEAD; });
  assert.equal((await answer("open-pr", { branch: "agent/t", title: "title", body: "body" })).ok, false);
  assert.deepEqual(calls, []);
});

test("open-pr and comment answer on one line", async () => {
  await withState(d.paths.stateDir, async (s) => { s.published.t = HEAD; });
  assert.deepEqual(await answer("open-pr", { branch: "agent/t", title: "title", body: "body" }), { ok: true, number: 8, url: "https://github.com/acme/widgets/pull/8" });
  assert.deepEqual(await answer("comment", { pr: 7, body: "hi" }), { ok: true, url: "https://github.com/acme/widgets/pull/7#c1" });
});

test("the write cap refuses the third comment of the hour", async () => {
  assert.equal((await answer("comment", { pr: 7, body: "one" })).ok, true);
  assert.equal((await answer("comment", { pr: 7, body: "two" })).ok, true);
  const before = calls.length;
  const a = await answer("comment", { pr: 7, body: "three" });
  assert.equal(a.ok, false);
  assert.match(String(a.error), /write cap reached/);
  assert.equal(calls.length, before);
});

test("an internal error answers without its stack, which goes to the audit log", async () => {
  d.github = { request: async () => { throw new Error("boom at /secret/place"); } };
  const a = await answer("read", { number: 7 });
  assert.deepEqual(a, { ok: false, error: "internal error (logged on the relay)" });
  const last = audit().at(-1)!;
  assert.equal(last.outcome, "error");
  assert.match(String(last.detail), /boom at/);
});

test("an audit failure does not hide the answer and is reported on stderr", async () => {
  fs.writeFileSync(path.join(root, "logs"), "a file, not a directory");
  const errs: string[] = [];
  ctx.err = (l) => { errs.push(l); };
  const a = await answer("comment", { pr: 7, body: "hi" });
  assert.equal(a.ok, true);
  assert.match(errs.join("\n"), /audit log/);
});

test("the audit log never holds the texts", async () => {
  await serve(d, "comment", json({ pr: 7, body: "SECRET-BODY-TEXT" }));
  await withState(d.paths.stateDir, async (s) => { s.published.t = HEAD; });
  await serve(d, "open-pr", json({ branch: "agent/t", title: "SECRET-TITLE-TEXT", body: "SECRET-BODY-TEXT" }));
  const log = fs.readFileSync(d.paths.audit, "utf8");
  assert.doesNotMatch(log, /SECRET-(BODY|TITLE)-TEXT/);
  assert.match(log, /sha256/);
});
