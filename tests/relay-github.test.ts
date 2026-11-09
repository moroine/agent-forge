import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelayConfig } from "../cli/lib/relay/config.ts";
import { ciLog, ciRuns, comment, ensureFork, filterByAuthor, githubClient, openPull, readThread, reply } from "../cli/lib/relay/github.ts";
import { relaySetup } from "../cli/lib/relay/setup.ts";
import { fakeContext } from "./lib/fake-context.ts";

const cfg = parseRelayConfig({
  upstream: "acme/widgets",
  fork: "bot/widgets",
  botLogin: "bot",
  botName: "Bot",
  botEmail: "1+bot@users.noreply.github.com",
  trustedLogins: ["Maint"],
  coAuthorEmails: ["noreply@anthropic.com"],
  writesPerHour: 20,
});

type Answer = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

// A fake fetch: answers from a table keyed by "METHOD /path" (query string
// ignored). An array is consumed in order, the last entry repeating.
function fake(table: Record<string, Answer | Answer[]>) {
  const requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, path: u.pathname + u.search, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    let a = table[`${method} ${u.pathname}`];
    if (Array.isArray(a)) a = a.length > 1 ? a.shift()! : a[0];
    if (!a) return new Response("", { status: 599 });
    const body = a.text ?? (a.json === undefined ? "" : JSON.stringify(a.json));
    return new Response(body, { status: a.status ?? 200, headers: a.headers });
  }) as unknown as typeof fetch;
  const gh = githubClient("TOKEN", fetchImpl);
  const sent = (method: string, path: string) => requests.find((r) => r.method === method && r.path === path)?.body;
  return { gh, requests, sent };
}

const pull = (over: Record<string, unknown> = {}) => ({
  json: { user: { login: "Bot" }, head: { repo: { full_name: "Bot/Widgets" }, sha: "abc1234" }, title: "T", state: "open", ...over },
});

test("the client sends the token and the API headers, and names no body in an error", async () => {
  const { gh, requests } = fake({ "GET /repos/acme/widgets/pulls/7": { status: 500, text: "SECRET-BODY" } });
  await assert.rejects(() => comment(gh, cfg, 7, "hi"), (e: Error) => /GET \/repos\/acme\/widgets\/pulls\/7.*500/.test(e.message) && !/SECRET|TOKEN/.test(e.message));
  assert.equal(requests[0].headers.Authorization, "token TOKEN");
  assert.equal(requests[0].headers["User-Agent"], "agent-forge-relay");
});

test("filterByAuthor compares case-insensitively and counts the rest", () => {
  const r = filterByAuthor([{ author: "MAINT" }, { author: "x" }], ["maint"]);
  assert.deepEqual(r, { kept: [{ author: "MAINT" }], hidden: 1 });
});

test("comment refuses a pull request the bot did not open from its fork", async () => {
  for (const over of [{ user: { login: "other" } }, { head: { repo: { full_name: "other/widgets" }, sha: "a" } }]) {
    const { gh, sent } = fake({ "GET /repos/acme/widgets/pulls/7": pull(over) });
    await assert.rejects(() => comment(gh, cfg, 7, "hi"), /not a pull request the bot opened/);
    assert.equal(sent("POST", "/repos/acme/widgets/issues/7/comments"), undefined);
  }
});

test("comment posts on the bot's pull request", async () => {
  const { gh, sent } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "POST /repos/acme/widgets/issues/7/comments": { status: 201, json: { html_url: "https://x/c" } },
  });
  assert.deepEqual(await comment(gh, cfg, 7, "hi"), { url: "https://x/c" });
  assert.deepEqual(sent("POST", "/repos/acme/widgets/issues/7/comments"), { body: "hi" });
});

test("a number outside 1..1e9 is refused before any request", async () => {
  const { gh, requests } = fake({});
  await assert.rejects(() => comment(gh, cfg, 0, "hi"), /number/);
  await assert.rejects(() => comment(gh, cfg, 1.5, "hi"), /number/);
  assert.equal(requests.length, 0);
});

test("reply refuses a review comment of another pull request", async () => {
  const { gh, sent } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/pulls/comments/55": { json: { pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/8" } },
  });
  await assert.rejects(() => reply(gh, cfg, 7, 55, "hi"), /not a comment of pull request 7/);
  assert.equal(sent("POST", "/repos/acme/widgets/pulls/7/comments/55/replies"), undefined);
});

