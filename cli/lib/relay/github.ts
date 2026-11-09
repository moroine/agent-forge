// The relay's GitHub layer: the few operations on the bot's own pull requests,
// reads filtered by author, and the fork created when it is missing. Every
// path is built here from the relay's configuration and validated integers;
// nothing the dev VM sends is a path, a URL or a repository.
import { printableText } from "../printable.ts";
import { RelayError, type RelayConfig } from "./config.ts";
import { validTask } from "./policy.ts";

export type GitHub = {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: unknown; text: string }>;
};

// fetch follows redirects (the job logs answer with one) and drops
// `Authorization` on a cross-origin redirect, so the token never reaches the
// storage host.
export function githubClient(token: string, fetchImpl: typeof fetch = fetch, api = "https://api.github.com"): GitHub {
  return {
    async request(method, path, body) {
      const res = await fetchImpl(`${api}${path}`, {
        method,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "agent-forge-relay",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        // Not JSON (a log): the caller reads `text`.
      }
      return { status: res.status, headers: res.headers, json, text };
    },
  };
}

type Res = Awaited<ReturnType<GitHub["request"]>>;

// An unexpected status names the method, the path and the status: never the
// token or the response body.
function expect(res: Res, method: string, path: string, ...ok: number[]): Res {
  if (!ok.includes(res.status)) throw new RelayError(`GitHub ${method} ${path.split("?")[0]} answered ${res.status}`);
  return res;
}

async function get(gh: GitHub, path: string, ...ok: number[]): Promise<Res> {
  return expect(await gh.request("GET", path), "GET", path, ...(ok.length ? ok : [200]));
}

async function post(gh: GitHub, path: string, body: unknown): Promise<Res> {
  return expect(await gh.request("POST", path, body), "POST", path, 200, 201, 202);
}

// Reading a field of an API answer: the answer is GitHub's, but a wrong shape
// must end in a refusal, not a TypeError.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function num(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000) throw new RelayError(`${what} number must be an integer between 1 and 1000000000`);
  return n;
}

export function filterByAuthor<T extends { author: string }>(items: T[], allowed: readonly string[]): { kept: T[]; hidden: number } {
  const ok = new Set(allowed.map((a) => a.toLowerCase()));
  const kept = items.filter((i) => ok.has(i.author.toLowerCase()));
  return { kept, hidden: items.length - kept.length };
}

const trusted = (cfg: RelayConfig): string[] => [...cfg.trustedLogins, cfg.botLogin];

export async function ensureFork(gh: GitHub, cfg: RelayConfig, sleep: (ms: number) => Promise<void>): Promise<"exists" | "created"> {
  const path = `/repos/${cfg.fork}`;
  const check = (res: Res) => {
    const j = obj(res.json);
    if (j.fork !== true || !eq(str(obj(j.parent).full_name), cfg.upstream)) throw new RelayError(`${cfg.fork} exists but is not a fork of ${cfg.upstream}`);
  };
  const first = await get(gh, path, 200, 404);
  if (first.status === 200) {
    check(first);
    return "exists";
  }
  await post(gh, `/repos/${cfg.upstream}/forks`, { name: cfg.upstream.split("/")[1], default_branch_only: true });
  // Forking is asynchronous: poll until the repository answers.
  for (let i = 0; i < 60; i++) {
    const res = await get(gh, path, 200, 404);
    if (res.status === 200) {
      check(res);
      return "created";
    }
    await sleep(5000);
  }
  throw new RelayError(`the fork ${cfg.fork} did not appear within 5 minutes`);
}

// The pull request, read from upstream, once it is known to be the bot's: its
// author is the bot and its head lives in the bot's fork.
async function botPull(gh: GitHub, cfg: RelayConfig, n: number): Promise<{ sha: string }> {
  num(n, "pull request");
  const j = obj((await get(gh, `/repos/${cfg.upstream}/pulls/${n}`)).json);
  const head = obj(j.head);
  if (!eq(str(obj(j.user).login), cfg.botLogin) || !eq(str(obj(head.repo).full_name), cfg.fork)) {
    throw new RelayError(`#${n} is not a pull request the bot opened from its fork`);
  }
  return { sha: str(head.sha) };
}

export async function openPull(gh: GitHub, cfg: RelayConfig, task: string, title: string, body: string): Promise<{ number: number; url: string }> {
  // validTask takes the branch name and returns the task it checked.
  const t = validTask(`agent/${task}`);
  const j = obj((await post(gh, `/repos/${cfg.upstream}/pulls`, {
    title,
    body,
    head: `${cfg.botLogin}:agent/${t}`,
    base: "main",
    maintainer_can_modify: false,
  })).json);
  if (typeof j.number !== "number" || !Number.isInteger(j.number) || j.number < 1) throw new RelayError("GitHub answered without a pull request number");
  return { number: j.number, url: str(j.html_url) };
}

