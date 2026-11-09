# Dev VM (contributor model, part 2: the relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent on the dev VM publishes its work as signed pull requests from the bot's fork, reads the maintainer's reviews and answers them, through a relay VM that alone holds the bot's credentials and enforces a fixed policy.

**Architecture:** OpenTofu adds a small relay instance next to the dev VM. A new playbook (`ansible/relay.yml`, role `forge_relay`) hardens it like a forge host and installs `forge-relay`, a TypeScript service from this repository behind an SSH forced command. The dev VM gets a relay client (`forge relay …`) and a key that can only run that command. The relay checks every request, replays the agent's commits as signed commits, scans them with Betterleaks against upstream `main`'s ignore file, and pushes them fast-forward only to the fork, which it creates when missing. The laptop's `forge cloud create` installs and wires both VMs and asks for the bot's token once.

**Tech Stack:** TypeScript on Node 24 (`node --test`, global `fetch`), git (bundles, `commit-tree -S` with SSH signing), Betterleaks 1.10.0, OpenTofu with `hashicorp/aws` 6.x, Ansible (ansible-core ≥ 2.20, `devsec.hardening`).

**Spec:** `docs/superpowers/specs/2026-11-07-dev-vm-contributor-design.md` (§5.2 relay parts, §5.3 relay client, §5.4, §5.6, §5.7, §5.8, §5.10), the acceptance report of part 1 on moroine/agent-forge#103, and the maintainer's decisions of 2026-11-09 below. Read the spec's §5.4 before any relay task.

## Decisions of 2026-11-09 (they override the spec where they differ)

- **Fork, created automatically.** The bot works on a fork, never as a collaborator. The relay creates the fork when it does not exist (`POST /repos/{upstream}/forks`), so the bot account setup has no fork step.
- **`claude setup-token` stays** the dev VM's Claude credential (no Remote Control; revoked only by a global log out, documented in part 1).
- **A deny rule in the dev VM's managed settings** (`/etc/claude-code/managed-settings.json`) on the Claude token file and on `/proc/*/environ`. Defense in depth only: the same user can read both by other means, and the guide says so.
- **The relay also scans the text the bot publishes** (pull request titles and bodies, comments, replies) with Betterleaks, and refuses on a finding.
- **The metadata service and cloud-init are off after the first boot**, held by the OpenTofu configuration and Ansible (part 1 acceptance, step 7).
- **Egress stays open on both VMs** (spec §9). A filtering proxy outside the dev VM, possibly on the relay, is left for later: moroine/agent-forge#117.

## Global Constraints

- Prerequisite: PR moroine/agent-forge#108 merged (VPC `10.100.0.0/16`, subnet `10.100.1.0/24`). The relay's private address is `cidrhost(subnet, 11)` = `10.100.1.11`.
- No personal value in the repository (`CLAUDE.md`, "Sécurité"): no login, email, account ID, region, address, fingerprint. They live in `<laptop state>/hosts/<name>/cloud.json`, the inventories, and `/etc/forge-relay/config.json` on the relay.
- The bot's token and signing key exist only on the relay. The token is pasted at a prompt that does not echo it, travels on ssh's stdin, and never appears in an argv, a log, the audit log, an error, or a file on the Mac. git gets it through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`, never in a URL.
- The relay's operations are exactly: `publish`, `open-pr`, `comment`, `reply`, `read`, `ci`, `ci-log`. API paths are built by the relay from its configuration and validated integers; nothing from the dev VM is a path, a URL, a repository or a ref name except `agent/<task>`.
- Everything the dev VM sends is untrusted: validated before any git or GitHub call. git on the relay runs with `-c core.hooksPath=/dev/null`; the mirror has `transfer.fsckObjects=true`.
- Pushes are fast-forward only: no `+` refspec, no `--force`, no deletion.
- Betterleaks: version and sha256 of `.github/workflows/ci.yml` (1.10.0, `9d9ad503…40fe`); flags `--redact --no-banner --ignore-gitleaks-allow`; `BETTERLEAKS_VALIDATE` and `BETTERLEAKS_ANALYZE` removed from the environment (`env -u`); commit scans use upstream `main`'s `.betterleaksignore` only, passed with `-i` from a fresh temp directory; text scans use no ignore file.
- Caps: PR title 256 characters, PR body 20 000, comment or reply 10 000, 200 commits per publish, request 64 MiB, 20 writes per hour (publish, open-pr, comment, reply; configurable).
- Trusted logins: the maintainer's (from configuration) and the bot's own. Logins compare case-insensitively; GitHub login syntax `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`.
- Bash: `set -e`, quoted variables, preconditions first. Ansible: `ansible-lint` clean.
- Lean tests (the maintainer's preference): the relay's policy is the boundary, so it gets the tests §5.10 lists; nothing tests documentation.
- Language: TypeScript, docs and the plan in English; `CLAUDE.md` in French. Commits: conventional prefixes, French messages, the session's attribution line; signing as the maintainer chooses at execution time; never push.

## Review Focus

1. **Refs and objects crafted by the dev VM.** A bundle that also carries `refs/heads/main`, a branch named `agent/../main` or `agent/x.lock`, a commit whose parent is another task's commit: the relay fetches only `refs/heads/agent/<task>` from the bundle into its own namespace and refuses the rest (Task 2 and Task 4 tests).
2. **A publish that fails halfway** (signing, scan, push rejected): nothing is recorded, the next attempt replays to the same commit IDs (Task 2 determinism test, Task 4 rejected-push test).
3. **Two relay calls at once** (ssh multiplexing, two terminals): state and write counts are updated under one lock (Task 4 lock test).
4. **Escape sequences coming back to the agent's terminal** in issue text, review comments and CI logs: stripped, newlines kept (Task 3 read test).
5. **The agent commits while a publish runs:** the client's alignment is a compare-and-swap, the new commit is kept, and the message says how to continue (Task 6 test).

---

### Task 1: Relay configuration and the public-text policy

**Files:**
- Create: `cli/lib/relay/config.ts`, `cli/lib/relay/text.ts`
- Modify: `cli/lib/printable.ts`
- Test: `tests/relay-text.test.ts`

**Interfaces:**
- Produces:
  - `export class RelayError extends Error {}` (config.ts): a refusal whose message goes back to the agent.
  - `export type RelayConfig = { upstream: string; fork: string; botLogin: string; botName: string; botEmail: string; trustedLogins: string[]; coAuthorEmails: string[]; writesPerHour: number }`
  - `export function parseRelayConfig(json: unknown): RelayConfig` (throws `RelayError` naming the field) and `loadRelayConfig(path: string): RelayConfig`.
  - `export function neutralizeMentions(text: string, allowed: readonly string[]): string`
  - `export function crossReferences(text: string, upstream: string): string[]`
  - `export function checkPublicText(text: string, cfg: RelayConfig, max: number, what: string): string` returns the text with mentions neutralized (allowed = trusted logins + bot).
  - `export const printableText = (text: string): string` (printable.ts): like `printable` but keeps `\n` and `\t`.

- [ ] **Step 1: Write the failing tests** in `tests/relay-text.test.ts`:

```ts
const cfg = parseRelayConfig({ upstream: "acme/widgets", fork: "bot/widgets", botLogin: "bot", botName: "Bot",
  botEmail: "1+bot@users.noreply.github.com", trustedLogins: ["Maint"], coAuthorEmails: ["noreply@anthropic.com"], writesPerHour: 20 });
