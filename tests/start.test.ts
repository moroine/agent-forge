import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import type { ExecRule } from "./lib/fake-context.ts";
import { cmdStart } from "../scripts/lib/commands/start.ts";

// Le repo est toujours "o/r" ici : les noms de container qui en découlent
// (agent-o-r, agent-o-r-<task>) restent courts et lisibles dans les
// assertions, sans rien changer au comportement testé.
const OWNER_REPO = "o/r";
const TEMPLATE = "agent-o-r";

type StartOpts = {
  template?: string | null;      // nom du container template, ou null s'il n'existe pas encore
  templateStatus?: string;       // défaut "Stopped" : le template ne tourne qu'exceptionnellement
  mode?: string;                 // défaut "autonomous"
  tasks?: Record<string, string>; // task -> statut, pour des containers de tâche déjà là
  imageCommit?: string;          // user.forge.image_commit du template
  latest?: string;               // user.forge.commit de l'image de base
  worktreeExists?: boolean;      // pour la tâche "feat"
  answers?: (number | string | null)[];
  tty?: boolean;
  extra?: ExecRule[];            // règles prioritaires, pour surcharger un défaut ci-dessous
};

// Nourrit describeContainers (Task 2) : un seul `lxc list`, puis quatre
// `config get <name> user.forge.{repo,mode,role,task}` par container.
function startCtx(opts: StartOpts = {}) {
  const mode = opts.mode ?? "autonomous";
  const templateName = opts.template ?? null;

  const instances: { name: string; status: string }[] = [];
  const meta: Record<string, { repo: string; mode: string; role: string; task: string }> = {};

  if (templateName) {
    instances.push({ name: templateName, status: opts.templateStatus ?? "Stopped" });
    meta[templateName] = { repo: OWNER_REPO, mode, role: "template", task: "" };
  }
  for (const [taskName, status] of Object.entries(opts.tasks ?? {})) {
    const name = `${templateName}-${taskName}`;
    instances.push({ name, status });
    meta[name] = { repo: OWNER_REPO, mode, role: "task", task: taskName };
  }

  const rules: ExecRule[] = [
    ...(opts.extra ?? []),
    { match: "lxc list", stdout: JSON.stringify(instances) },
    ...Object.entries(meta).flatMap(([name, m]) => [
      { match: `config get ${name} user.forge.repo`, stdout: m.repo },
      { match: `config get ${name} user.forge.mode`, stdout: m.mode },
      { match: `config get ${name} user.forge.role`, stdout: m.role },
      { match: `config get ${name} user.forge.task`, stdout: m.task },
    ]),
    { match: "user.forge.image_commit", stdout: opts.imageCommit ?? "" },
    { match: "image get-property", stdout: opts.latest ?? "" },
    { match: "test -e /workspace/.trees/feat", code: opts.worktreeExists ? 0 : 1 },
    { match: "test -e /workspace/.trees/", code: 1 },
    { match: "lxc info", code: 1 },
    { match: "show-ref", code: 1 },
  ];

  return fakeContext({ rules, answers: opts.answers, tty: opts.tty });
}

// --- Provisioning à froid : seul cas où le vrai provisionTemplate tourne ---
// Reprend le montage de tests/provision.test.ts (crédentiels + clé de
// signature dans un HOME jetable), nécessaire dès que `template` vaut `null`.
let provHome: string | undefined;

