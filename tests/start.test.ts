import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import type { ExecRule } from "./lib/fake-context.ts";
import { cmdStart } from "../cli/lib/commands/start.ts";

const RUNNING = JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]);

function rules(extra: ExecRule[] = []): ExecRule[] {
  return [
    ...extra,
    { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
    { match: "user.forge.mode", stdout: "autonomous" },
    { match: "lxc list", stdout: RUNNING },
    { match: "lxc info", code: 0 },
    { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
    { match: "test -e /workspace/.trees/", code: 1 },
    { match: "show-ref", code: 1 },
  ];
}
const added = (c: ReturnType<typeof fakeContext>) =>
  c.calls.map((x) => x.join(" ")).find((l) => l.includes("worktree add")) ?? "";

test("an existing worktree is attached, not refused", async () => {
  const c = fakeContext({ rules: rules([{ match: "test -e /workspace/.trees/cli", code: 0 }]) });
  assert.equal(await cmdStart(c, "moroine/agent-forge", "cli"), 0);
  assert.equal(added(c), "", "aucun worktree ne doit être créé");
  assert.ok(c.calls.some((call) => call.includes("tmux")));
});

test("an existing local branch is resumed in a new worktree", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/docs", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "docs");
  assert.ok(added(c).includes("worktree add .trees/docs agent/docs"), added(c));
});

test("a branch that exists only on origin is picked up", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "api");
  assert.ok(added(c).includes("worktree add .trees/api -b agent/api origin/agent/api"), added(c));
});

test("with nothing existing, the branch starts from origin/main", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(added(c).includes("worktree add .trees/fresh -b agent/fresh origin/main"), added(c));
});

test("main is refreshed before the worktree is created", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  const fetch = flat.findIndex((l) => l.includes("fetch origin"));
  const add = flat.findIndex((l) => l.includes("worktree add"));
  assert.ok(fetch >= 0 && fetch < add, "le fetch doit précéder la création");
});

test("a supervised container skips the fetch", async () => {
  const c = fakeContext({
    rules: rules().map((r) => (r.match === "user.forge.mode" ? { ...r, stdout: "supervised" } : r)),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("fetch origin")));
});

test("the task menu mixes worktrees, local branches and origin branches", async () => {
  const c = fakeContext({
    rules: rules([
      { match: "for-each-ref --format='%(refname:short)' refs/heads/agent", stdout: "agent/cli\nagent/docs\n" },
      { match: "for-each-ref --format='%(refname:short)' refs/remotes/origin/agent", stdout: "origin/agent/api\n" },
      { match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 },
    ]),
    answers: [4],
  });
  await cmdStart(c, "moroine/agent-forge", undefined);
  const menu = c.err_lines.join("\n");
  assert.ok(menu.includes("new task"), menu);
  assert.ok(menu.includes("cli (existing worktree — attach)"), menu);
  assert.ok(menu.includes("docs (local branch)"), menu);
  assert.ok(menu.includes("api (branch on origin)"), menu);
  assert.ok(menu.includes("other branch…"), menu);
  assert.ok(added(c).includes("-b agent/api origin/agent/api"), added(c));
});

test("other branch… branches agent/<task> from the named ref", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "origin/feature/thing", "thing"] });
  await cmdStart(c, "moroine/agent-forge", undefined);
  assert.ok(added(c).includes("worktree add .trees/thing -b agent/thing origin/feature/thing"), added(c));
});

test("other branch… refuses to overwrite an existing agent branch", async () => {
  const c = fakeContext({
    rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/thing", code: 0 }]),
    answers: [3, "origin/feature/thing", "thing"],
  });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /already exists/);
});

test("with no TTY, a missing task is a usage error rather than a hang", async () => {
  const c = fakeContext({ rules: rules(), tty: false });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /Usage: forge start/);
});

test("an invalid ref from the menu is rejected before reaching su -c", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "--upload-pack=evil", "x"] });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /must not start with/);
});