test("parseRelayConfig refuses a fork the bot does not own", () =>
  assert.throws(() => parseRelayConfig({ ...raw, fork: "other/widgets" }), /fork/));
test("a stranger's mention is put in a code span", () =>
  assert.equal(neutralizeMentions("thanks @stranger and @org/team", ["maint", "bot"]), "thanks `@stranger` and `@org/team`"));
test("trusted mentions, emails and code stay", () => {
  for (const t of ["@MAINT see", "@bot", "a@b.com", "`@x`", "```\n@x\n```"]) assert.equal(neutralizeMentions(t, ["maint", "bot"]), t);
});
test("references to other repositories are found", () => assert.deepEqual(
  crossReferences("other/repo#3 https://github.com/o/r/pull/4/files o/r@abc1234", "acme/widgets"),
  ["other/repo#3", "https://github.com/o/r/pull/4", "o/r@abc1234"]));
test("upstream references stay", () => assert.deepEqual(
  crossReferences("#12 Fixes #12 ACME/Widgets#1 https://github.com/acme/widgets/issues/9", "acme/widgets"), []));
test("checkPublicText refuses a cross-reference and an over-long text", () => {
  assert.throws(() => checkPublicText("see o/r#1", cfg, 100, "the comment"), /another repository/);
  assert.throws(() => checkPublicText("x".repeat(101), cfg, 100, "the comment"), /longer than 100/);
});
test("printableText keeps lines and drops escapes", () => assert.equal(printableText("a\n\tb\x1b[2Jc\x07"), "a\n\tb[2Jc"));
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/relay-text.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `config.ts`, `text.ts` and `printableText`. Mentions: `@` not preceded by a word character or `` ` ``, followed by a login or `org/team`; fenced blocks and inline code spans are left untouched. Cross-references: `owner/repo#N`, `owner/repo@<7–40 hex>`, and `https://github.com/<owner>/<repo>/(issues|pull|discussions|commit)/…` (reported without the path's tail), where `owner/repo` differs from `upstream` ignoring case. `parseRelayConfig` checks owner/repo syntax, `fork`'s owner equals `botLogin` (ignoring case), login syntax, a non-empty `trustedLogins`, emails containing `@`, and an integer `writesPerHour ≥ 1`.
- [ ] **Step 4: Run them and see them pass.** Run: `node --test tests/relay-text.test.ts && npm run check`. Expected: PASS, no type error.
- [ ] **Step 5: Commit.** `git add cli/lib/relay cli/lib/printable.ts tests/relay-text.test.ts && git commit -m "feat: relais, configuration et règles du texte publié"`

### Task 2: Commit checks and the signed, merge-preserving replay

**Files:**
- Create: `cli/lib/relay/policy.ts`, `cli/lib/relay/replay.ts`
- Test: `tests/relay-replay.test.ts`

**Interfaces:**
- Consumes: `RelayConfig`, `RelayError`, `crossReferences`, `neutralizeMentions` (Task 1).
- Produces:
  - `export function validTask(branch: string): string`: `agent/<task>` → `<task>`. Task: `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, no `..`, not ending in `.lock` or `.`; anything else throws `RelayError`.
  - `export type CommitMeta = { sha: string; tree: string; parents: string[]; authorName: string; authorEmail: string; authorDate: string; committerName: string; committerEmail: string; committerDate: string; message: string }` (dates raw, `<epoch> <tz>`, as `GIT_*_DATE` accepts them).
  - `export async function readCommit(ctx: Context, repo: string, sha: string): Promise<CommitMeta>` (parses `git cat-file commit`).
  - `export async function checkCommits(ctx: Context, repo: string, o: { commits: CommitMeta[]; tip: string; upstreamMain: string; base: string | null; cfg: RelayConfig }): Promise<void>`, where `base` is the fork's published head or `null`.
  - `export async function replaySigned(ctx: Context, repo: string, commits: CommitMeta[], signingKey: string, rewrite: (message: string) => string): Promise<string>`: commits oldest first (topological); returns the new tip.

- [ ] **Step 1: Write the failing tests.** Real git in a temp directory (helpers of `tests/lib/git-layout.ts`); a throwaway key from `ssh-keygen -q -t ed25519 -N "" -f <tmp>/key`. Commits are made with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set to the bot unless a test says otherwise.

```ts
test("validTask", () => {
  assert.equal(validTask("agent/fix-1.2_x"), "fix-1.2_x");
  for (const b of ["agent/", "agent/a..b", "agent/.x", "agent/x.lock", "agent/a/b", "main", "refs/heads/agent/x"])
    assert.throws(() => validTask(b), RelayError, b);
});
test("a merge of upstream main is replayed as a merge, signed, with the same tree", async () => {
  // A on main0, merge of main1, B; base null
  const tip = await replaySigned(ctx, repo, commits, key, (m) => m);
  assert.equal(git(repo, "rev-parse", `${tip}^{tree}`), git(repo, "rev-parse", "agent^{tree}"));
  assert.equal(git(repo, "rev-parse", `${tip}^^2`), main1);
  for (const c of git(repo, "rev-list", tip, `^${main1}`).split("\n")) assert.match(git(repo, "cat-file", "commit", c), /^gpgsig /m);
});
test("replaying twice gives the same commits", async () =>   // fingerprints must match CI's
  assert.equal(await replaySigned(ctx, repo, commits, key, id), await replaySigned(ctx, repo, commits, key, id)));
test("refuses an author or a committer that is not the bot", …);           // /author|committer/
test("refuses a Co-authored-by outside the list, any case accepted", …);   // "co-authored-by: X <NoReply@Anthropic.com>" passes
test("refuses a branch built on another task", …);                         // /no stacked tasks/
test("refuses a merge of anything but upstream main", …);                  // /only merges of origin\/main/
test("refuses a commit message that refers to another repository", …);
test("refuses a tip that does not descend from the published head", …);   // /not a fast-forward/
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/relay-replay.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `checkCommits`.** Rules, each refusal naming the commit's short SHA:
  - author and committer name and email equal `botName`/`botEmail`;
  - every `Co-authored-by` trailer (key case-insensitive, read with `git interpret-trailers --parse`) has an email in `coAuthorEmails`, ignoring case;
  - at most 2 parents. Each parent is one of the new commits, `base`, or an ancestor of `upstreamMain` (`merge-base --is-ancestor`); otherwise: "builds on <sha>, which is neither upstream main nor this branch as published: start every task from origin/main (no stacked tasks)";
  - a merge's second parent is an ancestor of `upstreamMain` ("only merges of origin/main are published");
  - no `crossReferences` in a message;
  - at most 200 commits;
  - when `base` is set, `base` is an ancestor of `tip` ("not a fast-forward of the published branch").
- [ ] **Step 4: Implement `replaySigned`.** For each commit: `git -c core.hooksPath=/dev/null -c gpg.format=ssh -c user.signingKey=<key> commit-tree <tree> -S -p <mapped parent>… -F -`. Pass `rewrite(message)` on stdin, and the original author's and committer's names, emails and dates in the environment. A parent that is one of the replayed commits is mapped to its new SHA; any other parent stays as it is. Same inputs give the same SHAs, because Ed25519 SSH signatures are deterministic. If the determinism test cannot pass, stop and report it: the relay's fingerprints and CI's would no longer match (spec §5.4).
- [ ] **Step 5: Run the tests and see them pass.** Run: `node --test tests/relay-replay.test.ts && npm run check`. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: relais, vérification des commits et relecture signée qui garde les merges"`