function withRealHost(): void {
  provHome = mkdtempSync(join(tmpdir(), "forge-start-"));
  mkdirSync(join(provHome, ".claude"), { recursive: true });
  mkdirSync(join(provHome, ".ssh"), { recursive: true });
  writeFileSync(join(provHome, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(provHome, ".ssh", "github_agents_signing"), "key");
  process.env.FORGE_HOME = provHome;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(provHome, "workspaces");
}

after(() => {
  if (!provHome) return;
  rmSync(provHome, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
});

const added = (c: ReturnType<typeof fakeContext>) =>
  c.calls.map((x) => x.join(" ")).find((l) => l.includes("worktree add")) ?? "";

// --- Étape 1 du brief : le nouveau flux copie-le-template ---

test("a repo with no template is provisioned, then copied", async () => {
  withRealHost();
  const ctx = startCtx({ template: null, answers: ["a", "ghp_x"] });
  await cmdStart(ctx, OWNER_REPO, "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((s) => s.startsWith("lxc launch")), "provisioning a fresh template");
  assert.ok(joined.some((s) => s === "lxc copy agent-o-r agent-o-r-feat"));
});

test("an existing template is copied, never re-provisioned", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await cmdStart(ctx, OWNER_REPO, "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(!joined.some((s) => s.startsWith("lxc launch")));
  assert.ok(joined.some((s) => s === "lxc copy agent-o-r agent-o-r-feat"));
});

test("the copy is stamped with role=task and its task name, then started", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await cmdStart(ctx, OWNER_REPO, "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc config set agent-o-r-feat user.forge.role task"));
  assert.ok(joined.includes("lxc config set agent-o-r-feat user.forge.task feat"));
  assert.ok(joined.includes("lxc start agent-o-r-feat"));
  assert.ok(joined.indexOf("lxc copy agent-o-r agent-o-r-feat") < joined.indexOf("lxc start agent-o-r-feat"));
});

// Fix round 1 : `lxc copy` ne refuse pas une instance démarrée — il copie un
// rootfs en cours d'écriture, exactement la corruption que le template existe
// pour éviter. `ensureTaskContainer` doit donc re-vérifier le statut juste
// avant la copie (le ForgeContainer tenu depuis templateForRepo est un
// instantané qui peut être périmé) et l'arrêter si besoin.
test("a template reported Running at copy time is stopped first", async () => {
  const ctx = startCtx({ template: TEMPLATE, templateStatus: "Running" });
  await cmdStart(ctx, OWNER_REPO, "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes(`lxc stop ${TEMPLATE}`), joined.join("\n"));
  assert.ok(
    joined.indexOf(`lxc stop ${TEMPLATE}`) < joined.indexOf("lxc copy agent-o-r agent-o-r-feat"),
    "le template doit être arrêté avant d'être copié",
  );
});

test("a template already Stopped is not stopped again", async () => {
  const ctx = startCtx({ template: TEMPLATE, templateStatus: "Stopped" });
  await cmdStart(ctx, OWNER_REPO, "feat");
  assert.ok(!ctx.calls.some((c) => c.join(" ") === `lxc stop ${TEMPLATE}`));
});

test("an already-running task container is attached, not copied again", async () => {
  const ctx = startCtx({ template: TEMPLATE, tasks: { feat: "Running" } });
  await cmdStart(ctx, OWNER_REPO, "feat");
  assert.ok(!ctx.calls.some((c) => c[1] === "copy"));
  assert.ok(ctx.calls.some((c) => c.includes("tmux")));
});

test("a stopped task container is restarted, not copied again", async () => {
  const ctx = startCtx({ template: TEMPLATE, tasks: { feat: "Stopped" } });
  await cmdStart(ctx, OWNER_REPO, "feat");
  assert.ok(!ctx.calls.some((c) => c[1] === "copy"));
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r-feat"));
});

test("a behind template warns but does not block", async () => {
  const ctx = startCtx({ template: TEMPLATE, imageCommit: "old", latest: "new" });
  assert.equal(await cmdStart(ctx, OWNER_REPO, "feat"), 0);
  assert.match(ctx.err_lines.join("\n"), /behind|forge template rebuild/);
});

test("the worktree is created from the task container, after it starts", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await cmdStart(ctx, OWNER_REPO, "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  const start = joined.indexOf("lxc start agent-o-r-feat");
  const worktree = joined.findIndex((s) => s.includes("worktree add .trees/feat"));
  assert.ok(worktree > start, "la worktree se crée depuis le container de la tâche");
  assert.ok(joined.some((s) => s.includes("agent-o-r-feat") && s.includes("fetch origin")));
});

test("an existing worktree is adopted, not recreated", async () => {
  const ctx = startCtx({ template: TEMPLATE, worktreeExists: true });
  await cmdStart(ctx, OWNER_REPO, "feat");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("worktree add")));
  assert.match(ctx.out_lines.join("\n"), /already there/);
});

// --- Point 4 de la consigne : le nom de tâche qui s'effondre sur le template ---
// taskContainerName("o/r", "---") slugifie en gardant les tirets (charset
// autorisé), puis strip les tirets de fin : la queue entière disparaît et le
// résultat est exactement "agent-o-r", le nom du template. checkNameCollision
// laisserait passer (même repo) et `lxc copy agent-o-r agent-o-r` échouerait
// avec un message qui ne dit rien de la vraie cause — d'où la garde explicite
// dans ensureTaskContainer.

test("a task name that collapses onto the template's own name is refused", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, "---"), /---/);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("lxc copy")));
});

