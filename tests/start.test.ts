import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import type { ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacesDir } from "../cli/lib/paths.ts";
import { cmdStart } from "../cli/lib/commands/start.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-start-xdg-"));

const RUNNING = JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]);

function rules(extra: ExecRule[] = []): ExecRule[] {
  return [
    ...extra,
    { match: "config device list", stdout: "origin\nworkspace\n" },
    { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
    { match: "user.forge.mode", stdout: "autonomous" },
    { match: "incus --project agent-forge list", stdout: RUNNING },
    { match: "incus --project agent-forge info", code: 0 },
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
  assert.ok(c.attachCalls.length > 0);
});

test("an existing worktree whose agent already runs is refused outside herdr", async () => {
  const c = fakeContext({ rules: rules([
    { match: "test -e /workspace/.trees/cli", code: 0 },
    { match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-moroine-agent-forge-cli\n" },
  ]) });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", "cli"), /the agent for cli already runs in agent-moroine-agent-forge/);
  assert.equal(c.attachCalls.length, 0);
});

test("the task's agent is attached in the foreground outside herdr", async () => {
  const c = fakeContext({ rules: rules([{ match: ".jsonl", code: 1 }]) });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const attach = c.attachCalls.at(-1)?.argv ?? [];
  assert.deepEqual(attach.slice(-3), [
    "bash", "-lc", "exec claude --permission-mode auto --remote-control agent-moroine-agent-forge-fresh",
  ]);
  assert.ok(c.err_lines.includes("outside herdr: the agent stops when this terminal closes"), c.err_lines.join(" | "));
});

test("a new task whose transcript folder would collide with an existing task is refused", async () => {
  const c = fakeContext({
    rules: rules([{ match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/fix.v2\n" }]),
  });
  await assert.rejects(
    () => cmdStart(c, "moroine/agent-forge", "fix-v2"),
    /share Claude's transcript folder with 'fix.v2'/,
  );
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
  assert.equal(c.attachCalls.length, 0);
});

// Two worktrees left from before the guard: attaching to either stays allowed.
test("the transcript-folder guard stays quiet for an existing worktree", async () => {
  const c = fakeContext({ rules: rules([
    { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/fix.v2\nworktree /workspace/.trees/fix-v2\n" },
    { match: "test -e /workspace/.trees/fix-v2", code: 0 },
  ]) });
  assert.equal(await cmdStart(c, "moroine/agent-forge", "fix-v2"), 0);
  assert.equal(added(c), "");
  assert.equal(c.attachCalls.length, 1);
});

test("start names the stored repo, not the case typed", async () => {
  const c = fakeContext({ rules: rules([
    { match: "test -e /workspace/.trees/cli", code: 0 },
    { match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-moroine-agent-forge-cli\n" },
  ]) });
  await assert.rejects(() => cmdStart(c, "Moroine/Agent-Forge", "cli"), /'forge stop moroine\/agent-forge'\./);
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

test("the host mirror is refreshed, then the container fetches from it", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  const host = flat.findIndex((l) => l.startsWith("git --git-dir=") && l.includes("agent-moroine-agent-forge.git") && l.includes("fetch --prune"));
  const inside = flat.findIndex((l) => l.includes("git -C /workspace fetch origin"));
  const add = flat.findIndex((l) => l.includes("worktree add"));
  assert.ok(host >= 0 && host < inside && inside < add, flat.join("\n"));
});

test("the mirror is refreshed from the stored repo, not from the case typed", async () => {
  const c = fakeContext({ rules: [
    { match: "config device list", stdout: "origin\nworkspace\n" },
    { match: "agent-o-r user.forge.repo", stdout: "o/r" },
    { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-o-r", status: "Running" }]) },
    { match: "incus --project agent-forge info", code: 0 },
    { match: "test -e /workspace/.trees/", code: 1 },
    { match: "show-ref", code: 1 },
  ] });
  await cmdStart(c, "O/R", "fresh");
  const refresh = c.calls.find((x) => x[0] === "git" && x.includes("fetch")) ?? [];
  assert.ok(refresh.includes("git@github.com:o/r.git"), refresh.join(" "));
});

test("a failing mirror refresh only warns, and the container still fetches", async () => {
  const c = fakeContext({
    rules: rules([{ match: "fetch --prune", code: 128, stderr: "Error connecting to agent" }]),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const errs = c.err_lines.join("\n");
  assert.match(errs, /WARNING: refreshing the mirror from GitHub failed: Error connecting to agent/);
  assert.match(errs, /ForwardAgent/);
  assert.ok(c.calls.some((call) => call.join(" ").includes("git -C /workspace fetch origin")));
  assert.ok(added(c).includes("worktree add"), added(c));
});

test("a container without the origin device is refused, with the way out", async () => {
  const c = fakeContext({ rules: rules([{ match: "config device list", stdout: "workspace\n" }]) });
  await assert.rejects(
    () => cmdStart(c, "moroine/agent-forge", "fresh"),
    (e: Error) => /no 'origin' device/.test(e.message)
      && /forge delete moroine\/agent-forge/.test(e.message) && /aside/.test(e.message),
  );
  assert.equal(added(c), "");
});

test("no host git touches the workspace", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assertNoHostGitIn(c.calls, join(workspacesDir(), "agent-moroine-agent-forge"));
});

test("right after a fresh mirror clone, start does not fetch GitHub again", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-start-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  try {
    const c = fakeContext({
      incus: FakeIncus.withRuntime({ commit: "IMGSHA" }),
      rules: [
        { match: "git config --global --includes user.name", stdout: "Ada\n" },
        { match: "git config --global --includes user.email", stdout: "ada@example.com\n" },
        { match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED: sudo non autorisé.\n" },
      ],
    });
    await cmdStart(c, "o/r", "fresh");
    const flat = c.calls.map((x) => x.join(" "));
    assert.ok(flat.some((l) => l.includes("clone --bare")), flat.join("\n"));
    assert.equal(flat.filter((l) => l.includes("fetch") && l.includes("--prune")).length, 0, flat.join("\n"));
    // The fresh-clone path too: provisioning, then the start that follows.
    assertNoHostGitIn(c.calls, join(home, "workspaces"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
  }
});

// The very first prefix+f: no forge container yet, nothing typed on a command line.
test("with no forge container yet, start asks owner/repo and provisions it", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-start-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  try {
    const c = fakeContext({
      incus: FakeIncus.withRuntime({ commit: "IMGSHA" }),
      rules: [
        { match: "git config --global --includes user.name", stdout: "Ada\n" },
        { match: "git config --global --includes user.email", stdout: "ada@example.com\n" },
        { match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED: sudo non autorisé.\n" },
      ],
      answers: ["o/r", "fresh"],
    });
    await cmdStart(c, undefined, undefined);
    assert.ok(c.err_lines.includes("owner/repo> "), c.err_lines.join(" | "));
    const flat = c.calls.map((x) => x.join(" "));
    assert.ok(flat.some((l) => l.includes("clone --bare git@github.com:o/r.git")), flat.join("\n"));
    assert.ok(c.out_lines.includes("Container agent-o-r provisioned."), c.out_lines.join(" | "));
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
  }
});

test("with no forge container yet and no TTY, start exits with its message", async () => {
  const c = fakeContext({ incus: FakeIncus.withRuntime(), tty: false });
  await assert.rejects(() => cmdStart(c, undefined, undefined),
    /no forge container yet\. Name the repo: forge start <owner\/repo> <task>\./);
  assert.ok(!c.calls.some((call) => call.includes("launch")));
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
  assert.equal(c.attachCalls.length, 0, "attaché malgré l'échec de la création");
  assert.ok(!c.out_lines.some((l) => l.includes("Attaching to")), c.out_lines.join(" | "));
});

test("start fails when the container refuses to start", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge start", code: 1, stderr: "Error: Failed to start device\n" },
      ...rules().map((r) => (r.match === "incus --project agent-forge list"
        ? { ...r, stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Stopped" }]) }
        : r)),
    ],
  });
  await assert.rejects(
    () => cmdStart(c, "moroine/agent-forge", "fresh"),
    /incus start failed: Error: Failed to start device/,
  );
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

// Choix délibéré : le rafraîchissement de main n'est PAS fatal (l'opérateur
// hors ligne doit pouvoir travailler sur les dernières refs connues, comme le
// fait déjà un container supervised), mais il ne doit jamais être silencieux.
test("a failing fetch is surfaced on stderr instead of passing silently", async () => {
  const c = fakeContext({
    rules: rules([{ match: "-C /workspace fetch origin", code: 1, stderr: "fatal: unable to access 'https://github.com/': timed out\n" }]),
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

// --- egress ---
function egressFake(opts: { mode?: string; version?: string; proxy?: boolean } = {}): FakeIncus {
  const fake = FakeIncus.withRuntime();
  if (opts.version) fake.serverVersion = opts.version;
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  if (opts.proxy ?? true) fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  fake.addInstance("agent-forge", "agent-o-r", {
    status: "Stopped", config: { "user.forge.repo": "o/r", "user.forge.mode": "supervised", ...(opts.mode ? { "user.forge.egress": opts.mode } : {}) },
    // Un container strict l'est aussi par sa NIC, pas seulement par son marqueur.
    // Le device origin : un container provisionné avec le miroir.
    devices: { origin: ORIGIN_DISK, ...(opts.mode === "strict" ? { eth0: STRICT_NIC } : {}) },
  });
  return fake;
}
const ORIGIN_DISK = { type: "disk", source: "/m/agent-o-r.git", path: "/forge/origin.git", readonly: "true" };
const STRICT_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict",
  "security.acls.default.egress.action": "reject", "security.acls.default.ingress.action": "reject",
};
const egressRules: ExecRule[] = [{ match: "test -e /workspace/.trees/", code: 0 }];
const flatCalls = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));

test("start --strict on an existing open container is refused, pointing at forge egress", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open" }), rules: egressRules });
  await assert.rejects(() => cmdStart(c, "o/r", "t", { strict: true }), /forge egress o\/r strict/);
  assert.ok(!flatCalls(c).some((l) => l.includes(" start ")));
});

test("start --strict on an existing strict container goes through", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict" }), rules: egressRules });
  assert.equal(await cmdStart(c, "o/r", "t", { strict: true }), 0);
});

test("start of a strict container checks the gate before starting it", async () => {
  const fake = egressFake({ mode: "strict", version: "7.0.1" });
  const c = fakeContext({ incus: fake, rules: egressRules });
  await assert.rejects(() => cmdStart(c, "o/r", "t"), /7\.0\.2/);
  assert.ok(!flatCalls(c).some((l) => / start agent-o-r/.test(l)));
});

test("start applies the strict settings after starting and before attaching", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict" }), rules: egressRules });
  await cmdStart(c, "o/r", "t");
  const l = flatCalls(c);
  const started = l.findIndex((x) => / start agent-o-r/.test(x));
  const push = l.findIndex((x) => x.includes("file push") && x.includes("agent-forge-proxy.sh"));
  const attach = l.findIndex((x) => x.includes("exec claude"));
  assert.ok(started >= 0 && push > started && attach > push, l.join("\n"));
});

test("start of a container marked strict whose eth0 lost the filter is refused before any start", async () => {
  const fake = egressFake({ mode: "strict" });
  // Surcharge eth0 retirée à la main : la NIC ouverte du profil s'applique.
  fake.addProfile("agent-forge", "agent-forge", { devices: { eth0: { ...STRICT_NIC, "security.acls": "forge-egress",
    "security.acls.default.egress.action": "allow" } } });
  const inst = fake.instances.get("agent-forge")!.get("agent-o-r")!;
  inst.profiles = ["agent-forge"];
  inst.devices = {};
  const c = fakeContext({ incus: fake, rules: egressRules });
  await assert.rejects(() => cmdStart(c, "o/r", "t"), /refusing to start agent-o-r: .*user\.forge\.egress=strict.*forge egress o\/r strict/);
  assert.ok(!flatCalls(c).some((x) => / start agent-o-r|file push|exec claude/.test(x)), flatCalls(c).join("\n"));
});

test("a strict container starts with a warning when the proxy is gone", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", proxy: false }), rules: egressRules });
  assert.equal(await cmdStart(c, "o/r", "t"), 0);
  assert.ok(c.err_lines.some((x) => /forge setup/.test(x)));
  assert.ok(flatCalls(c).some((x) => x.includes("exec claude")));
});

test("start of a container switched to open clears forge's files before attaching", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open" }), rules: egressRules });
  await cmdStart(c, "o/r", "t");
  const l = flatCalls(c);
  const rm = l.findIndex((x) => x.includes("rm -f"));
  assert.ok(rm >= 0 && rm < l.findIndex((x) => x.includes("exec claude")), l.join("\n"));
});

test("start --strict on a new repo provisions it strict", async () => {
  const fake = FakeIncus.withRuntime();
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  const home = mkdtempSync(join(tmpdir(), "forge-start-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  try {
    const c = fakeContext({ incus: fake, rules: [
      { match: "git config --global --includes user.name", stdout: "Ada\n" },
      { match: "git config --global --includes user.email", stdout: "a@b.c\n" },
      { match: "forge-hook-probe-deny", code: 2 },
      { match: "test -e /workspace/.trees/", code: 1 },
      { match: "show-ref", code: 1 },
    ] });
    await cmdStart(c, "o/r", "t", { strict: true });
    assert.equal(fake.instances.get("agent-forge")!.get("agent-o-r")!.config["user.forge.egress"], "strict");
    assert.ok(flatCalls(c).some((x) => x.includes("exec claude")));
  } finally {
    delete process.env.FORGE_HOME; delete process.env.FORGE_REPO_DIR; delete process.env.FORGE_WORKSPACES;
    rmSync(home, { recursive: true, force: true });
  }
});