### Task 3: GitHub operations and the relay's setup check

**Files:**
- Create: `cli/lib/relay/github.ts`, `cli/lib/relay/setup.ts`
- Test: `tests/relay-github.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `export type GitHub = { request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: unknown; text: string }> }`
  - `export function githubClient(token: string, fetchImpl: typeof fetch = fetch, api = "https://api.github.com"): GitHub`. Headers: `Authorization: token …`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: agent-forge-relay`. It follows redirects; fetch drops `Authorization` on a cross-origin redirect.
  - `export async function ensureFork(gh: GitHub, cfg: RelayConfig, sleep: (ms: number) => Promise<void>): Promise<"exists" | "created">`
  - `export async function openPull(gh, cfg, task: string, title: string, body: string): Promise<{ number: number; url: string }>`
  - `export async function comment(gh, cfg, pr: number, body: string): Promise<{ url: string }>`
  - `export async function reply(gh, cfg, pr: number, commentId: number, body: string): Promise<{ url: string }>`
  - `export type ThreadItem = { kind: "body" | "comment" | "review" | "review-comment"; id: number; author: string; createdAt: string; body: string; path?: string; line?: number; inReplyTo?: number }`
  - `export type Thread = { number: number; kind: "issue" | "pull"; title: string | null; state: string; items: ThreadItem[]; hidden: number }`
  - `export async function readThread(gh, cfg, n: number): Promise<Thread>`
  - `export async function ciRuns(gh, cfg, pr: number): Promise<{ id: number; name: string; status: string; conclusion: string | null }[]>`
  - `export async function ciLog(gh, cfg, pr: number, jobId: number): Promise<string>`
  - `export async function relaySetup(ctx: Context, gh: GitHub, cfg: RelayConfig, signingPub: string, sleep): Promise<number>`

- [ ] **Step 1: Write the failing tests.** Use a fake `fetch` that records each request and answers from a table keyed by method and path.

```ts
test("comment refuses a pull request the bot did not open from its fork", …);   // user.login other, or head.repo.full_name other → /not a pull request the bot opened/
test("reply refuses a review comment of another pull request", …);              // pull_request_url …/pulls/8 for pr 7
test("readThread keeps the maintainer's and the bot's text only", async () => {
  const t = await readThread(gh, cfg, 7);
  assert.deepEqual(t.items.map((i) => i.author), ["Maint", "bot"]);
  assert.equal(t.hidden, 2);                    // a stranger's comment and review
  assert.equal(t.items[0].body, "fix [2Jthis\nplease");   // "\x1b[2J" stripped, newline kept
});
test("an issue opened by a stranger hides its title and body", …);              // title null, hidden counts it
test("openPull opens from bot:agent/<task> to main, edits by maintainers off", async () => {
  await openPull(gh, cfg, "t", "Title", "Body");
  assert.deepEqual(sent("POST", "/repos/acme/widgets/pulls"),
    { title: "Title", body: "Body", head: "bot:agent/t", base: "main", maintainer_can_modify: false });
});
test("ensureFork creates a missing fork, then waits for it", …);                // 404, POST /repos/acme/widgets/forks {name:"widgets", default_branch_only:true}, 404, 200
test("ensureFork refuses a repository that is not a fork of upstream", …);
test("ciLog refuses a job that is not one of the pull request's checks", …);
test("setup refuses scopes beyond public_repo and workflow", …);                // X-OAuth-Scopes "public_repo, repo, workflow" → /repo/
test("setup refuses a token without expiry or of another account", …);
test("setup prints the signing key and returns 1 until it is registered", …);
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/relay-github.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Paths.** All paths sit under `/repos/{cfg.upstream}` or `/repos/{cfg.fork}`; numbers are integers in 1…10⁹.
  - **Bot's pull requests.** One helper checks that a pull request belongs to the bot (`user.login` is the bot and `head.repo.full_name` is the fork, ignoring case). `comment`, `reply`, `ciRuns` and `ciLog` call it first.
  - **`reply`.** It checks that `GET /repos/{up}/pulls/comments/{id}` points to that pull request, then posts to `/pulls/{n}/comments/{id}/replies`.
  - **`readThread`.**
    - It reads `/issues/{n}` and `/issues/{n}/comments` (`per_page=100`, at most 10 pages). For a pull request, it also reads `/pulls/{n}/reviews` and `/pulls/{n}/comments`.
    - It keeps only the items whose author is trusted, and passes them through `printableText`. Everything else counts in `hidden`.
  - **`ciRuns` and `ciLog`.** `ciRuns` reads `/commits/{head sha}/check-runs`. `ciLog` checks that the job is one of those runs, reads `/actions/jobs/{id}/logs`, and returns the last 200 000 characters through `printableText`.
  - **`ensureFork`.**
    - It reads `GET /repos/{fork}`. A 200 needs `fork: true` and `parent.full_name` equal to upstream, ignoring case.
    - A 404 creates the fork, then polls every 5 s, 60 times at most.
  - **`relaySetup`.**
    - **Token.** `GET /user`: the login is the bot's, `X-OAuth-Scopes` is exactly {`public_repo`, `workflow`}, and `GitHub-Authentication-Token-Expiration` is present.
    - **Fork.** It calls `ensureFork`.
    - **Signing key.** It reads `GET /users/{bot}/ssh_signing_keys` and compares key type and base64.
    - **When the key is not registered.** It prints the key, with "register it on <bot>'s account: Settings → SSH and GPG keys → New SSH key, key type Signing Key", and returns 1.
    - **Finally.** It prints that GitHub disables Actions on a new fork and that the maintainer should check the fork's Actions tab once, then returns 0.
- [ ] **Step 4: Run the tests and see them pass.** Run: `node --test tests/relay-github.test.ts && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: relais, opérations GitHub sur les PR du bot, lecture filtrée par auteur, fork créé au besoin"`

### Task 4: Secret scans, relay state and `publish`

**Files:**
- Create: `cli/lib/relay/scan.ts`, `cli/lib/relay/state.ts`, `cli/lib/relay/paths.ts`, `cli/lib/relay/publish.ts`, `tests/fixtures/fake-betterleaks` (executable)
- Test: `tests/relay-publish.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `export type RelayPaths = { config: string; token: string; signingKey: string; mirror: string; stateDir: string; audit: string; githubBase: string }` and `export const RELAY_PATHS: RelayPaths`, with:
    - `config`: `/etc/forge-relay/config.json`;
    - `token`: `/etc/forge-relay/github-token`;
    - `signingKey`: `/var/lib/forge-relay/signing-key`;
    - `mirror`: `/var/lib/forge-relay/mirror.git`;
    - `stateDir`: `/var/lib/forge-relay`;
    - `audit`: `/var/log/forge-relay/audit.log`;
    - `githubBase`: `https://github.com`.

    The tests point `githubBase` at local bare repositories laid out as `<owner>/<repo>.git`.
  - `export type Finding = { rule: string; file: string; line: number; commit: string; fingerprint: string }`
  - `export async function scanCommits(ctx: Context, repo: string, range: string, ignoreText: string | null): Promise<Finding[]>`
  - `export async function scanText(ctx: Context, text: string): Promise<Finding[]>`
  - `export type RelayState = { published: Record<string, string>; writes: number[] }`
  - `export async function withState<T>(dir: string, fn: (s: RelayState) => Promise<T>): Promise<T>` (lock `<dir>/lock` created by `mkdir`; retries every 100 ms for 30 s; removes a lock older than 15 minutes; atomic write of `state.json`)
  - `export function takeWrite(s: RelayState, now: number, perHour: number): void`
  - `export type RelayDeps = { ctx: Context; cfg: RelayConfig; paths: RelayPaths; github: GitHub; sleep: (ms: number) => Promise<void>; now: () => number }`
  - `export async function publish(d: RelayDeps, req: { branch: string; bundle: Buffer }): Promise<{ head: string; url: string; bundle: Buffer }>`: the returned bundle carries `refs/relay/published/agent/<task>`.