// Container HÉRITÉ occupant déjà le nom du template : checkNameCollision
// laissait passer (le repo correspond) et `lxc launch` mourait ensuite sur un
// « instance already exists » brut, sans un mot sur la migration à faire.
test("a legacy container holding the template's name is refused with a migration hint", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify([{ name: TEMPLATE, status: "Stopped" }]) },
      { match: `config get ${TEMPLATE} user.forge.repo`, stdout: OWNER_REPO },
      { match: `config get ${TEMPLATE} user.forge.mode`, stdout: "autonomous" },
      { match: `config get ${TEMPLATE} user.forge.role`, stdout: "" },
      { match: `config get ${TEMPLATE} user.forge.task`, stdout: "" },
      { match: "lxc info", code: 0 },
    ],
  });
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, "feat"), /legacy forge container/);
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, "feat"), /forge delete/);
  assert.ok(!ctx.calls.some((c) => c.join(" ").startsWith("lxc launch")));
});

// --- Comportements conservés de l'ancien modèle, adaptés au nouveau ---

test("a supervised container skips the fetch", async () => {
  const ctx = startCtx({ template: TEMPLATE, mode: "supervised" });
  await cmdStart(ctx, OWNER_REPO, "feat");
  assert.ok(!ctx.calls.some((call) => call.join(" ").includes("fetch origin")));
});

test("an existing local branch is resumed in a new worktree", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "show-ref --verify --quiet refs/heads/agent/docs", code: 0 }],
  });
  await cmdStart(ctx, OWNER_REPO, "docs");
  assert.ok(added(ctx).includes("worktree add .trees/docs agent/docs"), added(ctx));
});

test("a branch that exists only on origin is picked up", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 }],
  });
  await cmdStart(ctx, OWNER_REPO, "api");
  assert.ok(added(ctx).includes("worktree add .trees/api -b agent/api origin/agent/api"), added(ctx));
});

test("with nothing existing, the branch starts from origin/main", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  assert.ok(added(ctx).includes("worktree add .trees/fresh -b agent/fresh origin/main"), added(ctx));
});

test("main is refreshed before the worktree is created", async () => {
  const ctx = startCtx({ template: TEMPLATE });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  const flat = ctx.calls.map((x) => x.join(" "));
  const fetch = flat.findIndex((l) => l.includes("fetch origin"));
  const add = flat.findIndex((l) => l.includes("worktree add"));
  assert.ok(fetch >= 0 && fetch < add, "le fetch doit précéder la création");
});

test("the task menu mixes existing containers, local branches and origin branches", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    templateStatus: "Running",
    tasks: { cli: "Running" },
    extra: [
      { match: "for-each-ref --format='%(refname:short)' refs/heads/agent", stdout: "agent/cli\nagent/docs\n" },
      { match: "for-each-ref --format='%(refname:short)' refs/remotes/origin/agent", stdout: "origin/agent/api\n" },
      { match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 },
    ],
    answers: [4],
  });
  await cmdStart(ctx, OWNER_REPO, undefined);
  const menu = ctx.err_lines.join("\n");
  assert.ok(menu.includes("new task"), menu);
  assert.ok(menu.includes("cli (existing container — attach)"), menu);
  assert.ok(menu.includes("docs (local branch)"), menu);
  assert.ok(menu.includes("api (branch on origin)"), menu);
  assert.ok(menu.includes("other branch…"), menu);
  assert.ok(added(ctx).includes("-b agent/api origin/agent/api"), added(ctx));
});

test("a stopped template shows only its task containers, no git probes", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    tasks: { cli: "Stopped" },
    extra: [
      // Si ces probes étaient lancées contre un template stoppé, elles
      // apparaîtraient dans ctx.calls : on vérifie plus bas qu'elles ne le sont pas.
      { match: "for-each-ref --format='%(refname:short)' refs/heads/agent", stdout: "agent/ghost\n" },
    ],
    answers: [2],
  });
  await cmdStart(ctx, OWNER_REPO, undefined);
  const menu = ctx.err_lines.join("\n");
  assert.ok(menu.includes("cli (existing container — attach)"), menu);
  assert.ok(!menu.includes("ghost"), menu);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("for-each-ref")));
});

