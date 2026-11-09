import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelayConfig, RelayError } from "../cli/lib/relay/config.ts";
import { ciLog, ciRuns, comment, ensureFork, filterByAuthor, githubClient, openPull, readThread, reply } from "../cli/lib/relay/github.ts";
import { RELAY_PATHS } from "../cli/lib/relay/paths.ts";
import { relaySetup } from "../cli/lib/relay/setup.ts";
import { fakeContext, type FakeContext } from "./lib/fake-context.ts";

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

test("reply posts to the comment's thread, with a comment ID as large as GitHub's", async () => {
  // Review comment IDs are near 2e9 now.
  const id = 2_874_512_345;
  const { gh, sent } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    [`GET /repos/acme/widgets/pulls/comments/${id}`]: { json: { pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/7" } },
    [`POST /repos/acme/widgets/pulls/7/comments/${id}/replies`]: { status: 201, json: { html_url: "https://x/r" } },
  });
  assert.deepEqual(await reply(gh, cfg, 7, id, "ok"), { url: "https://x/r" });
  assert.deepEqual(sent("POST", `/repos/acme/widgets/pulls/7/comments/${id}/replies`), { body: "ok" });
  const none = fake({});
  await assert.rejects(() => reply(none.gh, cfg, 7, 2 ** 53, "ok"), /comment ID/);
  assert.equal(none.requests.length, 0);
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

test("ensureFork creates a missing fork under the configured name, then waits for it", async () => {
  // A fork named otherwise than upstream.
  const named = parseRelayConfig({ ...cfg, fork: "bot/widgets-fork" });
  const { gh, sent, requests } = fake({
    "GET /repos/bot/widgets-fork": [{ status: 404 }, { status: 404 }, { json: { fork: true, parent: { full_name: "acme/widgets" } } }],
    "POST /repos/acme/widgets/forks": { status: 202, json: { full_name: "bot/widgets-fork" } },
  });
  const sleeps: number[] = [];
  assert.equal(await ensureFork(gh, named, async (ms) => { sleeps.push(ms); }), "created");
  assert.deepEqual(sent("POST", "/repos/acme/widgets/forks"), { name: "widgets-fork", default_branch_only: true });
  assert.deepEqual(sleeps, [5000]);
  assert.equal(requests.filter((r) => r.method === "GET").length, 3);
});

test("ensureFork refuses at once a fork GitHub answers under another name", async () => {
  // The bot's existing fork of upstream, which GitHub returns instead of a new one.
  const named = parseRelayConfig({ ...cfg, fork: "bot/widgets-fork" });
  const { gh, requests } = fake({
    "GET /repos/bot/widgets-fork": { status: 404 },
    "POST /repos/acme/widgets/forks": { status: 202, json: { full_name: "bot/widgets" } },
  });
  await assert.rejects(() => ensureFork(gh, named, async () => {}), /answered the fork request with bot\/widgets, not bot\/widgets-fork/);
  assert.equal(requests.filter((r) => r.method === "GET").length, 1);
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
  // Actions job IDs are past 1e10 now.
  const job = 41_234_567_890;
  const { gh } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/commits/abc1234/check-runs": { json: { check_runs: [{ id: job, name: "test", status: "completed", conclusion: "failure", extra: 1 }] } },
    [`GET /repos/acme/widgets/actions/jobs/${job}/logs`]: { text: "line\x1b[2J one\n" },
  });
  assert.deepEqual(await ciRuns(gh, cfg, 7), [{ id: job, name: "test", status: "completed", conclusion: "failure" }]);
  assert.equal(await ciLog(gh, cfg, 7, job), "line[2J one\n");
});

test("ciLog refuses a job that is not one of the pull request's checks", async () => {
  const { gh, requests } = fake({
    "GET /repos/acme/widgets/pulls/7": pull(),
    "GET /repos/acme/widgets/commits/abc1234/check-runs": { json: { check_runs: [{ id: 40, name: "t", status: "completed", conclusion: null }] } },
  });
  await assert.rejects(() => ciLog(gh, cfg, 7, 41), /not one of the checks/);
  assert.ok(!requests.some((r) => r.path.includes("/actions/jobs")));
});