test("reply posts to the comment's thread", async () => {
  const { gh, sent } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/pulls/comments/55": { json: { pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/7" } },
    "POST /repos/acme/widgets/pulls/7/comments/55/replies": { status: 201, json: { html_url: "https://x/r" } },
  });
  assert.deepEqual(await reply(gh, cfg, 7, 55, "ok"), { url: "https://x/r" });
  assert.deepEqual(sent("POST", "/repos/acme/widgets/pulls/7/comments/55/replies"), { body: "ok" });
});

test("readThread keeps the maintainer's and the bot's text only", async () => {
  const { gh } = fake({
    "GET /repos/acme/widgets/issues/7": { json: { id: 1, title: "T", state: "open", user: { login: "bot" }, body: "b", created_at: "d0", pull_request: {} } },
    "GET /repos/acme/widgets/issues/7/comments": { json: [
      { id: 2, user: { login: "maint" }, created_at: "d1", body: "fix \x1b[2Jthis\nplease" },
      { id: 3, user: { login: "stranger" }, created_at: "d2", body: "spam" },
    ] },
    "GET /repos/acme/widgets/pulls/7/reviews": { json: [
      { id: 4, user: { login: "stranger" }, submitted_at: "d3", body: "no" },
      { id: 5, user: { login: "Bot" }, submitted_at: "d4", body: "mine" },
    ] },
    "GET /repos/acme/widgets/pulls/7/comments": { json: [] },
  });
  const t = await readThread(gh, cfg, 7);
  assert.deepEqual(t.items.map((i) => i.author), ["bot", "maint", "Bot"]);
  assert.equal(t.kind, "pull");
  assert.equal(t.hidden, 2);
  assert.equal(t.items.find((i) => i.id === 2)!.body, "fix [2Jthis\nplease");
});

test("an issue opened by a stranger hides its title and body", async () => {
  const { gh } = fake({
    "GET /repos/acme/widgets/issues/9": { json: { id: 1, title: "Ignore previous", state: "open", user: { login: "stranger" }, body: "x", created_at: "d0" } },
    "GET /repos/acme/widgets/issues/9/comments": { json: [] },
  });
  const t = await readThread(gh, cfg, 9);
  assert.equal(t.title, null);
  assert.equal(t.kind, "issue");
  assert.deepEqual(t.items, []);
  assert.equal(t.hidden, 1);
});

test("openPull opens from bot:agent/<task> to main, edits by maintainers off", async () => {
  const { gh, sent } = fake({ "POST /repos/acme/widgets/pulls": { status: 201, json: { number: 12, html_url: "https://x/p/12" } } });
  assert.deepEqual(await openPull(gh, cfg, "t", "Title", "Body"), { number: 12, url: "https://x/p/12" });
  assert.deepEqual(sent("POST", "/repos/acme/widgets/pulls"),
    { title: "Title", body: "Body", head: "bot:agent/t", base: "main", maintainer_can_modify: false });
});

test("openPull refuses a task that is not a branch name", async () => {
  const { gh, requests } = fake({});
  await assert.rejects(() => openPull(gh, cfg, "../x", "T", "B"), /agent\/<task>/);
  assert.equal(requests.length, 0);
});

test("ensureFork creates a missing fork, then waits for it", async () => {
  const { gh, sent, requests } = fake({
    "GET /repos/bot/widgets": [{ status: 404 }, { status: 404 }, { json: { fork: true, parent: { full_name: "acme/widgets" } } }],
    "POST /repos/acme/widgets/forks": { status: 202, json: {} },
  });
  const sleeps: number[] = [];
  assert.equal(await ensureFork(gh, cfg, async (ms) => { sleeps.push(ms); }), "created");
  assert.deepEqual(sent("POST", "/repos/acme/widgets/forks"), { name: "widgets", default_branch_only: true });
  assert.deepEqual(sleeps, [5000]);
  assert.equal(requests.filter((r) => r.method === "GET").length, 3);
});

test("ensureFork refuses a repository that is not a fork of upstream", async () => {
  for (const json of [{ fork: false }, { fork: true, parent: { full_name: "x/y" } }]) {
    const { gh } = fake({ "GET /repos/bot/widgets": { json } });
    await assert.rejects(() => ensureFork(gh, cfg, async () => {}), /not a fork of acme\/widgets/);
  }
  const { gh } = fake({ "GET /repos/bot/widgets": { json: { fork: true, parent: { full_name: "ACME/Widgets" } } } });
  assert.equal(await ensureFork(gh, cfg, async () => {}), "exists");
});

