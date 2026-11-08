import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, ForgeError } from "../cli/lib/context.ts";
import type { Context } from "../cli/lib/context.ts";
import {
  ensureClaudeLogin, ensureClaudeToken, ensureGitIdentity, ensureImage, imageDecision, runSetup,
} from "../cli/lib/laptop/host-steps.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext } from "./lib/fake-context.ts";

const host: LaptopHost = {
  name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "forge",
  admin: "ubuntu", adminKey: "/keys/admin", exposure: "public", done: [],
};

const GET_NAME = "'git' 'config' '--global' 'user.name'";
const GET_EMAIL = "'git' 'config' '--global' 'user.email'";
// A set call also contains the getter text: its rule must come first.
const SETS = [{ match: "'user.name' '" }, { match: "'user.email' '" }];
const laptopId = [
  { match: "git config --global user.name", stdout: "Alice Example\n" },
  { match: "git config --global user.email", stdout: "alice@example.com\n" },
];

test("the laptop's git identity is copied when the host has none", async () => {
  const ctx = fakeContext({ rules: [
    ...SETS, { match: GET_NAME, code: 1 }, { match: GET_EMAIL, code: 1 }, ...laptopId,
  ] });
  assert.equal(await ensureGitIdentity(ctx, host), "set");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((c) => c.includes("'git' 'config' '--global' 'user.name' 'Alice Example'")));
  assert.ok(joined.some((c) => c.includes("'git' 'config' '--global' 'user.email' 'alice@example.com'")));
});

test("a missing laptop identity is asked for", async () => {
  const ctx = fakeContext({
    rules: [...SETS, { match: GET_NAME, code: 1 }, { match: GET_EMAIL, code: 1 }, { match: "git config --global", code: 1 }],
    answers: ["Bob", "bob@example.com"],
  });
  assert.equal(await ensureGitIdentity(ctx, host), "set");
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("'user.email' 'bob@example.com'")));
});

test("a refused identity prompt is an error", async () => {
  const ctx = fakeContext({ rules: [{ match: GET_NAME, code: 1 }, { match: "git config --global user.name", code: 1 }], tty: false });
  await assert.rejects(ensureGitIdentity(ctx, host), ForgeError);
});

test("a different host identity is kept by default", async () => {
  const ctx = fakeContext({ rules: [
    ...SETS, { match: GET_NAME, stdout: "Other\n" }, { match: GET_EMAIL, stdout: "other@example.com\n" }, ...laptopId,
  ], answers: [null] });
  assert.equal(await ensureGitIdentity(ctx, host), "already");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("'user.name' 'Alice")));
});

test("a different host identity can be replaced", async () => {
  const ctx = fakeContext({ rules: [
    ...SETS, { match: GET_NAME, stdout: "Other\n" }, { match: GET_EMAIL, stdout: "other@example.com\n" }, ...laptopId,
  ], answers: [2] });
  assert.equal(await ensureGitIdentity(ctx, host), "set");
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("'user.name' 'Alice Example'")));
});

test("the same identity asks nothing", async () => {
  const ctx = fakeContext({ rules: [
    { match: GET_NAME, stdout: "Alice Example\n" }, { match: GET_EMAIL, stdout: "alice@example.com\n" }, ...laptopId,
  ] });
  assert.equal(await ensureGitIdentity(ctx, host), "already");
  assert.deepEqual(ctx.err_lines, []);
});

test("the Claude login is skipped when the credentials exist", async () => {
  const ctx = fakeContext({ rules: [{ match: "'test' '-e' '.claude/.credentials.json'", code: 0 }] });
  assert.equal(await ensureClaudeLogin(ctx, host), "already");
  assert.equal(ctx.attachCalls.length, 0);
});

test("the Claude login is attached with a tty when the credentials are missing", async () => {
  const ctx = fakeContext({ rules: [{ match: "'test' '-e'", code: 1 }] });
  assert.equal(await ensureClaudeLogin(ctx, host), "logged-in");
  assert.deepEqual(ctx.attachCalls[0].argv, ["ssh", "-o", "ForwardAgent=no", "-t", "forge-acme", "--", "'claude' 'auth' 'login'"]);
});