// Fail-fast : sans mustSucceed, `git worktree add` pouvait échouer et start
// enchaînait sur l'attach — dans un répertoire qui n'existe pas.
test("a failing worktree add aborts instead of attaching to a missing directory", async () => {
  const c = fakeContext({
    rules: rules([{ match: "worktree add", code: 1, stderr: "fatal: invalid reference: origin/main\n" }]),
  });
  await assert.rejects(
    () => cmdStart(c, "moroine/agent-forge", "fresh"),
    /git worktree add failed: fatal: invalid reference: origin\/main/,
  );
  assert.ok(!c.calls.some((call) => call.includes("tmux")), "attaché malgré l'échec de la création");
  assert.ok(!c.out_lines.some((l) => l.includes("Attaching to")), c.out_lines.join(" | "));
});

test("start fails when the container refuses to start", async () => {
  const c = fakeContext({
    rules: [
      { match: "lxc start", code: 1, stderr: "Error: Failed to start device\n" },
      ...rules().map((r) => (r.match === "lxc list"
        ? { ...r, stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) }
        : r)),
    ],
  });
  await assert.rejects(
    () => cmdStart(c, "moroine/agent-forge", "fresh"),
    /lxc start failed: Error: Failed to start device/,
  );
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

// Choix délibéré : le rafraîchissement de main n'est PAS fatal (l'opérateur
// hors ligne doit pouvoir travailler sur les dernières refs connues, comme le
// fait déjà un container supervised), mais il ne doit jamais être silencieux.
test("a failing fetch is surfaced on stderr instead of passing silently", async () => {
  const c = fakeContext({
    rules: rules([{ match: "fetch origin", code: 1, stderr: "fatal: unable to access 'https://github.com/': timed out\n" }]),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const errs = c.err_lines.join("\n");
  assert.match(errs, /WARNING: refreshing main failed: fatal: unable to access/);
  assert.match(errs, /stale origin\/main/);
});

// `git merge --ff-only origin/main` fusionne dans la branche SORTIE dans
// /workspace, pas dans `main`. Le clone principal est censé être épinglé sur
// main, mais rien ne le garantit : sur le vrai hôte il s'était retrouvé sur
// `agent/agent-forge`, et le refresh mourait sur « Not possible to
// fast-forward » alors que `main` était un ancêtre propre d'origin/main. Pire :
// une branche agent/* en retard aurait été avancée en silence. On fait donc
// avancer le REF main, jamais HEAD.
test("the main ref is advanced without merging into the checked-out branch", async () => {
  const c = fakeContext({
    rules: rules([{ match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/agent/agent-forge\n" }]),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  assert.ok(flat.some((l) => l.includes("fetch origin main:main")), flat.join("\n"));
  assert.ok(!flat.some((l) => l.includes("merge")), "aucun merge ne doit toucher la branche sortie");
});

test("when /workspace is on main, the checkout itself is fast-forwarded", async () => {
  const c = fakeContext({
    rules: rules([{ match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/main\n" }]),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  // Ici le ref ET le working tree doivent bouger ensemble : un
  // `fetch origin main:main` refuserait d'écrire dans une branche sortie.
  assert.ok(flat.some((l) => l.includes("--ff-only origin/main")), flat.join("\n"));
  assert.ok(!flat.some((l) => l.includes("fetch origin main:main")), "pas de fetch dans une branche sortie");
});

// Le fetch et l'avancée de main étaient chaînés par `&&` et rapportés comme un
// seul échec : une avancée qui échoue accusait donc origin/main d'être périmé,
// alors que le fetch venait de le rafraîchir. Deux étapes, deux diagnostics.
test("a failed main update does not claim origin/main is stale", async () => {
  const c = fakeContext({
    rules: rules([
      { match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/agent/agent-forge\n" },
      { match: "fetch origin main:main", code: 1, stderr: " ! [rejected] main -> main (non-fast-forward)\n" },
    ]),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const errs = c.err_lines.join("\n");
  assert.match(errs, /non-fast-forward/);
  assert.doesNotMatch(errs, /stale origin\/main/);
  // Le worktree part quand même d'origin/main, qui EST à jour.
  assert.ok(added(c).includes("origin/main"), added(c));
});