test("other branch… branches agent/<task> from the named ref", async () => {
  const ctx = startCtx({ template: TEMPLATE, answers: [2, "origin/feature/thing", "thing"] });
  await cmdStart(ctx, OWNER_REPO, undefined);
  assert.ok(added(ctx).includes("worktree add .trees/thing -b agent/thing origin/feature/thing"), added(ctx));
});

test("other branch… refuses to overwrite an existing agent branch", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "show-ref --verify --quiet refs/heads/agent/thing", code: 0 }],
    answers: [2, "origin/feature/thing", "thing"],
  });
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, undefined), /already exists/);
});

test("with no TTY, a missing task is a usage error rather than a hang", async () => {
  const ctx = startCtx({ template: TEMPLATE, tty: false });
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, undefined), /Usage: forge start/);
});

test("an invalid ref from the menu is rejected before reaching su -c", async () => {
  const ctx = startCtx({ template: TEMPLATE, answers: [2, "--upload-pack=evil", "x"] });
  await assert.rejects(() => cmdStart(ctx, OWNER_REPO, undefined), /must not start with/);
});

// Fail-fast : sans mustSucceed, `git worktree add` pouvait échouer et start
// enchaînait sur l'attach — dans un répertoire qui n'existe pas.
test("a failing worktree add aborts instead of attaching to a missing directory", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "worktree add", code: 1, stderr: "fatal: invalid reference: origin/main\n" }],
  });
  await assert.rejects(
    () => cmdStart(ctx, OWNER_REPO, "fresh"),
    /git worktree add failed: fatal: invalid reference: origin\/main/,
  );
  assert.ok(!ctx.calls.some((call) => call.includes("tmux")), "attaché malgré l'échec de la création");
  assert.ok(!ctx.out_lines.some((l) => l.includes("Attaching to")), ctx.out_lines.join(" | "));
});

test("start fails when the task container refuses to start", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "lxc start", code: 1, stderr: "Error: Failed to start device\n" }],
  });
  await assert.rejects(
    () => cmdStart(ctx, OWNER_REPO, "fresh"),
    /lxc start failed: Error: Failed to start device/,
  );
  assert.ok(!ctx.calls.some((call) => call.join(" ").includes("worktree add")));
});

// Choix délibéré : le rafraîchissement de main n'est PAS fatal (l'opérateur
// hors ligne doit pouvoir travailler sur les dernières refs connues, comme le
// fait déjà un container supervised), mais il ne doit jamais être silencieux.
test("a failing fetch is surfaced on stderr instead of passing silently", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "fetch origin", code: 1, stderr: "fatal: unable to access 'https://github.com/': timed out\n" }],
  });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  const errs = ctx.err_lines.join("\n");
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
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/agent/agent-forge\n" }],
  });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  const flat = ctx.calls.map((x) => x.join(" "));
  assert.ok(flat.some((l) => l.includes("fetch origin main:main")), flat.join("\n"));
  assert.ok(!flat.some((l) => l.includes("merge")), "aucun merge ne doit toucher la branche sortie");
});

test("when /workspace is on main, the checkout itself is fast-forwarded", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [{ match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/main\n" }],
  });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  const flat = ctx.calls.map((x) => x.join(" "));
  // Ici le ref ET le working tree doivent bouger ensemble : un
  // `fetch origin main:main` refuserait d'écrire dans une branche sortie.
  assert.ok(flat.some((l) => l.includes("--ff-only origin/main")), flat.join("\n"));
  assert.ok(!flat.some((l) => l.includes("fetch origin main:main")), "pas de fetch dans une branche sortie");
});

// Le fetch et l'avancée de main étaient chaînés par `&&` et rapportés comme un
// seul échec : une avancée qui échoue accusait donc origin/main d'être périmé,
// alors que le fetch venait de le rafraîchir. Deux étapes, deux diagnostics.
test("a failed main update does not claim origin/main is stale", async () => {
  const ctx = startCtx({
    template: TEMPLATE,
    extra: [
      { match: "symbolic-ref --quiet HEAD", stdout: "refs/heads/agent/agent-forge\n" },
      { match: "fetch origin main:main", code: 1, stderr: " ! [rejected] main -> main (non-fast-forward)\n" },
    ],
  });
  await cmdStart(ctx, OWNER_REPO, "fresh");
  const errs = ctx.err_lines.join("\n");
  assert.match(errs, /non-fast-forward/);
  assert.doesNotMatch(errs, /stale origin\/main/);
  // Le worktree part quand même d'origin/main, qui EST à jour.
  assert.ok(added(ctx).includes("origin/main"), added(ctx));
});