// The relay's two public keys: the push key and the signing key.
const PUSH = "ssh-ed25519 AAAApush forge-relay-push";
const SIGNING = "ssh-ed25519 AAAAsign forge-relay-signing";
const KEYS = { push: PUSH, signing: SIGNING };
const GREETING = (login: string) => `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.\n`;
// How the setup reaches github.com as the bot: the push key alone, GitHub's
// pinned host keys alone, bounded in time like a push.
const SSH_CHECK = [
  "ssh", "-F", "/dev/null", "-i", RELAY_PATHS.pushKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
  "-o", `UserKnownHostsFile=${RELAY_PATHS.githubKnownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null",
  "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
  "-T", "git@github.com",
];

// A token without expiry by default, as the maintainer creates it; both keys
// registered unless a test says otherwise.
function setupFake(over: { scopes?: string; login?: string; pushKeys?: unknown[]; signingKeys?: unknown[]; actions?: Answer } = {}) {
  return fake({
    "GET /user": { json: { login: over.login ?? "Bot" }, headers: { "X-OAuth-Scopes": over.scopes ?? "public_repo" } },
    "GET /repos/bot/widgets": { json: { fork: true, parent: { full_name: "acme/widgets" } } },
    "GET /repos/bot/widgets/actions/permissions": over.actions ?? { json: { enabled: false } },
    "GET /users/bot/keys": { json: over.pushKeys ?? [{ id: 1, key: "ssh-ed25519 AAAApush" }] },
    "GET /users/bot/ssh_signing_keys": { json: over.signingKeys ?? [{ id: 2, key: SIGNING }] },
  });
}
// GitHub's answer to `ssh -T`: its greeting on stderr, and exit code 1.
const sshAnswer = (stderr: string, code = 1) => fakeContext({ rules: [{ match: "git@github.com", code, stderr }] });
const setup = async (o: { ctx?: FakeContext; fake?: Parameters<typeof setupFake>[0]; keys?: typeof KEYS } = {}) => {
  const ctx = o.ctx ?? sshAnswer(GREETING("Bot"));
  const code = await relaySetup({ ctx, github: setupFake(o.fake).gh, cfg, paths: RELAY_PATHS, sleep: async () => {} }, o.keys ?? KEYS);
  return { code, ctx, out: ctx.out_lines.join("\n") };
};

test("setup takes a token with the public_repo scope only, without expiry, and refuses any other, naming its scopes", async () => {
  const ok = await setup();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^token: ok \(bot, scope public_repo\)$/m);
  for (const scopes of ["public_repo, workflow", "repo", ""]) {
    await assert.rejects(() => setup({ fake: { scopes } }), (e: Error) =>
      e instanceof RelayError && e.message.includes(`[${scopes}]`) && /public_repo scope only/.test(e.message), scopes);
  }
  await assert.rejects(() => setup({ fake: { login: "other" } }), /account/);
});

test("setup prints both keys until they are registered, then checks the push key reaches GitHub as the bot", async () => {
  const none = await setup({ fake: { pushKeys: [], signingKeys: [] } });
  assert.equal(none.code, 1);
  assert.match(none.out, /push key, not registered yet:\nssh-ed25519 AAAApush forge-relay-push\n.*Key type: Authentication Key/);
  assert.match(none.out, /signing key, not registered yet:\nssh-ed25519 AAAAsign forge-relay-signing\n.*Key type: Signing Key/);
  // An unregistered push key is not tried on GitHub.
  assert.deepEqual(none.ctx.calls, []);

  // Registered under another comment: same type and base64, so it counts.
  const both = await setup({ fake: { signingKeys: [{ key: "ssh-ed25519 AAAAsign laptop" }] } });
  assert.equal(both.code, 0, both.out);
  assert.deepEqual(both.ctx.calls, [SSH_CHECK]);
  assert.match(both.out, /^push key: registered, and GitHub authenticates it as bot$/m);
  assert.match(both.out, /^signing key: registered$/m);
});

test("setup refuses a push key GitHub takes for another account, or does not take", async () => {
  // Another account, a deploy key, the bot's login in other case.
  const other = await setup({ ctx: sshAnswer(GREETING("someone\x1b[2Jelse")) });
  assert.equal(other.code, 1);
  assert.match(other.out, /authenticates it as someone\[2Jelse, not bot/);
  assert.equal((await setup({ ctx: sshAnswer(GREETING("acme/widgets")) })).code, 1);
  assert.equal((await setup({ ctx: sshAnswer(GREETING("BOT")) })).code, 0);
  // A host key that is not GitHub's pinned one, or no answer at all.
  const pinned = await setup({ ctx: sshAnswer("Host key verification failed.\r\n", 255) });
  assert.equal(pinned.code, 1);
  assert.match(pinned.out, /did not authenticate the push key as bot: Host key verification failed\./);
  // The signing key is still reported: both are registered in one pass.
  assert.match(pinned.out, /^signing key: registered$/m);
});

test("setup returns 1 while Actions are enabled on the fork, 0 when off or unreadable", async () => {
  const on = await setup({ fake: { actions: { json: { enabled: true } } } });
  assert.equal(on.code, 1);
  assert.match(on.out, /Actions are enabled on bot\/widgets: disable them/);
  const unreadable = await setup({ fake: { actions: { status: 403 } } });
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.out, /could not check/);
  await assert.rejects(() => setup({ fake: { actions: { status: 500 } } }), /500/);
});

test("setup refuses an empty or malformed public key", async () => {
  for (const bad of ["", "  \n", "garbage"]) {
    await assert.rejects(() => setup({ keys: { ...KEYS, push: bad } }), /push public key/);
    await assert.rejects(() => setup({ keys: { ...KEYS, signing: bad } }), /signing public key/);
  }
});

test("openPull refuses an answer without a pull request number", async () => {
  const { gh } = fake({ "POST /repos/acme/widgets/pulls": { status: 201, json: { html_url: "x" } } });
  await assert.rejects(() => openPull(gh, cfg, "t", "T", "B"), /without a pull request number/);
});