test("a failed Claude login names the step", async () => {
  const ctx = fakeContext({ rules: [{ match: "'test' '-e'", code: 1 }], attachCode: 1 });
  await assert.rejects(ensureClaudeLogin(ctx, host), (e: Error) => e instanceof ForgeError && /claude auth login/.test(e.message));
});

// The cloud host's Claude credential: a setup-token, pasted on the laptop.
const TOKEN_PROBE = "'test' '-s' '.config/agent-forge/claude-token'";

test("a stored Claude token is kept and nothing is asked", async () => {
  const ctx = fakeContext({ rules: [{ match: TOKEN_PROBE, code: 0 }] });
  assert.equal(await ensureClaudeToken(ctx, host), "already");
  assert.deepEqual(ctx.err_lines, []);
  assert.equal(ctx.calls.length, 1);
});

test("the pasted Claude token is trimmed and written over ssh's stdin into a private file", async () => {
  const ctx = fakeContext({ rules: [{ match: TOKEN_PROBE, code: 1 }], answers: ["  tok-abc \n"] });
  assert.equal(await ensureClaudeToken(ctx, host), "stored");
  // At a prompt that does not echo (the fake's askSecret logs "label: ", ask "label> ").
  assert.deepEqual(ctx.err_lines, ["Claude token: "]);
  // chmod too: umask does not narrow a file that already exists.
  assert.deepEqual(ctx.calls[1], ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-acme", "--",
    "'sh' '-c' 'umask 077 && mkdir -p .config/agent-forge && cat > .config/agent-forge/claude-token && chmod 600 .config/agent-forge/claude-token'"]);
  assert.deepEqual(ctx.execOptions[1], { input: "tok-abc\n" });
});

test("an empty or malformed Claude token is refused, without quoting it, and nothing is written", async () => {
  for (const answer of ["", null, "s3cr3t abc", "s3cr3t'x"]) {
    const ctx = fakeContext({ rules: [{ match: TOKEN_PROBE, code: 1 }], answers: [answer] });
    await assert.rejects(ensureClaudeToken(ctx, host), (e: Error) =>
      e instanceof ForgeError && !e.message.includes("s3cr3t"), String(answer));
    assert.equal(ctx.calls.length, 1, String(answer));
  }
});

test("runSetup attaches forge setup and fails on a non-zero code", async () => {
  const ok = fakeContext();
  await runSetup(ok, host);
  assert.deepEqual(ok.attachCalls[0].argv, ["ssh", "-o", "ForwardAgent=no", "forge-acme", "--", "'forge' 'setup'"]);
  await assert.rejects(runSetup(fakeContext({ attachCode: 2 }), host), ForgeError);
});

// --- imageDecision: git runs for real against a temporary repository ---

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com",
    "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