export async function comment(gh: GitHub, cfg: RelayConfig, pr: number, body: string): Promise<{ url: string }> {
  await botPull(gh, cfg, pr);
  return { url: str(obj((await post(gh, `/repos/${cfg.upstream}/issues/${pr}/comments`, { body })).json).html_url) };
}

export async function reply(gh: GitHub, cfg: RelayConfig, pr: number, commentId: number, body: string): Promise<{ url: string }> {
  await botPull(gh, cfg, pr);
  num(commentId, "comment");
  const c = obj((await get(gh, `/repos/${cfg.upstream}/pulls/comments/${commentId}`)).json);
  if (!str(c.pull_request_url).endsWith(`/repos/${cfg.upstream}/pulls/${pr}`)) {
    throw new RelayError(`comment ${commentId} is not a comment of pull request ${pr}`);
  }
  return { url: str(obj((await post(gh, `/repos/${cfg.upstream}/pulls/${pr}/comments/${commentId}/replies`, { body })).json).html_url) };
}

export type ThreadItem = { kind: "body" | "comment" | "review" | "review-comment"; id: number; author: string; createdAt: string; body: string; path?: string; line?: number; inReplyTo?: number };
export type Thread = { number: number; kind: "issue" | "pull"; title: string | null; state: string; items: ThreadItem[]; hidden: number };

// A list endpoint, 100 per page, 10 pages at most.
async function pages(gh: GitHub, path: string): Promise<Obj[]> {
  const all: Obj[] = [];
  for (let p = 1; p <= 10; p++) {
    const res = await get(gh, `${path}?per_page=100&page=${p}`);
    const list = Array.isArray(res.json) ? res.json.map(obj) : [];
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

// A deleted account has no `user`: its author is "", which is never trusted.
const author = (o: Obj): string => str(obj(o.user).login);

export async function readThread(gh: GitHub, cfg: RelayConfig, n: number): Promise<Thread> {
  num(n, "issue or pull request");
  const base = `/repos/${cfg.upstream}`;
  const issue = obj((await get(gh, `${base}/issues/${n}`)).json);
  const isPull = issue.pull_request !== undefined;
  const items: ThreadItem[] = [{ kind: "body", id: Number(issue.id), author: author(issue), createdAt: str(issue.created_at), body: str(issue.body) }];
  for (const c of await pages(gh, `${base}/issues/${n}/comments`)) {
    items.push({ kind: "comment", id: Number(c.id), author: author(c), createdAt: str(c.created_at), body: str(c.body) });
  }
  if (isPull) {
    for (const r of await pages(gh, `${base}/pulls/${n}/reviews`)) {
      items.push({ kind: "review", id: Number(r.id), author: author(r), createdAt: str(r.submitted_at), body: str(r.body) });
    }
    for (const c of await pages(gh, `${base}/pulls/${n}/comments`)) {
      items.push({
        kind: "review-comment", id: Number(c.id), author: author(c), createdAt: str(c.created_at), body: str(c.body),
        path: str(c.path), line: typeof c.line === "number" ? c.line : undefined,
        inReplyTo: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : undefined,
      });
    }
  }
  const { kept, hidden } = filterByAuthor(items, trusted(cfg));
  // The title is the issue author's text too: a stranger's is hidden with the body.
  const own = kept.some((i) => i.kind === "body");
  return {
    number: n,
    kind: isPull ? "pull" : "issue",
    title: own ? printableText(str(issue.title)) : null,
    state: str(issue.state),
    items: kept.map((i) => ({ ...i, author: printableText(i.author), body: printableText(i.body), path: i.path === undefined ? undefined : printableText(i.path) })),
    hidden,
  };
}

export async function ciRuns(gh: GitHub, cfg: RelayConfig, pr: number): Promise<{ id: number; name: string; status: string; conclusion: string | null }[]> {
  const { sha } = await botPull(gh, cfg, pr);
  // A sha from GitHub, but it ends in a path: keep it to hex.
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new RelayError(`#${pr} has no usable head commit`);
  const runs = obj((await get(gh, `/repos/${cfg.upstream}/commits/${sha}/check-runs?per_page=100`)).json).check_runs;
  return (Array.isArray(runs) ? runs : []).map(obj).map((r) => ({
    id: Number(r.id),
    name: printableText(str(r.name)),
    status: printableText(str(r.status)),
    conclusion: typeof r.conclusion === "string" ? printableText(r.conclusion) : null,
  }));
}

export async function ciLog(gh: GitHub, cfg: RelayConfig, pr: number, jobId: number): Promise<string> {
  num(jobId, "job");
  if (!(await ciRuns(gh, cfg, pr)).some((r) => r.id === jobId)) throw new RelayError(`job ${jobId} is not one of the checks of pull request ${pr}`);
  const res = await get(gh, `/repos/${cfg.upstream}/actions/jobs/${jobId}/logs`);
  return printableText(res.text.slice(-200_000));
}