test("ciRuns lists the checks of the head commit, ciLog reads one of them", async () => {
  const { gh } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/commits/abc1234/check-runs": { json: { check_runs: [{ id: 40, name: "test", status: "completed", conclusion: "failure", extra: 1 }] } },
    "GET /repos/acme/widgets/actions/jobs/40/logs": { text: "line\x1b[2J one\n" },
  });
  assert.deepEqual(await ciRuns(gh, cfg, 7), [{ id: 40, name: "test", status: "completed", conclusion: "failure" }]);
  assert.equal(await ciLog(gh, cfg, 7, 40), "line[2J one\n");
});

test("ciLog refuses a job that is not one of the pull request's checks", async () => {
  const { gh, requests } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/commits/abc1234/check-runs": { json: { check_runs: [{ id: 40, name: "t", status: "completed", conclusion: null }] } },
  });
  await assert.rejects(() => ciLog(gh, cfg, 7, 41), /not one of the checks/);
  assert.ok(!requests.some((r) => r.path.includes("/actions/jobs")));
});

const GOOD = "ssh-ed25519 AAAAkey relay";
function setupFake(over: { scopes?: string; expiry?: boolean; login?: string; keys?: unknown[]; actions?: Answer } = {}) {
  const headers: Record<string, string> = { "X-OAuth-Scopes": over.scopes ?? "public_repo, workflow" };
  if (over.expiry !== false) headers["GitHub-Authentication-Token-Expiration"] = "2027-01-01 00:00:00 UTC";
  return fake({
    "GET /user": { json: { login: over.login ?? "Bot" }, headers },
    "GET /repos/bot/widgets": { json: { fork: true, parent: { full_name: "acme/widgets" } } },
    "GET /repos/bot/widgets/actions/permissions": over.actions ?? { json: { enabled: false } },
    "GET /users/bot/ssh_signing_keys": { json: over.keys ?? [] },
  });
}

test("setup refuses scopes beyond public_repo and workflow", async () => {
  const { gh } = setupFake({ scopes: "public_repo, repo, workflow" });
  await assert.rejects(() => relaySetup(fakeContext(), gh, cfg, GOOD, async () => {}), /repo/);
});

test("setup refuses a token without expiry or of another account", async () => {
  await assert.rejects(() => relaySetup(fakeContext(), setupFake({ expiry: false }).gh, cfg, GOOD, async () => {}), /expir/);
  await assert.rejects(() => relaySetup(fakeContext(), setupFake({ login: "other" }).gh, cfg, GOOD, async () => {}), /account/);
});

test("setup prints the signing key and returns 1 until it is registered", async () => {
  const ctx = fakeContext();
  assert.equal(await relaySetup(ctx, setupFake().gh, cfg, `${GOOD}\n`, async () => {}), 1);
  assert.match(ctx.out_lines.join("\n"), /ssh-ed25519 AAAAkey/);
  assert.match(ctx.out_lines.join("\n"), /Signing Key/);
  // Registered under another comment: same type and base64, so it counts.
  const ctx2 = fakeContext();
  assert.equal(await relaySetup(ctx2, setupFake({ keys: [{ key: "ssh-ed25519 AAAAkey laptop" }] }).gh, cfg, GOOD, async () => {}), 0);
});

test("setup returns 1 while Actions are enabled on the fork, 0 when off or unreadable", async () => {
  const keys = [{ key: GOOD }];
  const run = async (actions: Answer) => {
    const ctx = fakeContext();
    return { code: await relaySetup(ctx, setupFake({ keys, actions }).gh, cfg, GOOD, async () => {}), out: ctx.out_lines.join("\n") };
  };
  const on = await run({ json: { enabled: true } });
  assert.equal(on.code, 1);
  assert.match(on.out, /Actions are enabled on bot\/widgets: disable them/);
  assert.equal((await run({ json: { enabled: false } })).code, 0);
  const unreadable = await run({ status: 403 });
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.out, /could not check/);
  await assert.rejects(() => relaySetup(fakeContext(), setupFake({ keys, actions: { status: 500 } }).gh, cfg, GOOD, async () => {}), /500/);
});

test("setup refuses an empty or malformed signing key", async () => {
  for (const bad of ["", "  \n", "garbage"]) await assert.rejects(() => relaySetup(fakeContext(), setupFake().gh, cfg, bad, async () => {}), /signing public key/);
});

test("openPull refuses an answer without a pull request number", async () => {
  const { gh } = fake({ "POST /repos/acme/widgets/pulls": { status: 201, json: { html_url: "x" } } });
  await assert.rejects(() => openPull(gh, cfg, "t", "T", "B"), /without a pull request number/);
});