- [ ] **Step 1: Write the fake.** `tests/fixtures/fake-betterleaks` (bash, `set -e`):
  - it appends its argv and the content of the `.betterleaksignore` in its `-i` directory to `$FAKE_BL_LOG`;
  - when `$FAKE_BL_FIND=1`, it writes a one-finding report to `--report-path` and exits 1;
  - otherwise it exits 0.
- [ ] **Step 2: Write the failing tests.**
  - Layout: `upstream` and `fork` bare repositories under a temp `githubBase`, the relay's mirror, and a dev clone that commits as the bot and builds bundles with `git bundle create b refs/heads/agent/t ^origin/main [^fork/agent/t]`.
  - The fake GitHub answers 200 to `GET /repos/bot/widgets`.
  - The fake Betterleaks comes first on `PATH`.

```ts
test("publishes a new branch: signed commits on the fork, the agent's tree, recorded", …);
test("a second publish replays only the new commits and fast-forwards", …);
test("refuses when the fork's branch moved since the relay published it", …);    // push to fork by hand → /moved/
test("adopts an unrecorded fork branch of the bot's commits, refuses one with another author", …);
test("a Betterleaks finding refuses the publish and pushes nothing", …);
test("the scan reads upstream main's .betterleaksignore, never the branch's", async () => {
  // main's file holds "main-entry", the branch adds one holding "branch-entry"
  await publish(deps, req);
  const log = fs.readFileSync(blLog, "utf8");
  assert.match(log, /main-entry/); assert.doesNotMatch(log, /branch-entry/);
});
test("a bundle's other refs are ignored", …);                                    // bundle also carries refs/heads/main → refs/relay/upstream/main unchanged
test("a rejected push records nothing", …);                                      // fork's pre-receive exits 1 → state.published empty
test("takeWrite refuses past the hourly cap", () => { /* 2 per hour: third throws /write cap/, an hour later passes */ });
test("withState removes a lock older than 15 minutes", …);
test("two withState calls at once run one after the other", …);           // both increment a counter read-then-written with a delay → 2
```

- [ ] **Step 3: Run them and see them fail.** Run: `node --test tests/relay-publish.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `scanCommits` and `scanText`.**
  - Both run `env -u BETTERLEAKS_VALIDATE -u BETTERLEAKS_ANALYZE betterleaks` with `--redact --no-banner --ignore-gitleaks-allow -i <fresh temp dir> --report-format json --report-path <tmp>`:
    - commits: `git --log-opts=--diff-merges=remerge <range> <repo>`;
    - text: `stdin`, with the text on stdin.
  - `ignoreText` goes into the temp directory as `.betterleaksignore`; for text, the directory stays empty.
  - When upstream `main` has a `.betterleaks.toml` (`git show refs/relay/upstream/main:.betterleaks.toml`), both scans pass it with `--config` from the temp directory. The branch's own config file is never read.
  - Exit codes: 0 means no finding; 1 means the report's findings; anything else throws `RelayError("Betterleaks failed")`.
- [ ] **Step 5: Implement `publish`.** In order:
  1. `validTask`, then `ensureFork`.
  2. Fetch into the mirror, anonymously, with `--no-tags`:
     - upstream `+refs/heads/main:refs/relay/upstream/main`;
     - the fork's `+refs/heads/agent/<t>:refs/relay/fork/agent/<t>`. When the fork has no such branch, delete the local ref.
  3. Under `withState`, check the fork's head:
     - if a head is recorded, the fork's head must equal it. Otherwise refuse: "the fork's agent/<t> moved since the relay published it: nothing was published; the maintainer never commits to the bot's branches";
     - if none is recorded but the fork has the branch, adopt it only when every commit of `forkHead ^upstreamMain` is the bot's (same author and committer rule as Task 2).
  4. Write the bundle to a temp file and run `git bundle verify`. On failure: "the branch needs commits the relay does not have: start from origin/main". Then `git fetch <bundle> +refs/heads/agent/<t>:refs/relay/incoming/agent/<t>`, with that refspec only.
  5. `commits` = `rev-list --topo-order --reverse incoming ^upstreamMain [^forkHead]`, then `readCommit` on each. If there are none, refuse: "nothing new to publish". Then `checkCommits`.
  6. `replaySigned`, with `rewrite` = `neutralizeMentions`. Then assert that the new tip's tree equals the incoming tip's tree.
  7. `scanCommits` on the range `<forkHead or upstreamMain>..<newTip>`, with `git show refs/relay/upstream/main:.betterleaksignore` as `ignoreText` (null when absent).
     - A finding refuses with each redacted `rule in file:line (commit <short>, fingerprint <fp>)` listed, then: "Nothing was published. A false positive is cleared by the maintainer: its fingerprint goes into .betterleaksignore on main."
  8. `takeWrite`.
  9. Push `<newTip>:refs/heads/agent/<t>` to the fork, with the token in `GIT_CONFIG_*`. A rejection refuses: "the fork's agent/<t> moved during the publish".
  10. Record `published[t]`, then answer:
      - `url`: `https://github.com/<fork>/tree/agent/<t>`;
      - `bundle`: `git bundle create - refs/relay/published/agent/<t> ^<forkHead or upstreamMain>`.
- [ ] **Step 6: Run the tests and see them pass.** Run: `node --test tests/relay-publish.test.ts && npm run check`. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat: relais, publication d'une branche : scan Betterleaks contre main, push en avance rapide"`

### Task 5: The forced-command server and `forge-relay`