function repo(): { dir: string; c: string[]; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "forge-hs-"));
  git(dir, "init", "-q");
  const commit = (file: string, msg: string): string => {
    mkdirSync(join(dir, "ansible"), { recursive: true });
    writeFileSync(join(dir, file), msg + Math.random());
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  };
  const c0 = commit("README.md", "c0");
  const c1 = commit("ansible/image.yml", "c1 image");
  const c2 = commit("README.md", "c2 unrelated");
  const c3 = commit("ansible/image.yml", "c3 image");
  const c4 = commit("README.md", "c4 unrelated");
  return { dir, c: [c0, c1, c2, c3, c4], clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ssh calls are answered from `commit`; every other call runs for real.
function withImageCommit(commit: string): Context {
  const real = createContext();
  const ctx = fakeContext({ rules: [{ match: "'forge' 'image' 'commit'", stdout: commit }] });
  const fake = ctx.exec;
  return { ...ctx, exec: (argv, o) => argv[0] === "ssh" ? fake(argv, o) : real.exec(argv, o) };
}

test("imageDecision builds when the host has no image", async () => {
  const r = repo();
  try {
    assert.equal(await imageDecision(withImageCommit(""), host, r.dir), "build");
  } finally { r.clean(); }
});

test("imageDecision keeps an image built after the last image change", async () => {
  const r = repo();
  try {
    assert.equal(await imageDecision(withImageCommit(r.c[4] + "\n"), host, r.dir), "fresh");
    assert.equal(await imageDecision(withImageCommit(r.c[3]), host, r.dir), "fresh");
  } finally { r.clean(); }
});

test("imageDecision rebuilds a stale image", async () => {
  const r = repo();
  try {
    assert.equal(await imageDecision(withImageCommit(r.c[2]), host, r.dir), "build");
  } finally { r.clean(); }
});

test("imageDecision asks when merge-base fails with an error", async () => {
  const r = repo();
  try {
    const ctx = withImageCommit(r.c[4]);
    const inner = ctx.exec;
    const wrapped: Context = { ...ctx, exec: (argv, o) =>
      argv.includes("merge-base") ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal" }) : inner(argv, o) };
    assert.equal(await imageDecision(wrapped, host, r.dir), "ask");
  } finally { r.clean(); }
});

test("an image commit unknown to the checkout asks", async () => {
  const r = repo();
  try {
    assert.equal(await imageDecision(withImageCommit("0123456789abcdef0123456789abcdef01234567"), host, r.dir), "ask");
  } finally { r.clean(); }
});

test("imageDecision asks when the checkout is not a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-hs-"));
  try {
    assert.equal(await imageDecision(withImageCommit("0123456789abcdef0123456789abcdef01234567"), host, dir), "ask");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- ensureImage ---

test("ensureImage keeps a fresh image without building", async () => {
  const r = repo();
  try {
    const ctx = withImageCommit(r.c[4]);
    assert.equal(await ensureImage(ctx, host, r.dir), "fresh");
    assert.equal((ctx as ReturnType<typeof fakeContext>).attachCalls.length, 0);
  } finally { r.clean(); }
});

test("ensureImage builds with a tty when the image is stale", async () => {
  const r = repo();
  try {
    const ctx = withImageCommit(r.c[2]);
    assert.equal(await ensureImage(ctx, host, r.dir), "built");
    assert.deepEqual((ctx as ReturnType<typeof fakeContext>).attachCalls[0].argv,
      ["ssh", "-o", "ForwardAgent=no", "-t", "forge-acme", "--", "'forge' 'image' 'build'"]);
  } finally { r.clean(); }
});

test("ensureImage asks about an unknown commit and keeps it on null", async () => {
  const r = repo();
  try {
    const ctx = withImageCommit("0123456789abcdef0123456789abcdef01234567");
    assert.equal(await ensureImage(ctx, host, r.dir), "fresh");
    assert.match((ctx as ReturnType<typeof fakeContext>).err_lines[0], /agent-base was built from a commit this checkout does not know/);
  } finally { r.clean(); }
});

test("ensureImage rebuilds an unknown commit when the user says so", async () => {
  const r = repo();
  try {
    const base = fakeContext({ rules: [{ match: "'forge' 'image' 'commit'", stdout: "0123456789abcdef0123456789abcdef01234567" }], answers: [1] });
    const ctx: Context = { ...base, exec: (argv, o) => argv[0] === "ssh" ? base.exec(argv, o) : createContext().exec(argv, o) };
    assert.equal(await ensureImage(ctx, host, r.dir), "built");
    assert.equal(base.attachCalls.length, 1);
  } finally { r.clean(); }
});

test("a failed image build names the step", async () => {
  const r = repo();
  try {
    const base = fakeContext({ rules: [{ match: "'forge' 'image' 'commit'", stdout: "" }], attachCode: 1 });
    const ctx: Context = { ...base, exec: (argv, o) => argv[0] === "ssh" ? base.exec(argv, o) : createContext().exec(argv, o) };
    await assert.rejects(ensureImage(ctx, host, r.dir), (e: Error) => e instanceof ForgeError && /image build/.test(e.message));
  } finally { r.clean(); }
});