**Files:**
- Create: `cli/lib/relay/serve.ts`, `cli/forge-relay.ts`, `cli/forge-relay` (executable shim; same Node ≥ 24 guard as `cli/forge`)
- Test: `tests/relay-serve.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `export const OPS = ["publish", "open-pr", "comment", "reply", "read", "ci", "ci-log"] as const`
  - `export async function serve(d: RelayDeps, op: string | undefined, input: Buffer): Promise<string>`: one JSON line, `{"ok":true,…}` or `{"ok":false,"error":"…"}`.
  - The requests, exact fields only (any other field is refused):
    - `publish`: `{branch, bundle}`, where `bundle` is base64;
    - `open-pr`: `{branch, title, body}`;
    - `comment`: `{pr, body}`;
    - `reply`: `{pr, commentId, body}`;
    - `read`: `{number}`;
    - `ci`: `{pr}`;
    - `ci-log`: `{pr, job}`.
  - The answers:
    - `publish`: `{head, url, bundle}`;
    - `open-pr`: `{number, url}`;
    - `comment` and `reply`: `{url}`;
    - `read`: `{thread}`;
    - `ci`: `{runs}`;
    - `ci-log`: `{log}`.
  - `cli/forge-relay.ts`:
    - `forge-relay serve`: the op comes from `SSH_ORIGINAL_COMMAND`; it reads stdin (64 MiB cap) and writes the line to stdout;
    - `forge-relay setup`: runs `relaySetup` with `RELAY_PATHS`.

    Both refuse to run as root.

- [ ] **Step 1: Write the failing tests.**

```ts
test("an unknown operation is refused and audited", …);            // op "merge" → ok:false, audit line outcome "refused"
test("a malformed request or an unknown field is refused", …);
test("a comment referring to another repository is refused before any GitHub call", …);
test("a Betterleaks finding in a pull request body refuses it before any GitHub call", …);
test("open-pr is refused for a branch the relay has not published", …);
test("the write cap refuses the third comment of the hour", …);    // writesPerHour 2
test("the audit log never holds the texts", async () => {
  await serve(deps, "comment", json({ pr: 7, body: "SECRET-BODY-TEXT" }));
  assert.doesNotMatch(fs.readFileSync(auditPath, "utf8"), /SECRET-BODY-TEXT/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/relay-serve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `serve`.**
  - **Before GitHub.** Writes run `checkPublicText` (caps from Global Constraints), then `scanText`. A finding refuses: "Betterleaks found a possible secret in the <what> (rule <r>): nothing was sent; rewrite it without the secret".
  - **Write cap.** `comment`, `reply` and `open-pr` call `takeWrite` under `withState`. `open-pr` also checks that `published` has the branch.
  - **Errors.** A `RelayError` answers with its message. Any other error answers "internal error (logged on the relay)", and its stack goes to the audit log only.
  - **Audit.** One JSON line per request, mode 0600:
    - `time`, `op`;
    - `branch`, `pr`, `commentId`, `job` or `number`;
    - the length and sha256 of each text, and the bundle's size;
    - `outcome` (`ok`, `refused` or `error`) and `detail`.
- [ ] **Step 4: Run the tests and see them pass.** Run: `node --test tests/relay-serve.test.ts && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: forge-relay, commande forcée SSH : liste fermée d'opérations, plafond d'écritures, journal d'audit"`

### Task 6: The dev VM's client, `forge relay`

**Files:**
- Create: `cli/lib/relay/client.ts`, `cli/lib/commands/relay.ts`
- Modify: `cli/forge.ts` (usage line and dispatch)
- Test: `tests/relay-client.test.ts`

**Interfaces:**
- Consumes: the request and answer shapes of Task 5.
- Produces:
  - `export type RelayClientConfig = { address: string; user: string; key: string; knownHosts: string }`, read from `~/.config/agent-forge/relay.json` (Task 9 writes it). When it is missing: "no relay on this host: forge relay works on the contributor's dev VM".
  - `export async function relayCall(ctx: Context, cfg: RelayClientConfig, op: string, request: object): Promise<Record<string, unknown>>`. It runs ssh with:
    - `-F /dev/null -i <key> -o IdentitiesOnly=yes`;
    - `-o UserKnownHostsFile=<knownHosts> -o StrictHostKeyChecking=yes -o BatchMode=yes`;
    - `-o ControlMaster=auto -o ControlPath=<dir of key>/cm-%C -o ControlPersist=60`;
    - then `<user>@<address> <op>`.

    The request is the JSON on stdin. `ok:false` becomes a `ForgeError`.
  - Usage: `forge relay publish [<task>] | pr <task> --title <text> --body-file <file|-> | comment <pr> --body-file <file|-> | reply <pr> <comment-id> --body-file <file|-> | read <number> | ci <pr> [<job-id>]`

- [ ] **Step 1: Write the failing tests.** Use real git and a fake `ssh` in `hybridContext` that answers canned JSON. Its `publish` answer carries a bundle of a commit with the same tree, made in the test's "fork".

```ts
test("publish aligns the local branch on the published head", …);   // refs/heads/agent/t == head, refs/remotes/fork/agent/t == head, status clean
test("a commit made during the publish is kept, and the message says how to continue", …); // fake ssh commits first → /moved during the publish/, branch keeps the new commit
test("publish refuses a branch outside agent/*", …);
test("ssh never forwards the agent and checks the relay's host key", () => {
  assert.ok(argv.includes("StrictHostKeyChecking=yes") && argv.includes("BatchMode=yes"));
  assert.ok(!argv.some((a) => /ForwardAgent=yes/.test(a)));
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/relay-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`publish`.**
    - **Branch and bundle.** The task defaults to the current branch, which must be `agent/*`. The bundle is `refs/heads/agent/<t> ^refs/remotes/origin/main`, plus `^refs/remotes/fork/agent/<t>` when that ref exists. The client sends it in base64.
    - **After the answer.** It fetches the answer's bundle into `+refs/remotes/fork/agent/<t>` and checks that the published head's tree equals the tip it sent.
    - **Alignment.** `git update-ref refs/heads/agent/<t> <head> <tip sent>`. On failure: "agent/<t> moved during the publish: it was published at <short>; move your new commits onto fork/agent/<t> (git rebase fork/agent/<t>)".
    - **Output.** It prints the head and the URL.
  - **`read`.** It prints each item as `--- <kind> <id> by <author>, <date>[, <path>:<line>]` followed by its body, then "<n> items from other accounts hidden".
- [ ] **Step 4: Run the tests and see them pass.** Run: `node --test tests/relay-client.test.ts && npm test && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: forge relay, le client du relais sur la VM de dev"`

### Task 7: OpenTofu: the relay instance; the laptop's driver

**Files:**
- Modify: `infra/aws/main.tf`, `infra/aws/variables.tf`, `infra/aws/outputs.tf`, `cli/lib/laptop/cloud.ts`
- Test: `tests/laptop-cloud.test.ts`

**Interfaces:**
- Produces:
  - **New variables.**
    - `relay_instance_type`, default `"t3.small"`;
    - `relay_disk_gb`, default `20`;
    - `dev_metadata_enabled` and `relay_metadata_enabled`, both `bool`.
  - **New outputs.** `relay_address` (Elastic IP), `relay_private_ip`, `subnet_cidr`.
  - `export const RELAY_INSTANCE = "aws_instance.relay"`
  - `export type Metadata = { dev: boolean; relay: boolean }`
  - `renderTfvars(infra: Infra, running: boolean, metadata: Metadata): string`
  - `applyInteractive(ctx, infra, metadata: Metadata, extra?: string[])`
  - `applyQuiet(ctx, infra, running)`: always applies with `{ dev: false, relay: false }`.
  - `export async function infraOutputs(ctx, infra): Promise<{ address: string; relayAddress: string; relayPrivateIp: string; subnetCidr: string }>`, which replaces `infraAddress`.

- [ ] **Step 1: Write the failing tests** for `applyQuiet` (fake `tofu show -json` plans):
  - it accepts a change of the relay security group's maintainer source;
  - it refuses a change of the relay rule sourced from the dev security group;
  - it accepts `metadata_options[0].http_endpoint` from `enabled` to `disabled` on either instance, refuses `disabled` to `enabled`, and refuses any other instance change (`instance_type`);
  - it accepts `aws_ec2_instance_state.relay`.
  - `renderTfvars` carries both metadata flags.
- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/laptop-cloud.test.ts`. Expected: FAIL.
- [ ] **Step 3: OpenTofu.**
  - **`aws_security_group.relay`.** Inline rules, as for the dev VM:
    - SSH from `var.ssh_cidr`;
    - SSH from `security_groups = [aws_security_group.dev.id]`, with a comment that this is the relay's only service port (SSH forced command);
    - egress open.
  - **`aws_instance.relay`.**
    - same AMI, subnet and cloud-init template as the dev VM;
    - `private_ip = cidrhost(aws_subnet.dev.cidr_block, 11)`;
    - no `cpu_options`;
    - metadata `http_endpoint = var.relay_metadata_enabled ? "enabled" : "disabled"`, tokens `required`, hop limit 1;
    - gp3 root disk, encrypted;
    - the same `ignore_changes`.
  - **`aws_eip.relay`** (with `depends_on` the internet gateway) and **`aws_ec2_instance_state.relay`** on `var.running`.
  - **The dev instance's `http_endpoint`** follows `var.dev_metadata_enabled`.
  - **No alarm for the relay** (spec §5.2).
- [ ] **Step 4: Driver.**
  - **The source check.** `setsSshSourceOnly` now covers both groups:
    - a rule with a non-empty `security_groups` must be identical before and after;
    - every other rule must open to `[sshCidr]` after.
  - **The quiet actions.** `quietAction` allows both instance-state resources, both groups, and, on both instances, an update whose only difference is `http_endpoint` going from `"enabled"` to `"disabled"`.
  - **The existing callers**, so that this task compiles on its own:
    - `cloudVm` applies with `{ dev: !reached, relay: !reached }` and reads `infraOutputs(…).address`;
    - `rebuild` applies with `{ dev: true, relay: false }`.

    Task 10 refines `cloudVm`.
- [ ] **Step 5: Run the tests and see them pass.** Run: `node --test tests/laptop-cloud.test.ts && npm run check && tofu -chdir=infra/aws init -backend=false && tofu -chdir=infra/aws validate`. Expected: PASS, "The configuration is valid".
- [ ] **Step 6: Commit.** `git commit -m "feat: infra/aws, la VM du relais ; service de métadonnées coupé après le premier boot"`

### Task 8: Ansible: `relay.yml` and the role `forge_relay`

**Files:**
- Modify:
  - `ansible/roles/hardening/vars/main.yml` → move `hardening_sysctl_overwrite`, `hardening_ssh_allow_users` and `hardening_ssh_match_user` to a new `ansible/roles/hardening/defaults/main.yml`, unchanged;
  - `ansible/roles/hardening/tasks/main.yml`: pass a new default `hardening_ssh_match_address: []` as devsec's `ssh_server_match_address`;
  - `ansible/preflight/inputs.yml`: move the two forge user checks to a new `ansible/preflight/forge_users.yml`, which `site.yml`'s preflight imports right after `inputs.yml`;
  - `ansible/tests/unit/site_structure.yml`, `ansible/tests/unit.yml`, `ansible/tests/unit-inventory.yml`.
- Create:
  - `ansible/relay.yml`;
  - `ansible/roles/forge_relay/{defaults/main.yml,tasks/main.yml,tasks/inputs.yml,tasks/release.yml,templates/config.json.j2}`;
  - `ansible/tests/unit/forge_relay.yml`.

**Interfaces:**
- **Inventory inputs** (no defaults):
  - `forge_relay_upstream`, `forge_relay_fork`, `forge_relay_bot_login`, `forge_relay_bot_name`, `forge_relay_bot_email`;
  - `forge_relay_trusted_logins` (a list);
  - `forge_relay_client_cidr` (the subnet).
- **Defaults:**
  - `forge_relay_co_author_emails: ["noreply@anthropic.com"]`;
  - `forge_relay_writes_per_hour: 20`.
- **Extra var:** `forge_relay_client_key_file`, the controller path of the dev VM's relay key, public half.
- **On the relay:**
  - the user `forge-relay`: an ordinary account (UID ≥ 1000), so that devsec does not give it a nologin shell, which the forced command needs. Shell `/bin/sh`, password locked, home `/var/lib/forge-relay` (0700);
  - `/usr/local/bin/forge-relay` → `<release>/cli/forge-relay`;
  - the `RELAY_PATHS` of Task 4.

- [ ] **Step 1: Write the failing unit cases** in `ansible/tests/unit/forge_relay.yml`, following `unit/forge_contributor.yml`:
  - a fork the bot does not own fails;
  - an empty trusted list fails;
  - a bad CIDR fails;
  - a client key file that is not one `ssh-ed25519` line fails;
  - good inputs pass.

  `site_structure.yml` also pins `relay.yml`'s role order: base, hardening, firewall, fail2ban, forge_relay.
- [ ] **Step 2: Run them and see them fail.** Run: `npm run test:ansible`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement `relay.yml`.**
  - **Preflight play.** It imports `inputs.yml` (not `forge_users.yml`), `controller.yml`, `port.yml` and `target.yml`, then the role's `inputs.yml`.
  - **Provision play.** `become`, `force_handlers`, the apt `lock_timeout` of `site.yml`, and these vars:
    - `hardening_sysctl_overwrite: {}`;
    - `hardening_ssh_allow_users: "{{ forge_admin_user }} forge-relay"`;
    - `hardening_ssh_match_user: []`;
    - `hardening_ssh_match_address: [{address: "{{ forge_relay_client_cidr }}", rules: ["AllowUsers forge-relay"]}]`.

    Then the roles base, hardening, firewall, fail2ban and forge_relay, each through `import_role`.
- [ ] **Step 4: Implement the role.**
  - **Packages.** git, openssh-client, Node 24 (NodeSource through `base`'s `apt_repo.yml`, with the key and URI of `forge_users`' defaults, copied there with a "keep in step" comment).
  - **Betterleaks.** Pinned like `forge_contributor`'s, with the same "keep in step" comment.
  - **The user and the directories.**
    - `/etc/forge-relay`: 0750, owner root, group forge-relay;
    - `/var/log/forge-relay`: 0700, owner forge-relay.
  - **The release** (`release.yml`).
    - It mirrors `forge_users/tasks/forge.yml`: an archive of the controller's HEAD, unpacked to a staging directory then renamed, under `/opt/forge-relay/releases/<sha>`, older releases pruned.
    - It warns when the controller's HEAD is not an ancestor of `origin/main` (spec §5.8).
  - **The configuration.** `config.json` from the template, 0640, owner root, group forge-relay.
  - **The signing key.** `ssh-keygen -t ed25519 -N "" -C forge-relay-signing -f /var/lib/forge-relay/signing-key`, as forge-relay, with `creates:`.
  - **The mirror.** `git init --bare /var/lib/forge-relay/mirror.git`, with `transfer.fsckObjects true` and `core.hooksPath /dev/null`.
  - **`authorized_keys`.** One exclusive line: `restrict,command="/usr/local/bin/forge-relay serve",from="{{ forge_relay_client_cidr }}" ` followed by the key read from `forge_relay_client_key_file` on the controller.
  - **cloud-init.** Off: `/etc/cloud/cloud-init.disabled`.
  - **The token.** The role never creates `/etc/forge-relay/github-token`: the laptop writes it (Task 10).
- [ ] **Step 5: Run the tests and see them pass.** Run: `npm run test:ansible && ansible-lint ansible/`. Expected: PASS, no violation.
- [ ] **Step 6: Commit.** `git commit -m "feat: ansible, playbook relay.yml et rôle forge_relay"`

### Task 9: Ansible: the dev VM's side (client key, relay link, deny rule, cloud-init)

**Files:**
- Modify: `ansible/roles/forge_contributor/defaults/main.yml`, `tasks/inputs.yml`, `tasks/main.yml`, `ansible/tests/unit/forge_contributor.yml`, `ansible/tests/unit-inventory.yml`
- Create: `ansible/roles/forge_contributor/tasks/relay.yml`, `templates/relay.json.j2`, `templates/managed-settings.json.j2`

**Interfaces:**
- **Extra vars from the laptop** (Task 10):
  - `forge_contributor_relay_address`: an IPv4 address;
  - `forge_contributor_relay_host_key`: matches `^ssh-ed25519 [A-Za-z0-9+/=]+$`;
  - `forge_contributor_relay_client_pub_dest`: a controller path.
- **What the role writes**, in the forge user's home:
  - `~/.config/agent-forge/relay/key` and `key.pub`;
  - `~/.config/agent-forge/relay/known_hosts`;
  - `~/.config/agent-forge/relay.json`, with `{address, user: "forge-relay", key, knownHosts}` as absolute paths.

- [ ] **Step 1: Write the failing unit cases.** A host key of another type and a non-IPv4 address both fail.
- [ ] **Step 2: Run them and see them fail.** Run: `npm run test:ansible`. Expected: FAIL.
- [ ] **Step 3: Implement `relay.yml`.**
  - **The client key.** `relay/` is 0700. The key comes from `ssh-keygen -t ed25519 -N "" -C forge-relay-client`, run as the forge user, with `creates:`. Its public half goes to the controller with `fetch` (`flat: true`, to `forge_contributor_relay_client_pub_dest`).
  - **The relay's address and key.** `known_hosts` holds one line: `<address> <host key>`. `relay.json` comes from its template.
  - **The deny rule.** `/etc/claude-code/managed-settings.json` (root, 0644), with `{"permissions": {"deny": ["Read(~/.config/agent-forge/claude-token)", "Read(//proc/*/environ)", "Read(//proc/*/task/*/environ)"]}}`. A comment says it is defense in depth: the same user can read both by other means.
  - **cloud-init.** Off: `/etc/cloud/cloud-init.disabled`.
- [ ] **Step 4: Run the tests and see them pass.** Run: `npm run test:ansible && ansible-lint ansible/`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: forge_contributor, lien vers le relais, règle deny sur le token Claude, cloud-init coupé"`

### Task 10: Laptop: installing and rebuilding the relay

**Files:**
- Modify:
  - `cli/lib/laptop/state.ts`: `InstallStep` gains `"relay"`; `LaptopHost` gains `relayAddress?: string`; new paths `relayInventoryPath(name)`, `relayLinkPath(name)` (`relay-link.json`) and `relayClientKeyPath(name)` (`relay-client.pub`), all in `hostDir(name)`;
  - `cli/lib/laptop/cloud.ts`: `CloudSettings` gains optional `trustedLogins?: string[]` and `coAuthorEmails?: string[]`; new `askRelaySettings(ctx): Promise<{ trustedLogins: string[]; coAuthorEmails: string[] }>`;
  - `cli/lib/laptop/inventory.ts`: `renderRelayInventory`;
  - `cli/lib/laptop/host-steps.ts`: `ensureRelayCredentials`;
  - `cli/lib/commands/install.ts`, `cli/lib/commands/cloud.ts`, `cli/forge.ts`.
- Test: `tests/install.test.ts`, `tests/cloud.test.ts`, `tests/laptop-host-steps.test.ts`, `tests/laptop-inventory.test.ts`

**Interfaces:**
- Consumes: `infraOutputs`, `Metadata`, `RELAY_INSTANCE` (Task 7); the inputs of Tasks 8 and 9.
- Produces:
  - `CLOUD_STEPS = ["vm", "inventory", "playbook", "ssh", "claude", "relay"]`. An existing host's `done` lacks `"relay"`, so `forge cloud start` sends it to `forge cloud create --host` first. That is the migration.
  - `export function renderRelayInventory(h: LaptopHost, s: CloudSettings, o: { adminKeyFile: string; knownHosts: string; subnetCidr: string }): string`, written once next to `inventory.yml`. Host `<name>-relay` at `h.relayAddress`, with the same `ssh_common_args` as a cloud host's. Vars:
    - `forge_exposure: "public"`;
    - `forge_relay_bot_login`, the fork's owner;
    - `forge_relay_upstream`, `forge_relay_fork`, `forge_relay_bot_name`, `forge_relay_bot_email`;
    - `forge_relay_trusted_logins`, `forge_relay_co_author_emails`;
    - `forge_relay_client_cidr` = `subnetCidr`.
  - `export async function ensureRelayCredentials(ctx: Context, host: LaptopHost): Promise<"stored" | "already">`
  - The `forge cloud rebuild-relay` subcommand (usage updated).

- [ ] **Step 1: Write the failing tests.**

```ts
test("the relay step refuses a token that is not a classic one, and never prints it", …);   // "github_pat_…" → /classic/, output lacks it
test("the bot token reaches the relay on ssh's stdin, never in an argv", …);
test("the relay's first connection happens while its key is unknown", …);
test("the playbook step runs contributor.yml with the relay link, then relay.yml", …);     // argv order, -e @relay-link.json, -i relay-inventory.yml
test("rebuild-relay replaces only the relay and redoes the playbook and the relay step", …); // -replace=aws_instance.relay, metadata {dev:false, relay:true}, done lacks playbook and relay
test("start refuses a host whose install lacks the relay step", …);
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test tests/install.test.ts tests/cloud.test.ts tests/laptop-host-steps.test.ts tests/laptop-inventory.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
  - **`cloudVm`.**
    - It applies with `{ dev: !reached, relay: relayAddress unknown in forge's known_hosts }`. To check the relay's address, it runs `ssh-keygen -F <address> -f <known_hosts>`.
    - It records `address` and `relayAddress` from `infraOutputs` in `hosts.json`. The inventory and playbook steps call `infraOutputs` again for `relayPrivateIp` and `subnetCidr`: those are not recorded.
    - It waits for SSH on both: `waitForSsh` and `adminSsh` take the address as a parameter.
    - It makes the relay's first connection when its key is unknown.
  - **Inventory step.**
    - It asks `askRelaySettings` once when `trustedLogins` is missing ("GitHub logins the agent takes instructions from (yours), comma-separated", checked with the login syntax). `coAuthorEmails` defaults to `["noreply@anthropic.com"]` and is not asked.
    - It writes both inventories once.
  - **Playbook step.**
    - It writes `relay-link.json`: the relay's private address, the relay's `ssh-ed25519` key from forge's `known_hosts` (`ssh-keygen -F`), and `relayClientKeyPath`.
    - It runs `contributor.yml` with `-e @<relay-link.json>`, then `relay.yml` with `-i <relay-inventory.yml> -e forge_relay_client_key_file=<relayClientKeyPath>`.
  - **`ensureRelayCredentials`**, by the admin's SSH to `relayAddress`:
    - `sudo test -s /etc/forge-relay/github-token`;
    - when the token is missing:
      1. it prints the bot account steps (account with two-factor on; a classic token with only `public_repo` and `workflow`, and an expiry date);
      2. `askSecret("Bot token")`, which must match `^ghp_[A-Za-z0-9]{36}$`;
      3. `sudo install -o forge-relay -g forge-relay -m 600 /dev/stdin /etc/forge-relay/github-token`, with the token on stdin;
    - then it attaches `sudo -u forge-relay /usr/local/bin/forge-relay setup`. A non-zero exit means: "the relay's setup is not complete: do what it says above, then run forge cloud create --host <name> again".
  - **`rebuild-relay`.**
    - It asks for confirmation. The text says the bot's token and signing key go with the relay.
    - It applies with `-replace=aws_instance.relay` and `{ dev: false, relay: true }`, then `forgetHostKeys(ctx, [host.relayAddress])`.
    - It removes `playbook` and `relay` from `done`, then calls `cmdInstall`.
    - Last, it prints the rotation runbook: revoke the old token, remove the old signing key on the bot's account (spec §5.7).
  - **The other callers.**
    - `rebuild` applies with `{ dev: true, relay: false }`;
    - `start` and `stop` keep `applyQuiet`.
- [ ] **Step 4: Run the tests and see them pass.** Run: `npm test && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: forge cloud, installation du relais, jeton du bot, rebuild-relay"`

### Task 11: Documentation, the agent's rules, the spec

**Files:**
- Modify: `CLAUDE.md` ("Sur la VM de dev (modèle contributeur)"), `docs/contributor-model.md`, `CONTRIBUTING.md`, `README.md` (only if the guide's line is missing), `docs/superpowers/specs/2026-11-07-dev-vm-contributor-design.md`

- [ ] **Step 1: `CLAUDE.md`, in French.**
  - The relay is in place.
  - The agent publishes and answers only through `forge relay`:
    - `publish`, which aligns the local branch on the signed commits;
    - `pr`, `comment`, `reply`;
    - `read` for the maintainer's comments, which the relay filters by author;
    - `ci`.
  - What the relay refuses, and that a refusal is reported to the maintainer, never worked around: stacked tasks, other authors, cross-repository references, secrets.
  - The rest of the section stays.
- [ ] **Step 2: `docs/contributor-model.md`.**
  - the status;
  - the bot account setup:
    - an account with two-factor on;
    - a classic token with `public_repo` and `workflow` and an expiry date;
    - the signing key, which `forge cloud create` prints;
    - no collaborator;
    - the fork, which the relay creates;
    - a one-time look at the fork's Actions tab;
  - Settings → Actions → "Require approval for all outside collaborators" (spec §5.8);
  - the relay's operations and refusals, with the false-positive flow (a fingerprint in `.betterleaksignore` on `main`; #102 settled for this model);
  - `forge cloud rebuild-relay` and the rotation runbook; the incident runbooks of §5.7, updated;
  - the managed-settings deny rule, as defense in depth;
  - the metadata service and cloud-init, off after the first boot;
  - the relay's cost.
- [ ] **Step 3: `CONTRIBUTING.md`.** The files that get extra scrutiny: `cli/lib/relay/`, `cli/forge-relay*`, `ansible/roles/forge_relay/`, `ansible/relay.yml`, `container/pre-bash.sh`, `CLAUDE.md`, `.github/workflows/`.
- [ ] **Step 4: The spec.** A dated "Decisions of 2026-11-09" paragraph in §3, and in §5.4/§5.7:
  - the fork is created by the relay;
  - the text scan;
  - the deny rule;
  - `setup-token` kept;
  - the transport chosen: an SSH forced command, a JSON request, the git objects in a bundle.
- [ ] **Step 5: Verify.** Run: `npm test`. Expected: PASS. The doc tests check only links and structure.
- [ ] **Step 6: Commit.** `git commit -m "docs: le relais du modèle contributeur"`

### Task 12: Acceptance on AWS (the maintainer drives, the builder guides)

- [ ] **Step 1: Create.** `forge cloud create --host <name>` from a checkout of this branch.
  - The plan adds the relay's resources and turns the dev VM's metadata service off in place.
  - The relay's first connection asks about its key.
  - Both playbooks pass.
  - The relay step asks for the bot token. `forge-relay setup` prints the signing key; register it, then run `create --host` again. The fork is created when it is missing.
- [ ] **Step 2: Publish.** On the dev VM, the agent:
  1. makes `agent/relay-smoke` from `origin/main` with one commit;
  2. runs `forge relay publish`, then `forge relay pr relay-smoke --title … --body-file …`.

  On GitHub, check:
  - the commits show "Verified" as the bot;
  - the pull request comes from `bot:agent/relay-smoke`, with "Allow edits by maintainers" off;
  - the workflow run waits for approval.
- [ ] **Step 3: Review loop.**
  1. The maintainer comments and leaves a review comment.
  2. `forge relay read <n>` shows both, and hides a comment from any other account.
  3. `forge relay reply` answers in the thread.
  4. A second commit, then `publish` again, fast-forwards the branch.
- [ ] **Step 4: Refusals.** Each one is refused, with nothing published:
  - a branch built on `agent/relay-smoke`;
  - a commit adding a test-pattern AWS key;
  - a comment naming `other/repo#1`.

  A comment mentioning `@someone` is published with the mention in a code span.
- [ ] **Step 5: The VMs.**
  - `curl -m 2 -X PUT http://169.254.169.254/latest/api/token` fails on both VMs.
  - `/etc/cloud/cloud-init.disabled` exists on both.
  - Ask the agent to read `~/.config/agent-forge/claude-token`: Claude Code refuses. Note what the rule blocks and what it does not.
- [ ] **Step 6: Stop, start, rebuild.**
  - `forge cloud stop` and `forge cloud start`: both instances, and a publish works afterwards.
  - `forge cloud rebuild-relay`, then the rotation: a new token, a new key registered, the old ones revoked. `publish` adopts the existing fork branch.
- [ ] **Step 7: The report.** Post it on moroine/agent-forge#103, as for part 1.

## Calls made in this plan (for the maintainer's review)

- **Transport.**
  - An SSH forced command for a dedicated account. The operation is the SSH command; the arguments are one JSON object on stdin.
  - The git objects travel as a bundle: git's own format, checked by `git bundle verify`, fetched by git with one refspec. This is a single round trip, with no inbox repository to keep on the relay.
  - The client reuses one connection (`ControlPersist`), so that the relay's per-source SSH rate limit is never hit.
- **The replay rebuilds each commit with `commit-tree`** and keeps its tree, parents (mapped), identities and dates. So it never conflicts, keeps merges, and is deterministic: the relay's Betterleaks fingerprints are CI's.
- **A fork branch the relay has no record of** (after a relay rebuild) is adopted when only the bot authored and committed it. Otherwise the recorded head must match.
- **Text findings cannot be ignored:** the agent rewords. Only commit findings go through `.betterleaksignore`.
- **The relay's address is fixed** (`10.100.1.11`), so that a relay rebuild keeps the dev VM's client configuration. Its key accepts connections only from the subnet. sshd allows only `forge-relay` from the subnet, so the dev VM cannot even try the admin account.
- **Values chosen.** The relay instance is `t3.small` with a 20 GB disk. The write cap is 20 per hour. The text caps are the ones in Global Constraints.
- **The laptop carries the public data between the VMs:** the dev VM's client public key, and the relay's host key from forge's `known_hosts`. The playbooks run in sequence, `contributor.yml` then `relay.yml`, each with its own inventory.
- **Two refactors.** Three `hardening` values move from `vars/` to `defaults/`, so that `relay.yml` can set them. The forge user checks of the preflight move to their own file. `site.yml`'s behaviour does not change.
- **Metadata service.** It is enabled for an instance's first boot, then disabled by the next `create`, `start` or `stop`. `applyQuiet` accepts only that one change on an instance.
