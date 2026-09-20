# One Container per Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LXD container the unit of a *task* instead of a *repo*, so parallel agents on one repo stop colliding on ports, Docker container names and build caches — without losing the cheap second-task start that the current model provides.

**Architecture:** The host mount stays **per repo** (one clone, one shared `.git`, `.trees/<task>` worktrees). What splits is the container layer: a per-repo **template** container (`user.forge.role=template`, always stopped after provisioning) is duplicated with `lxc copy` into one **task** container per task (`user.forge.role=task`). The GitHub PAT moves to a host store so provisioning becomes non-interactive; `claude-code` arrives through a read-only versioned disk device so long-lived containers stay fresh; npm/pnpm caches live inside the repo mount, the only place where pnpm's hardlinks survive `EXDEV`.

**Tech Stack:** TypeScript run directly by Node 24 (no build step, no bundler — Node's type stripping), bash for the image build and security hook, LXD 5.21, `node:test` for unit/contract/integration tests.

**Spec:** `docs/superpowers/specs/2026-09-20-container-per-task-design.md`

## Global Constraints

- **Security posture is unchanged.** `security.privileged: "false"`, `security.nesting: "true"`, every `lxc.cap.drop` line, and `security.syscalls.deny_default: "true"` stay exactly as they are in both profiles. `.claude/hooks/pre-bash.sh` gets **no new rule and no modification**.
- **Two new config keys, exact spelling:** `user.forge.role` (values `template` | `task`) and `user.forge.task` (the task name). The existing `user.forge.repo`, `user.forge.mode`, `user.forge.image_commit` keep their meaning.
- **Container names:** template = `agent-<owner>-<repo>` (unchanged from today's repo container), task = `agent-<owner>-<repo>-<task>`, truncated with an 8-hex-char hash suffix past LXD's **63-character** instance-name limit, never ending in `-`.
- **Host paths, all overridable by env for tests:** `FORGE_HOME` (default `/home/moroine`), `FORGE_REPO_DIR` (default `$FORGE_HOME/agent-forge`), `FORGE_WORKSPACES` (default `$FORGE_HOME/workspaces`), `FORGE_CONFIG_HOME` (default `$FORGE_HOME/.config/agent-forge`), `FORGE_CLAUDE_DIST` (default `$FORGE_HOME/.local/share/agent-forge/claude`).
- **The PAT never reaches `argv`.** It goes to `gh auth login --with-token` through `ctx.exec(..., { input })` only. The store file is `chmod 600` inside a `chmod 700` directory, and it is **never** placed under `FORGE_WORKSPACES` (everything there is readable by the agent through `/workspace`).
- **Cache location is load-bearing:** `/workspace/.forge-cache/{npm,pnpm}` — inside the repo mount, therefore the same mount as `.trees/`, therefore hardlinkable. Do not "tidy" it into a separate device.
- **Fail-fast discipline:** every *mutating* call goes through `mustSucceed(step, …)`; probes (`test -e`, `show-ref`, `list-sessions`, `config get`) use their exit code as an answer and must not.
- **Bash strict mode** (`set -e`), quote all variables, in every shell script.
- **Never touch `main`.** Work commits on the current `agent/forge-separate-containers` branch. Autonomous mode: push to `origin agent/forge-separate-containers` and open a PR with `gh pr create --base main`; never merge it.
- Tests run via `npm test` (`test:unit` = `node --test tests/*.test.ts`, `test:contract`, `test:bash` = every `tests/test-*.sh`). Type-check with `npm run check` (`tsc --noEmit`). Integration (`npm run test:integration`) is opt-in via `FORGE_INTEGRATION=1` and needs a live LXD.

---

### Task 1: Host path resolution (`hostpaths.ts`)

Today `home()`, `repoDir()` and `workspaces()` are private to `provision.ts`. Three more modules are about to need them. Extract first, so nothing else in the plan has to duplicate an env-override.

**Files:**
- Create: `scripts/lib/hostpaths.ts`
- Modify: `scripts/lib/commands/provision.ts` (delete the three local helpers, import instead)
- Test: `tests/hostpaths.test.ts`

**Interfaces:**
- Produces: `home()`, `repoDir()`, `workspaces()`, `configHome()`, `claudeDist()` — all `(): string`, all reading `process.env` on **every call** (never cached at module load, so tests can set env per test).

- [ ] **Step 1: Write the failing test**

```ts
// tests/hostpaths.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { home, repoDir, workspaces, configHome, claudeDist } from "../scripts/lib/hostpaths.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; 
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const CLEAR = {
  FORGE_HOME: undefined, FORGE_REPO_DIR: undefined, FORGE_WORKSPACES: undefined,
  FORGE_CONFIG_HOME: undefined, FORGE_CLAUDE_DIST: undefined,
};

test("defaults hang off /home/moroine", () => {
  withEnv(CLEAR, () => {
    assert.equal(home(), "/home/moroine");
    assert.equal(repoDir(), "/home/moroine/agent-forge");
    assert.equal(workspaces(), "/home/moroine/workspaces");
    assert.equal(configHome(), "/home/moroine/.config/agent-forge");
    assert.equal(claudeDist(), "/home/moroine/.local/share/agent-forge/claude");
  });
});

test("FORGE_HOME moves every derived path", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/h" }, () => {
    assert.equal(repoDir(), "/tmp/h/agent-forge");
    assert.equal(workspaces(), "/tmp/h/workspaces");
    assert.equal(configHome(), "/tmp/h/.config/agent-forge");
    assert.equal(claudeDist(), "/tmp/h/.local/share/agent-forge/claude");
  });
});

test("each path has its own override, which wins over FORGE_HOME", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/h", FORGE_CONFIG_HOME: "/tmp/cfg", FORGE_CLAUDE_DIST: "/tmp/cl" }, () => {
    assert.equal(configHome(), "/tmp/cfg");
    assert.equal(claudeDist(), "/tmp/cl");
    assert.equal(workspaces(), "/tmp/h/workspaces");
  });
});

test("the env is read per call, not captured at import time", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/a" }, () => assert.equal(home(), "/tmp/a"));
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/b" }, () => assert.equal(home(), "/tmp/b"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/hostpaths.test.ts`
Expected: FAIL — `Cannot find module '../scripts/lib/hostpaths.ts'`

- [ ] **Step 3: Write the module**

```ts
// scripts/lib/hostpaths.ts
// Un seul endroit où les chemins hôte sont résolus. Chaque fonction relit
// process.env à l'appel : les tests surchargent l'environnement par test, et
// une constante capturée à l'import les rendrait ininspectables.
import { join } from "node:path";

export function home(): string { return process.env.FORGE_HOME ?? "/home/moroine"; }
export function repoDir(): string { return process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge"); }
export function workspaces(): string { return process.env.FORGE_WORKSPACES ?? join(home(), "workspaces"); }

// Hors de workspaces() délibérément : tout ce qui vit sous le montage est
// lisible par l'agent via /workspace.
export function configHome(): string {
  return process.env.FORGE_CONFIG_HOME ?? join(home(), ".config", "agent-forge");
}

export function claudeDist(): string {
  return process.env.FORGE_CLAUDE_DIST ?? join(home(), ".local", "share", "agent-forge", "claude");
}
```

- [ ] **Step 4: Rewire `provision.ts`**

In `scripts/lib/commands/provision.ts`, delete the three local arrow helpers:

```ts
const home = () => process.env.FORGE_HOME ?? "/home/moroine";
const repoDir = () => process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge");
const workspaces = () => process.env.FORGE_WORKSPACES ?? join(home(), "workspaces");
```

and replace them with an import (keep `join` — it is still used for the credential/key paths):

```ts
import { home, repoDir, workspaces } from "../hostpaths.ts";
```

- [ ] **Step 5: Run the suite**

Run: `node --test tests/hostpaths.test.ts tests/provision.test.ts && npm run check`
Expected: PASS, no type errors. `provision.test.ts` must be untouched and still green — this step changes no behaviour.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/hostpaths.ts scripts/lib/commands/provision.ts tests/hostpaths.test.ts
git commit -m "refactor: extraire la résolution des chemins hôte dans hostpaths.ts"
```

---

### Task 2: `containers.ts` — roles, task containers, name truncation

The central refactor. `containerForRepo` assumed one container per repo; it splits into a template lookup, a task-container list, and a per-task lookup, all fed by a single `lxc list`.

**Files:**
- Modify: `scripts/lib/containers.ts`
- Test: `tests/containers.test.ts`

**Interfaces:**
- Consumes: `hostpaths.ts` — nothing yet.
- Produces, and every later task depends on these exact names:
  - `ROLE_TEMPLATE = "template"`, `ROLE_TASK = "task"`
  - `type ForgeContainer = { name: string; status: string; repo: string; mode: string; role: string; task: string }`
  - `templateContainerName(ownerRepo: string): string`
  - `taskContainerName(ownerRepo: string, task: string): string`
  - `describeContainers(ctx: Context): Promise<ForgeContainer[]>`
  - `templateForRepo(ctx, ownerRepo): Promise<ForgeContainer | null>`
  - `requireTemplateForRepo(ctx, ownerRepo): Promise<ForgeContainer>`
  - `taskContainersForRepo(ctx, ownerRepo): Promise<ForgeContainer[]>`
  - `containerForTask(ctx, ownerRepo, task): Promise<ForgeContainer | null>`
  - `requireContainerForTask(ctx, ownerRepo, task): Promise<ForgeContainer>`
  - `isLegacy(c: ForgeContainer): boolean`
  - kept as-is: `forgeContainerNames`, `listForgeContainers`, `containerRepo`, `containerMode`, `isRunning`, `baseImageFor`, `latestImageCommitFor`, `containerImageCommit`, `buildStatus`, `checkNameCollision`
  - changed: `forgeRepos` now **de-duplicates** (several containers share a repo)
  - **removed**: `containerForRepo`, `requireContainerForRepo` (callers migrate in Tasks 6–12)

- [ ] **Step 1: Write the failing tests**

Append to `tests/containers.test.ts`:

```ts
import {
  ROLE_TASK, ROLE_TEMPLATE, templateContainerName, taskContainerName,
  describeContainers, templateForRepo, requireTemplateForRepo,
  taskContainersForRepo, containerForTask, requireContainerForTask, isLegacy,
} from "../scripts/lib/containers.ts";

const FLEET = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Stopped" },
  { name: "agent-moroine-agent-forge-cli", status: "Running" },
  { name: "agent-moroine-agent-forge-api", status: "Stopped" },
  { name: "agent-acme-widgets", status: "Stopped" },
  { name: "agent-legacy-thing", status: "Running" },
  { name: "unrelated-container", status: "Running" },
]);

function fleetCtx() {
  const meta: Record<string, Record<string, string>> = {
    "agent-moroine-agent-forge":     { repo: "moroine/agent-forge", mode: "super",      role: "template", task: "" },
    "agent-moroine-agent-forge-cli": { repo: "moroine/agent-forge", mode: "super",      role: "task",     task: "cli" },
    "agent-moroine-agent-forge-api": { repo: "moroine/agent-forge", mode: "super",      role: "task",     task: "api" },
    "agent-acme-widgets":            { repo: "acme/widgets",        mode: "supervised", role: "template", task: "" },
    "agent-legacy-thing":            { repo: "legacy/thing",        mode: "autonomous", role: "",         task: "" },
  };
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: FLEET },
      ...Object.entries(meta).flatMap(([name, m]) => [
        { match: `config get ${name} user.forge.repo`, stdout: m.repo },
        { match: `config get ${name} user.forge.mode`, stdout: m.mode },
        { match: `config get ${name} user.forge.role`, stdout: m.role },
        { match: `config get ${name} user.forge.task`, stdout: m.task },
      ]),
    ],
  });
}

test("templateContainerName keeps today's repo-container name", () => {
  assert.equal(templateContainerName("moroine/agent-forge"), "agent-moroine-agent-forge");
});

test("taskContainerName suffixes the task and sanitizes it", () => {
  assert.equal(taskContainerName("moroine/agent-forge", "cli"), "agent-moroine-agent-forge-cli");
  assert.equal(taskContainerName("Moroine/Agent_Forge", "Feat.A"), "agent-moroine-agent-forge-feat-a");
});

test("taskContainerName stays within LXD's 63 chars and never ends in a hyphen", () => {
  const name = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  assert.ok(name.length <= 63, `got ${name.length}: ${name}`);
  assert.ok(!name.endsWith("-"), name);
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
});

test("taskContainerName is deterministic and collision-resistant when truncated", () => {
  const a = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  const b = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-again");
  const c = taskContainerName("someorg/a-very-long-repository-name-here", "an-extremely-long-task-name-agaix");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("describeContainers reads the fleet with a single lxc list", async () => {
  const ctx = fleetCtx();
  const all = await describeContainers(ctx);
  assert.deepEqual(all.map((c) => c.name), [
    "agent-moroine-agent-forge", "agent-moroine-agent-forge-cli",
    "agent-moroine-agent-forge-api", "agent-acme-widgets", "agent-legacy-thing",
  ]);
  assert.equal(ctx.calls.filter((c) => c[1] === "list").length, 1);
});

test("templateForRepo finds the role=template container, case-insensitively", async () => {
  const ctx = fleetCtx();
  const t = await templateForRepo(ctx, "Moroine/Agent-Forge");
  assert.equal(t?.name, "agent-moroine-agent-forge");
  assert.equal(t?.role, ROLE_TEMPLATE);
  assert.equal(t?.mode, "super");
});

test("templateForRepo ignores a legacy container with no role", async () => {
  assert.equal(await templateForRepo(fleetCtx(), "legacy/thing"), null);
});

test("requireTemplateForRepo names the repo and the fix", async () => {
  await assert.rejects(() => requireTemplateForRepo(fleetCtx(), "nobody/nothing"), /nobody\/nothing/);
  await assert.rejects(() => requireTemplateForRepo(fleetCtx(), "nobody/nothing"), /forge start/);
});

test("taskContainersForRepo returns only role=task, for that repo", async () => {
  const tasks = await taskContainersForRepo(fleetCtx(), "moroine/agent-forge");
  assert.deepEqual(tasks.map((c) => c.task), ["cli", "api"]);
  assert.deepEqual(tasks.map((c) => c.status), ["Running", "Stopped"]);
});

test("containerForTask matches on user.forge.task, not on the name", async () => {
  const c = await containerForTask(fleetCtx(), "moroine/agent-forge", "api");
  assert.equal(c?.name, "agent-moroine-agent-forge-api");
  assert.equal(await containerForTask(fleetCtx(), "moroine/agent-forge", "absent"), null);
});

test("requireContainerForTask throws a ForgeError naming the task", async () => {
  await assert.rejects(() => requireContainerForTask(fleetCtx(), "moroine/agent-forge", "absent"), ForgeError);
  await assert.rejects(() => requireContainerForTask(fleetCtx(), "moroine/agent-forge", "absent"), /absent/);
});

test("isLegacy flags a forge container with no role", async () => {
  const all = await describeContainers(fleetCtx());
  assert.deepEqual(all.filter(isLegacy).map((c) => c.name), ["agent-legacy-thing"]);
});

test("forgeRepos de-duplicates repos shared by several containers", async () => {
  assert.deepEqual(await forgeRepos(fleetCtx()), ["moroine/agent-forge", "acme/widgets", "legacy/thing"]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/containers.test.ts`
Expected: FAIL — `ROLE_TASK is not exported` / `templateContainerName is not a function`

- [ ] **Step 3: Implement**

In `scripts/lib/containers.ts`, add the imports and the new surface:

```ts
import { createHash } from "node:crypto";
import { sanitizeContainerName } from "./validate.ts";

export const ROLE_TEMPLATE = "template";
export const ROLE_TASK = "task";

export type ForgeContainer = {
  name: string; status: string; repo: string; mode: string; role: string; task: string;
};

// Le template garde le nom que portait le container de repo : la distinction
// est portée par user.forge.role, pas par une convention de nom.
export function templateContainerName(ownerRepo: string): string {
  return sanitizeContainerName(ownerRepo);
}

const MAX_INSTANCE_NAME = 63;   // limite LXD (nom d'hôte valide)
const HASH_LEN = 8;

// Tronque en gardant un suffixe de hash : deux tâches longues et proches
// doivent rester distinctes, et un nom d'instance ne peut pas finir par '-'.
export function taskContainerName(ownerRepo: string, task: string): string {
  const slug = task.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const full = `${templateContainerName(ownerRepo)}-${slug}`;
  if (full.length <= MAX_INSTANCE_NAME) return full.replace(/-+$/, "");
  const hash = createHash("sha256").update(full).digest("hex").slice(0, HASH_LEN);
  const head = full.slice(0, MAX_INSTANCE_NAME - HASH_LEN - 1).replace(/-+$/, "");
  return `${head}-${hash}`;
}

// Un seul `lxc list` pour toute la flotte, puis les clés de config par
// container. Les commandes qui bouclaient sur listForgeContainers +
// containerRepo passent toutes par ici.
export async function describeContainers(ctx: Context): Promise<ForgeContainer[]> {
  const instances = await listInstances(ctx);
  const out: ForgeContainer[] = [];
  for (const name of forgeContainerNames(instances)) {
    out.push({
      name,
      status: instances.find((i) => i.name === name)?.status ?? "Unknown",
      repo: await configGet(ctx, name, "user.forge.repo"),
      mode: await configGet(ctx, name, "user.forge.mode"),
      role: await configGet(ctx, name, "user.forge.role"),
      task: await configGet(ctx, name, "user.forge.task"),
    });
  }
  return out;
}

const sameRepo = (c: ForgeContainer, ownerRepo: string) =>
  c.repo.toLowerCase() === ownerRepo.toLowerCase();

export async function templateForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer | null> {
  const all = await describeContainers(ctx);
  return all.find((c) => c.role === ROLE_TEMPLATE && sameRepo(c, ownerRepo)) ?? null;
}

export async function requireTemplateForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer> {
  const t = await templateForRepo(ctx, ownerRepo);
  if (!t) {
    throw new ForgeError(
      `no template container for ${ownerRepo}. Run 'forge start ${ownerRepo} <task>' to provision one.`,
    );
  }
  return t;
}

export async function taskContainersForRepo(ctx: Context, ownerRepo: string): Promise<ForgeContainer[]> {
  const all = await describeContainers(ctx);
  return all.filter((c) => c.role === ROLE_TASK && sameRepo(c, ownerRepo));
}

export async function containerForTask(
  ctx: Context, ownerRepo: string, task: string,
): Promise<ForgeContainer | null> {
  const tasks = await taskContainersForRepo(ctx, ownerRepo);
  return tasks.find((c) => c.task === task) ?? null;
}

export async function requireContainerForTask(
  ctx: Context, ownerRepo: string, task: string,
): Promise<ForgeContainer> {
  const c = await containerForTask(ctx, ownerRepo, task);
  if (!c) throw new ForgeError(`no container for task '${task}' in ${ownerRepo}.`);
  return c;
}

// Container forge d'avant ce modèle : aucune clé de rôle. `forge list` le
// signale au lieu de le confondre avec un template.
export function isLegacy(c: ForgeContainer): boolean {
  return c.repo !== "" && c.role === "";
}
```

Rewrite `forgeRepos` to de-duplicate, and delete `containerForRepo` /
`requireContainerForRepo`:

```ts
export async function forgeRepos(ctx: Context): Promise<string[]> {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const c of await describeContainers(ctx)) {
    if (!c.repo || seen.has(c.repo.toLowerCase())) continue;
    seen.add(c.repo.toLowerCase());
    repos.push(c.repo);
  }
  return repos;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/containers.test.ts`
Expected: PASS. `npm run check` will still report errors in the *callers* of the deleted `requireContainerForRepo` — that is expected and is Tasks 6–12's job; do not paper over it here.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/containers.ts tests/containers.test.ts
git commit -m "feat(containers): rôles template/task, nommage des containers de tâche"
```

---

### Task 3: `lxd.ts` — copy, devices, and the attach argv

**Files:**
- Modify: `scripts/lib/lxd.ts`
- Test: `tests/lxd.test.ts`

**Interfaces:**
- Produces:
  - `copyInstance(ctx, source: string, target: string): Promise<ExecResult>`
  - `addDiskDevice(ctx, name: string, device: string, source: string, path: string, readonly?: boolean): Promise<ExecResult>`
  - `attachArgv(container: string, task: string, term: string): string[]` — **changed**: `--remote-control` now receives the container name alone.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lxd.test.ts`:

```ts
import { copyInstance, addDiskDevice, attachArgv } from "../scripts/lib/lxd.ts";

test("copyInstance shells out to lxc copy", async () => {
  const ctx = fakeContext({});
  await copyInstance(ctx, "agent-o-r", "agent-o-r-task");
  assert.deepEqual(ctx.calls[0], ["lxc", "copy", "agent-o-r", "agent-o-r-task"]);
});

test("addDiskDevice passes source and path, and readonly only when asked", async () => {
  const ctx = fakeContext({});
  await addDiskDevice(ctx, "agent-x", "workspace", "/h/w/agent-x", "/workspace");
  assert.deepEqual(ctx.calls[0], [
    "lxc", "config", "device", "add", "agent-x", "workspace", "disk",
    "source=/h/w/agent-x", "path=/workspace",
  ]);

  const ro = fakeContext({});
  await addDiskDevice(ro, "agent-x", "forge-claude", "/h/claude", "/opt/forge-claude", true);
  assert.deepEqual(ro.calls[0], [
    "lxc", "config", "device", "add", "agent-x", "forge-claude", "disk",
    "source=/h/claude", "path=/opt/forge-claude", "readonly=true",
  ]);
});

test("attachArgv names remote-control after the container alone", () => {
  const argv = attachArgv("agent-moroine-agent-forge-cli", "cli", "xterm-256color");
  const joined = argv.join(" ");
  assert.match(joined, /--remote-control agent-moroine-agent-forge-cli'/);
  assert.ok(!joined.includes("agent-moroine-agent-forge-cli-cli"), "plus de suffixe de tâche");
  assert.ok(argv.includes("--cwd"));
  assert.ok(argv.includes("/workspace/.trees/cli"));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/lxd.test.ts`
Expected: FAIL — `copyInstance is not a function`, and the attach assertion fails on the old `${container}-${task}` name.

- [ ] **Step 3: Implement**

In `scripts/lib/lxd.ts`:

```ts
// Copie d'instance : la source DOIT être stoppée (voir §1 de la spec — un
// rootfs copié en cours d'écriture emporte un containerd/dqlite incohérent).
// Le device `workspace` fait partie de la config d'instance, donc la copie
// pointe sur le même répertoire hôte : c'est exactement ce qu'on veut.
export function copyInstance(ctx: Context, source: string, target: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "copy", source, target]);
}

export function addDiskDevice(
  ctx: Context, name: string, device: string, source: string, path: string, readonly = false,
): Promise<ExecResult> {
  const argv = ["lxc", "config", "device", "add", name, device, "disk",
    `source=${source}`, `path=${path}`];
  if (readonly) argv.push("readonly=true");
  return ctx.exec(argv);
}
```

And in `attachArgv`, change the last element:

```ts
    `exec bash -lc 'claude --permission-mode auto --remote-control ${container}'`,
```

with the comment above it updated to: *"Le nom du container porte déjà la tâche : plus de suffixe."*

- [ ] **Step 4: Run the tests**

Run: `node --test tests/lxd.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/lxd.ts tests/lxd.test.ts
git commit -m "feat(lxd): copyInstance, addDiskDevice, remote-control nommé par le container"
```

---

### Task 4: Host credential store + `forge token set|rm|import`

**Files:**
- Create: `scripts/lib/credentials.ts`
- Create: `scripts/lib/commands/token.ts`
- Test: `tests/credentials.test.ts`, `tests/token.test.ts`

**Interfaces:**
- Consumes: `configHome()` from Task 1; `describeContainers` / `templateForRepo` from Task 2; `execAsAgent` from `lxd.ts`.
- Produces:
  - `credentialPath(ownerRepo: string): string`
  - `readToken(ownerRepo: string): string | null`
  - `writeToken(ownerRepo: string, token: string): void`
  - `removeToken(ownerRepo: string): boolean`
  - `cmdToken(ctx: Context, sub: string | undefined, repo: string | undefined): Promise<number>`

- [ ] **Step 1: Write the failing store test**

```ts
// tests/credentials.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialPath, readToken, writeToken, removeToken } from "../scripts/lib/credentials.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-cred-"));
  process.env.FORGE_CONFIG_HOME = dir;
  return dir;
}

test("credentialPath flattens owner/repo into one file name", () => {
  const dir = sandbox();
  assert.equal(credentialPath("moroine/agent-forge"), join(dir, "credentials", "moroine-agent-forge"));
});

test("readToken returns null when nothing is stored", () => {
  sandbox();
  assert.equal(readToken("moroine/agent-forge"), null);
});

test("writeToken creates a 0700 directory holding a 0600 file", () => {
  const dir = sandbox();
  writeToken("moroine/agent-forge", "ghp_secret");
  assert.equal(statSync(join(dir, "credentials")).mode & 0o777, 0o700);
  assert.equal(statSync(credentialPath("moroine/agent-forge")).mode & 0o777, 0o600);
  assert.equal(readFileSync(credentialPath("moroine/agent-forge"), "utf8"), "ghp_secret");
});

test("readToken trims the trailing newline an editor would add", () => {
  sandbox();
  writeToken("o/r", "  ghp_secret\n");
  assert.equal(readToken("o/r"), "ghp_secret");
});

test("writeToken overwrites and keeps the mode", () => {
  sandbox();
  writeToken("o/r", "first");
  writeToken("o/r", "second");
  assert.equal(readToken("o/r"), "second");
  assert.equal(statSync(credentialPath("o/r")).mode & 0o777, 0o600);
});

test("removeToken reports whether there was anything to remove", () => {
  sandbox();
  assert.equal(removeToken("o/r"), false);
  writeToken("o/r", "x");
  assert.equal(removeToken("o/r"), true);
  assert.equal(existsSync(credentialPath("o/r")), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/credentials.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the store**

```ts
// scripts/lib/credentials.ts
// Store hôte des PAT GitHub, un fichier par repo.
//
// La spec du 2026-07-17 gardait le token hors du disque hôte. Sur une machine
// dédiée, cette précaution ne défend contre rien : qui tient l'hôte fait
// `lxc exec` en root dans n'importe quel container et y lit déjà le token.
// La règle qui compte est l'emplacement : JAMAIS sous FORGE_WORKSPACES, dont
// tout le contenu est lisible par l'agent via /workspace.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./hostpaths.ts";

function credentialsDir(): string { return join(configHome(), "credentials"); }

export function credentialPath(ownerRepo: string): string {
  return join(credentialsDir(), ownerRepo.toLowerCase().replace(/\//g, "-"));
}

export function readToken(ownerRepo: string): string | null {
  const file = credentialPath(ownerRepo);
  if (!existsSync(file)) return null;
  const token = readFileSync(file, "utf8").trim();
  return token === "" ? null : token;
}

export function writeToken(ownerRepo: string, token: string): void {
  mkdirSync(credentialsDir(), { recursive: true, mode: 0o700 });
  // mkdirSync n'applique `mode` qu'à la création : un répertoire préexistant
  // trop ouvert resterait tel quel.
  chmodSync(credentialsDir(), 0o700);
  const file = credentialPath(ownerRepo);
  writeFileSync(file, token.trim(), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function removeToken(ownerRepo: string): boolean {
  const file = credentialPath(ownerRepo);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
```

- [ ] **Step 4: Run it**

Run: `node --test tests/credentials.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing command test**

```ts
// tests/token.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdToken } from "../scripts/lib/commands/token.ts";
import { readToken, writeToken } from "../scripts/lib/credentials.ts";

function sandbox(): void {
  process.env.FORGE_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-token-"));
}

const FLEET = JSON.stringify([{ name: "agent-o-r", status: "Stopped" }]);
const META = [
  { match: "lxc list", stdout: FLEET },
  { match: "config get agent-o-r user.forge.repo", stdout: "o/r" },
  { match: "config get agent-o-r user.forge.mode", stdout: "autonomous" },
  { match: "config get agent-o-r user.forge.role", stdout: "template" },
  { match: "config get agent-o-r user.forge.task", stdout: "" },
];

test("token set stores what askSecret returned, and never puts it in argv", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META, answers: ["ghp_typed"] });
  assert.equal(await cmdToken(ctx, "set", "o/r"), 0);
  assert.equal(readToken("o/r"), "ghp_typed");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("ghp_typed")));
});

test("token set refuses an empty token", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META, answers: [""] });
  await assert.rejects(() => cmdToken(ctx, "set", "o/r"), /empty token/);
});

test("token rm says so when there was nothing stored", async () => {
  sandbox();
  const ctx = fakeContext({ rules: META });
  assert.equal(await cmdToken(ctx, "rm", "o/r"), 0);
  assert.match(ctx.out_lines.join("\n"), /no stored token/);
});

test("token import reads gh auth token from the repo's container", async () => {
  sandbox();
  const ctx = fakeContext({
    rules: [...META, { match: "gh auth token", stdout: "ghp_from_container\n" }],
  });
  assert.equal(await cmdToken(ctx, "import", "o/r"), 0);
  assert.equal(readToken("o/r"), "ghp_from_container");
});

test("token import starts a stopped container and stops it again", async () => {
  sandbox();
  const ctx = fakeContext({
    rules: [...META, { match: "gh auth token", stdout: "ghp_x\n" }],
  });
  await cmdToken(ctx, "import", "o/r");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc start agent-o-r"));
  assert.ok(joined.includes("lxc stop agent-o-r"));
  assert.ok(joined.indexOf("lxc start agent-o-r") < joined.indexOf("lxc stop agent-o-r"));
});

test("token import fails loudly when gh has no token", async () => {
  sandbox();
  const ctx = fakeContext({ rules: [...META, { match: "gh auth token", code: 1, stderr: "not logged in" }] });
  await assert.rejects(() => cmdToken(ctx, "import", "o/r"), /not logged in|no token/);
});

test("an unknown subcommand yields the usage", async () => {
  sandbox();
  await assert.rejects(() => cmdToken(fakeContext({ rules: META }), "bogus", "o/r"), /Usage: forge token/);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `node --test tests/token.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Write the command**

```ts
// scripts/lib/commands/token.ts
// forge token set|rm|import [<owner/repo>]
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { readToken, removeToken, writeToken } from "../credentials.ts";
import { describeContainers, isRunning } from "../containers.ts";
import { execAsAgent, startInstance, stopInstance } from "../lxd.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge token set|rm|import [<owner/repo>]";

export async function cmdToken(ctx: Context, sub: string | undefined, repo?: string): Promise<number> {
  if (sub !== "set" && sub !== "rm" && sub !== "import") throw new ForgeError(USAGE);
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  if (sub === "rm") {
    ctx.out(removeToken(ownerRepo) ? `Removed the stored token for ${ownerRepo}.` : `no stored token for ${ownerRepo}.`);
    return 0;
  }

  if (sub === "set") {
    ctx.err(`Fine-grained PAT for ${ownerRepo} (Contents RW, Pull requests RW, Metadata R).`);
    const token = await ctx.prompt.askSecret("Paste the token (input hidden)");
    if (!token) throw new ForgeError("empty token.");
    writeToken(ownerRepo, token);
    ctx.out(`Stored a token for ${ownerRepo}.`);
    return 0;
  }

  // import : récupère le token du container existant du repo, pour migrer sans
  // ressortir un PAT. `gh auth token` n'existe que dans un container démarré.
  const all = await describeContainers(ctx);
  const source = all.find((c) => c.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (!source) throw new ForgeError(`no container for ${ownerRepo} to import a token from.`);

  const wasRunning = await isRunning(ctx, source.name);
  if (!wasRunning) await mustSucceed("lxc start", startInstance(ctx, source.name));
  try {
    const r = await execAsAgent(ctx, source.name, "gh auth token");
    const token = r.stdout.trim();
    if (r.code !== 0 || !token) {
      throw new ForgeError(`no token available in ${source.name}: ${r.stderr.trim() || "gh auth token returned nothing"}`);
    }
    writeToken(ownerRepo, token);
    ctx.out(`Imported ${source.name}'s token into the host store for ${ownerRepo}.`);
  } finally {
    // On rend la machine dans l'état où on l'a trouvée, y compris en cas
    // d'échec : `import` ne doit pas laisser un container allumé derrière lui.
    if (!wasRunning) await stopInstance(ctx, source.name);
  }
  return 0;
}
```

- [ ] **Step 8: Run both test files**

Run: `node --test tests/credentials.test.ts tests/token.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/credentials.ts scripts/lib/commands/token.ts tests/credentials.test.ts tests/token.test.ts
git commit -m "feat(token): store hôte des PAT, avec set/rm/import"
```

---

### Task 5: `claude-code` distribution — host versions, atomic switch, `forge claude`

**Files:**
- Create: `scripts/lib/claude-dist.ts`
- Create: `scripts/lib/commands/claude.ts`
- Test: `tests/claude-dist.test.ts`, `tests/claude-cmd.test.ts`

**Interfaces:**
- Consumes: `claudeDist()` from Task 1.
- Produces:
  - `versionsDir(): string`, `currentLink(): string`, `versionDir(version: string): string`
  - `listVersions(): string[]` (lexicographically sorted, `[]` when nothing installed)
  - `currentVersion(): string | null`
  - `installArgv(version: string): string[]` — the npm argv to run
  - `switchCurrent(version: string): void` — atomic symlink replacement
  - `cmdClaude(ctx, sub: string | undefined, version: string | undefined): Promise<number>`

- [ ] **Step 1: Write the failing module test**

```ts
// tests/claude-dist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  versionsDir, currentLink, versionDir, listVersions, currentVersion,
  installArgv, switchCurrent,
} from "../scripts/lib/claude-dist.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-claude-"));
  process.env.FORGE_CLAUDE_DIST = dir;
  return dir;
}

test("the layout is versions/<v> plus a current symlink", () => {
  const dir = sandbox();
  assert.equal(versionsDir(), join(dir, "versions"));
  assert.equal(versionDir("2.0.14"), join(dir, "versions", "2.0.14"));
  assert.equal(currentLink(), join(dir, "current"));
});

test("listVersions is empty before anything is installed", () => {
  sandbox();
  assert.deepEqual(listVersions(), []);
});

test("listVersions lists directories only, sorted", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  writeFileSync(join(dir, "versions", "README"), "not a version");
  assert.deepEqual(listVersions(), ["2.0.14", "2.0.9"]);
});

test("currentVersion is null with no symlink, and the basename otherwise", () => {
  const dir = sandbox();
  assert.equal(currentVersion(), null);
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  symlinkSync(join(dir, "versions", "2.0.14"), join(dir, "current"));
  assert.equal(currentVersion(), "2.0.14");
});

test("installArgv installs into the version directory, pinned", () => {
  const dir = sandbox();
  assert.deepEqual(installArgv("2.0.14"), [
    "npm", "install", "--prefix", join(dir, "versions", "2.0.14"),
    "@anthropic-ai/claude-code@2.0.14",
  ]);
});

test("switchCurrent replaces an existing symlink atomically", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  switchCurrent("2.0.9");
  assert.equal(currentVersion(), "2.0.9");
  switchCurrent("2.0.14");
  assert.equal(currentVersion(), "2.0.14");
  assert.equal(readlinkSync(join(dir, "current")), join(dir, "versions", "2.0.14"));
});

test("switchCurrent refuses a version that is not installed", () => {
  sandbox();
  assert.throws(() => switchCurrent("9.9.9"), /9\.9\.9/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/claude-dist.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the module**

```ts
// scripts/lib/claude-dist.ts
// Distribution de claude-code depuis l'hôte : des installs versionnées,
// immuables, et un symlink `current` remplacé par rename atomique.
//
// C'est ce qui rend une mise à jour sûre pendant qu'une session tourne :
// claude-code importe paresseusement, donc écraser une install en place
// peut faire disparaître un module avant qu'il soit chargé. Ici personne
// n'écrase rien — on pose une nouvelle version à côté et on bascule le lien.
// Le shim du container résout `current` UNE fois, au lancement.
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ForgeError } from "./context.ts";
import { claudeDist } from "./hostpaths.ts";

export function versionsDir(): string { return join(claudeDist(), "versions"); }
export function versionDir(version: string): string { return join(versionsDir(), version); }
export function currentLink(): string { return join(claudeDist(), "current"); }

export function listVersions(): string[] {
  if (!existsSync(versionsDir())) return [];
  return readdirSync(versionsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function currentVersion(): string | null {
  if (!existsSync(currentLink())) return null;
  return readlinkSync(currentLink()).split("/").pop() ?? null;
}

export function installArgv(version: string): string[] {
  return ["npm", "install", "--prefix", versionDir(version), `@anthropic-ai/claude-code@${version}`];
}

export function switchCurrent(version: string): void {
  if (!existsSync(versionDir(version))) {
    throw new ForgeError(`claude-code ${version} is not installed. Run 'forge claude update ${version}' first.`);
  }
  mkdirSync(claudeDist(), { recursive: true });
  // symlink + rename, jamais unlink + symlink : le lien ne doit à aucun
  // instant être absent, sinon un shim qui démarre pile là échouerait.
  const tmp = `${currentLink()}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(versionDir(version), tmp);
  renameSync(tmp, currentLink());
}
```

- [ ] **Step 4: Run it**

Run: `node --test tests/claude-dist.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing command test**

```ts
// tests/claude-cmd.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdClaude } from "../scripts/lib/commands/claude.ts";
import { currentVersion } from "../scripts/lib/claude-dist.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-claude-cmd-"));
  process.env.FORGE_CLAUDE_DIST = dir;
  return dir;
}

test("claude list shows each version and marks the current one", async () => {
  const dir = sandbox();
  mkdirSync(join(dir, "versions", "2.0.9"), { recursive: true });
  mkdirSync(join(dir, "versions", "2.0.14"), { recursive: true });
  const ctx = fakeContext({});
  await cmdClaude(ctx, "list", undefined);
  const out = ctx.out_lines.join("\n");
  assert.match(out, /2\.0\.9/);
  assert.match(out, /2\.0\.14/);
  assert.match(out, /none/);
});

test("claude update resolves 'latest' through npm view when no version is given", async () => {
  sandbox();
  const ctx = fakeContext({ rules: [{ match: "npm view", stdout: "2.0.14\n" }] });
  assert.equal(await cmdClaude(ctx, "update", undefined), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ") === "npm view @anthropic-ai/claude-code version"));
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("@anthropic-ai/claude-code@2.0.14")));
  assert.equal(currentVersion(), "2.0.14");
});

test("claude update installs the pinned version and switches current", async () => {
  sandbox();
  const ctx = fakeContext({});
  assert.equal(await cmdClaude(ctx, "update", "2.0.9"), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("@anthropic-ai/claude-code@2.0.9")));
  assert.equal(currentVersion(), "2.0.9");
});

test("claude update does not switch current when npm install fails", async () => {
  sandbox();
  const ctx = fakeContext({ rules: [{ match: "npm install", code: 1, stderr: "ETARGET\n" }] });
  await assert.rejects(() => cmdClaude(ctx, "update", "9.9.9"), /ETARGET/);
  assert.equal(currentVersion(), null);
});

test("an unknown subcommand yields the usage", async () => {
  sandbox();
  await assert.rejects(() => cmdClaude(fakeContext({}), "bogus", undefined), /Usage: forge claude/);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `node --test tests/claude-cmd.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Write the command**

```ts
// scripts/lib/commands/claude.ts
// forge claude update [<version>] | list
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { currentVersion, installArgv, listVersions, switchCurrent } from "../claude-dist.ts";

const USAGE = "Usage: forge claude update [<version>] | list";
const PACKAGE = "@anthropic-ai/claude-code";
const VERSION = /^[0-9][0-9A-Za-z.\-+]*$/;

export async function cmdClaude(ctx: Context, sub: string | undefined, version?: string): Promise<number> {
  if (sub === "list") {
    const current = currentVersion();
    const versions = listVersions();
    ctx.out(`current: ${current ?? "none"}`);
    if (versions.length === 0) ctx.out("no version installed — run 'forge claude update'");
    for (const v of versions) ctx.out(`  ${v}${v === current ? "  <- current" : ""}`);
    return 0;
  }

  if (sub !== "update") throw new ForgeError(USAGE);

  let target = version ?? "";
  if (!target) {
    const view = await mustSucceed("npm view", ctx.exec(["npm", "view", PACKAGE, "version"]));
    target = view.stdout.trim();
    if (!target) throw new ForgeError(`npm view returned no version for ${PACKAGE}.`);
  }
  // Interpolée dans un chemin et dans un spec npm : même discipline que
  // validate.ts pour les noms de tâche.
  if (!VERSION.test(target)) throw new ForgeError(`version must look like a semver, got: ${target}`);

  ctx.out(`Installing ${PACKAGE}@${target}...`);
  await mustSucceed("npm install", ctx.exec(installArgv(target)));

  // Bascule APRÈS l'install : une install ratée ne doit jamais laisser
  // `current` pointer sur un répertoire à moitié écrit.
  switchCurrent(target);
  ctx.out(`claude-code ${target} is now current. Running sessions keep their version until they exit.`);
  return 0;
}
```

- [ ] **Step 8: Run both files**

Run: `node --test tests/claude-dist.test.ts tests/claude-cmd.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/claude-dist.ts scripts/lib/commands/claude.ts tests/claude-dist.test.ts tests/claude-cmd.test.ts
git commit -m "feat(claude): installs versionnées côté hôte et bascule atomique de current"
```

---

### Task 6: The shim in the image, and the read-only device in both profiles

This is the container half of Task 5: `claude` must resolve to the mounted
version instead of a container-local npm global.

**Files:**
- Modify: `scripts/lib/forge-image.sh` (drop the `claude-code` npm install, install the shim)
- Modify: `config/lxd-agent-profile.yaml`, `config/lxd-agent-super-profile.yaml` (add the read-only device)
- Test: `tests/test-forge-image.sh`, `tests/test-lxd-agent-profile.sh`, `tests/test-lxd-agent-super-profile.sh`

**Interfaces:**
- Consumes: the host layout from Task 5 (`versions/<v>`, `current`).
- Produces: `/usr/local/bin/claude` in the image, and a `forge-claude` disk device at `/opt/forge-claude`, `readonly=true`, in both profiles.

- [ ] **Step 1: Write the failing bash assertions**

In `tests/test-lxd-agent-profile.sh`, add before the summary:

```bash
# claude-code arrive par un montage read-only depuis l'hôte (spec §4) :
# l'agent ne peut pas modifier le CLI, et une mise à jour hôte profite à
# tous les containers sans en recréer aucun.
assert_contains 'forge-claude:'
assert_contains 'path: /opt/forge-claude'
assert_contains 'readonly: "true"'
assert_contains 'source: /home/moroine/.local/share/agent-forge/claude'
```

Add the identical four lines to `tests/test-lxd-agent-super-profile.sh`.

In `tests/test-forge-image.sh`, add:

```bash
assert_contains '/usr/local/bin/claude'
assert_contains 'readlink -f /opt/forge-claude/current'
assert_not_contains 'npm install -g @anthropic-ai/claude-code'
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bash tests/test-lxd-agent-profile.sh; bash tests/test-forge-image.sh`
Expected: FAIL on each newly added assertion.

- [ ] **Step 3: Add the device to both profiles**

In `config/lxd-agent-profile.yaml` and `config/lxd-agent-super-profile.yaml`, under `devices:`:

```yaml
  # claude-code vient de l'hôte, en lecture seule : installs versionnées +
  # symlink `current` (voir docs/superpowers/specs/2026-09-20-container-per-task-design.md §4).
  # Le shim /usr/local/bin/claude résout `current` une fois, au lancement, donc
  # une bascule de version côté hôte ne touche jamais une session en cours.
  # readonly=true : durcissement, l'agent ne peut pas modifier le CLI.
  forge-claude:
    source: /home/moroine/.local/share/agent-forge/claude
    path: /opt/forge-claude
    readonly: "true"
    type: disk
```

- [ ] **Step 4: Replace the npm install with the shim in the image**

In `scripts/lib/forge-image.sh`, delete the line

```bash
  lxc exec "$setup" -- npm install -g @anthropic-ai/claude-code
```

and add, next to the other `/usr/local/bin` setup:

```bash
  # claude-code n'est plus installé dans l'image : il est monté en lecture
  # seule depuis l'hôte (device forge-claude). Le shim résout la version UNE
  # fois, au lancement, puis exec le chemin versionné absolu — un `forge claude
  # update` pendant une session ne peut donc pas retirer un module sous les
  # pieds d'un process déjà démarré.
  lxc exec "$setup" -- bash -c 'cat > /usr/local/bin/claude <<"SHIM"
#!/bin/sh
set -e
if [ ! -e /opt/forge-claude/current ]; then
  echo "claude-code is not installed on the host. Run: forge claude update" >&2
  exit 1
fi
V=$(readlink -f /opt/forge-claude/current)
exec "$V/node_modules/.bin/claude" "$@"
SHIM
chmod 755 /usr/local/bin/claude'
```

- [ ] **Step 5: Run the bash tests**

Run: `npm run test:bash`
Expected: PASS across every `tests/test-*.sh`

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/forge-image.sh config/lxd-agent-profile.yaml config/lxd-agent-super-profile.yaml \
        tests/test-forge-image.sh tests/test-lxd-agent-profile.sh tests/test-lxd-agent-super-profile.sh
git commit -m "feat(image): shim claude résolvant le montage read-only forge-claude"
```

---

### Task 7: Provision the **template**

`provisionContainer` stops being "make a working container" and becomes "make
the repo's template": it reads the PAT from the host store, sets up the shared
caches, stamps `role=template`, and **stops** the container at the end.

**Files:**
- Modify: `scripts/lib/commands/provision.ts`
- Test: `tests/provision.test.ts`

**Interfaces:**
- Consumes: `readToken`/`writeToken` (Task 4), `ROLE_TEMPLATE` (Task 2), `hostpaths` (Task 1).
- Produces: `provisionTemplate(ctx: Context, ownerRepo: string): Promise<ForgeContainer>` — renamed from `provisionContainer`, returns the template descriptor Task 8 copies from.

- [ ] **Step 1: Write the failing tests**

Add to `tests/provision.test.ts`:

```ts
test("provisioning reads the PAT from the host store instead of prompting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-prov-"));
  process.env.FORGE_CONFIG_HOME = dir;
  writeToken("o/r", "ghp_stored");
  const ctx = provisionCtx({ answers: ["a"] });   // only the mode question
  await provisionTemplate(ctx, "o/r");
  const login = ctx.calls.findIndex((c) => c.join(" ").includes("gh auth login"));
  assert.ok(login >= 0);
  assert.equal(ctx.execOptions[login]?.input, "ghp_stored");
  assert.ok(!ctx.err_lines.some((l) => l.includes("Paste the token")));
});

test("a token typed at the prompt is persisted to the host store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-prov-"));
  process.env.FORGE_CONFIG_HOME = dir;
  const ctx = provisionCtx({ answers: ["a", "ghp_typed"] });
  await provisionTemplate(ctx, "o/r");
  assert.equal(readToken("o/r"), "ghp_typed");
});

test("provisioning configures the shared caches inside the repo mount", async () => {
  const ctx = provisionCtx({ answers: ["a", "ghp_x"] });
  await provisionTemplate(ctx, "o/r");
  const scripts = ctx.calls.map((c) => c.join(" "));
  assert.ok(scripts.some((s) => s.includes("mkdir -p /workspace/.forge-cache/npm /workspace/.forge-cache/pnpm")));
  assert.ok(scripts.some((s) => s.includes("npm config set cache /workspace/.forge-cache/npm")));
  assert.ok(scripts.some((s) => s.includes("pnpm config set store-dir /workspace/.forge-cache/pnpm")));
  assert.ok(scripts.some((s) => s.includes(".forge-cache/") && s.includes(".git/info/exclude")));
});

test("provisioning stamps role=template and leaves the container stopped", async () => {
  const ctx = provisionCtx({ answers: ["a", "ghp_x"] });
  const tpl = await provisionTemplate(ctx, "o/r");
  assert.equal(tpl.name, "agent-o-r");
  assert.equal(tpl.role, "template");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((s) => s === "lxc config set agent-o-r user.forge.role template"));
  assert.ok(joined.some((s) => s === "lxc stop agent-o-r"));
  assert.equal(joined.at(-1), "lxc stop agent-o-r", "le stop est la dernière étape");
});

test("provisioning no longer installs claude-code inside the container", async () => {
  const ctx = provisionCtx({ answers: ["a", "ghp_x"] });
  await provisionTemplate(ctx, "o/r");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("@anthropic-ai/claude-code")));
});

test("supervised provisioning never asks for a token", async () => {
  const ctx = provisionCtx({ answers: ["s"] });
  await provisionTemplate(ctx, "o/r");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("gh auth login")));
});
```

Reuse the file's existing `provisionCtx` helper; extend its rule table with
`{ match: "config get agent-o-r user.forge.role", stdout: "template" }` if the
helper asserts on reads.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/provision.test.ts`
Expected: FAIL — `provisionTemplate is not exported`

- [ ] **Step 3: Implement**

In `scripts/lib/commands/provision.ts`:

1. Rename `provisionContainer` to `provisionTemplate` and change its signature
   to `(ctx: Context, ownerRepo: string): Promise<ForgeContainer>`; derive the
   container name inside with `templateContainerName(ownerRepo)`.
2. Replace the token block:

```ts
  if (mode === "autonomous" || mode === "super") {
    let token = readToken(ownerRepo);
    if (!token) {
      ctx.err("");
      ctx.err("==============================================================");
      ctx.err("  GitHub token required (BOT account, fine-grained PAT)");
      ctx.err(`  Scoped to: ${ownerRepo} only`);
      ctx.err("  Permissions: Contents RW, Pull requests RW, Metadata R");
      ctx.err(`  It will be stored on the host at ${credentialPath(ownerRepo)}`);
      ctx.err("  (chmod 600), so this is asked once per repo.");
      ctx.err("==============================================================");
      const typed = await ctx.prompt.askSecret("Paste the token (input hidden)");
      if (!typed) throw new ForgeError("empty token.");
      token = typed;
      writeToken(ownerRepo, token);
    } else {
      ctx.out(`Using the stored token for ${ownerRepo}.`);
    }
    ctx.out("Authenticating gh inside the container...");
    await mustSucceed("gh auth login", ctx.exec(
      ["lxc", "exec", container, "--", "su", "-", "aiuser", "-c", "gh auth login --hostname github.com --with-token"],
      { input: token },
    ));
    const status = await execAsAgent(ctx, container, "gh auth status --hostname github.com");
    if (status.code !== 0) throw new ForgeError("the stored token was rejected by GitHub. Fix it with 'forge token set'.");
    await mustSucceed("gh auth setup-git", execAsAgent(ctx, container, "gh auth setup-git"));
  }
```

3. Delete the `npm install -g @anthropic-ai/claude-code@latest` step entirely
   (Task 6 replaced it with the shim).
4. After the existing "Ignoring worktrees in the main clone..." step, add the
   cache setup:

```ts
  ctx.out("Setting up the shared npm/pnpm caches...");
  // Dans le montage du repo, donc dans le MÊME mount que .trees/ : c'est la
  // seule position où les hardlinks de pnpm ne se heurtent pas à EXDEV
  // (spec §5). Ne pas déplacer vers un device dédié.
  await mustSucceed("create the cache directories", execAsAgent(ctx, container,
    "mkdir -p /workspace/.forge-cache/npm /workspace/.forge-cache/pnpm"));
  await mustSucceed("point npm at the shared cache", execAsAgent(ctx, container,
    "npm config set cache /workspace/.forge-cache/npm"));
  await mustSucceed("point pnpm at the shared store", execAsAgent(ctx, container,
    "pnpm config set store-dir /workspace/.forge-cache/pnpm"));
  await mustSucceed("exclude the cache from the main clone", execAsAgent(ctx, container,
    "cd /workspace && { grep -qxF '.forge-cache/' .git/info/exclude || echo '.forge-cache/' >> .git/info/exclude; }"));
```

5. Stamp the role alongside the existing metadata, and stop at the end:

```ts
  await mustSucceed("record forge role", configSet(ctx, container, "user.forge.role", ROLE_TEMPLATE));
  …
  ctx.out(`Template ${container} provisioned. Stopping it — it is only ever copied, never worked in.`);
  await mustSucceed("lxc stop", stopInstance(ctx, container));
  return { name: container, status: "Stopped", repo: ownerRepo, mode, role: ROLE_TEMPLATE, task: "" };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/provision.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/provision.ts tests/provision.test.ts
git commit -m "feat(provision): provisionner un template stoppé, PAT depuis le store hôte, caches partagés"
```

---

### Task 8: `forge start` — copy the template, stamp the task, add the worktree

**Files:**
- Modify: `scripts/lib/commands/start.ts`
- Test: `tests/start.test.ts`

**Interfaces:**
- Consumes: `provisionTemplate` (Task 7), `copyInstance` (Task 3), `taskContainerName`/`templateForRepo`/`taskContainersForRepo` (Task 2), `attachArgv` (Task 3).
- Produces: `cmdStart(ctx, repo?, task?): Promise<number>` — same signature, new behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
// add to tests/start.test.ts
test("a repo with no template is provisioned, then copied", async () => {
  const ctx = startCtx({ template: null, answers: ["a", "ghp_x"] });
  await cmdStart(ctx, "o/r", "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((s) => s.startsWith("lxc launch")), "provisioning a fresh template");
  assert.ok(joined.some((s) => s === "lxc copy agent-o-r agent-o-r-feat"));
});

test("an existing template is copied, never re-provisioned", async () => {
  const ctx = startCtx({ template: "agent-o-r" });
  await cmdStart(ctx, "o/r", "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(!joined.some((s) => s.startsWith("lxc launch")));
  assert.ok(joined.some((s) => s === "lxc copy agent-o-r agent-o-r-feat"));
});

test("the copy is stamped with role=task and its task name, then started", async () => {
  const ctx = startCtx({ template: "agent-o-r" });
  await cmdStart(ctx, "o/r", "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc config set agent-o-r-feat user.forge.role task"));
  assert.ok(joined.includes("lxc config set agent-o-r-feat user.forge.task feat"));
  assert.ok(joined.includes("lxc start agent-o-r-feat"));
  assert.ok(joined.indexOf("lxc copy agent-o-r agent-o-r-feat") < joined.indexOf("lxc start agent-o-r-feat"));
});

test("an already-running task container is attached, not copied again", async () => {
  const ctx = startCtx({ template: "agent-o-r", tasks: { feat: "Running" } });
  await cmdStart(ctx, "o/r", "feat");
  assert.ok(!ctx.calls.some((c) => c[1] === "copy"));
  assert.ok(ctx.calls.some((c) => c.includes("tmux")));
});

test("a stopped task container is restarted, not copied again", async () => {
  const ctx = startCtx({ template: "agent-o-r", tasks: { feat: "Stopped" } });
  await cmdStart(ctx, "o/r", "feat");
  assert.ok(!ctx.calls.some((c) => c[1] === "copy"));
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r-feat"));
});

test("a behind template warns but does not block", async () => {
  const ctx = startCtx({ template: "agent-o-r", imageCommit: "old", latest: "new" });
  assert.equal(await cmdStart(ctx, "o/r", "feat"), 0);
  assert.match(ctx.err_lines.join("\n"), /behind|forge template rebuild/);
});

test("the worktree is created from the task container, after it starts", async () => {
  const ctx = startCtx({ template: "agent-o-r" });
  await cmdStart(ctx, "o/r", "feat");
  const joined = ctx.calls.map((c) => c.join(" "));
  const start = joined.indexOf("lxc start agent-o-r-feat");
  const worktree = joined.findIndex((s) => s.includes("worktree add .trees/feat"));
  assert.ok(worktree > start, "la worktree se crée depuis le container de la tâche");
  assert.ok(joined.some((s) => s.includes("agent-o-r-feat") && s.includes("fetch origin")));
});

test("an existing worktree is adopted, not recreated", async () => {
  const ctx = startCtx({ template: "agent-o-r", worktreeExists: true });
  await cmdStart(ctx, "o/r", "feat");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("worktree add")));
  assert.match(ctx.out_lines.join("\n"), /already there/);
});
```

Write the `startCtx({ template, tasks, imageCommit, latest, worktreeExists, answers })`
helper at the top of the file, building the rule table in the shape Task 2's
`describeContainers` reads: `lxc list` JSON plus four `config get` rules per
container, plus `{ match: "image get-property", stdout: latest }`, plus
`{ match: "test -e /workspace/.trees/feat", code: worktreeExists ? 0 : 1 }`.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/start.test.ts`
Expected: FAIL — the current implementation provisions per repo and never calls `lxc copy`.

- [ ] **Step 3: Implement**

Rewrite the body of `cmdStart`:

```ts
export async function cmdStart(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await startResolveRepo(ctx, repo);
  validateRepo(ownerRepo);

  let template = await templateForRepo(ctx, ownerRepo);

  let taskName = task ?? "";
  let ref = "";
  if (!taskName) {
    if (!template) {
      const asked = await ctx.prompt.ask("New task name");
      if (!asked) throw new ForgeError(USAGE);
      taskName = asked;
    } else {
      const choice = await pickStartTask(ctx, ownerRepo, template);
      taskName = choice.task;
      ref = choice.ref;
    }
  }
  validateTaskName(taskName);
  if (ref) validateGitRef(ref);

  if (!template) {
    await checkNameCollision(ctx, templateContainerName(ownerRepo), ownerRepo);
    template = await provisionTemplate(ctx, ownerRepo);
  } else {
    await warnIfTemplateBehind(ctx, template);
  }

  const container = await ensureTaskContainer(ctx, ownerRepo, taskName, template);

  await refreshMain(ctx, container, template.mode);
  await addWorktree(ctx, container, taskName, ref);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container, taskName, process.env.TERM ?? "xterm-256color"));
}

// Copie le template si la tâche n'a pas encore de container ; sinon réutilise
// celui qui est là. Le template est stoppé par construction (provision.ts), ce
// qui rend la copie cohérente — c'est la raison d'être du template.
async function ensureTaskContainer(
  ctx: Context, ownerRepo: string, task: string, template: ForgeContainer,
): Promise<string> {
  const existing = await containerForTask(ctx, ownerRepo, task);
  if (existing) {
    if (existing.status !== "Running") {
      ctx.out(`Starting container ${existing.name}...`);
      await mustSucceed("lxc start", startInstance(ctx, existing.name));
    }
    return existing.name;
  }

  const name = taskContainerName(ownerRepo, task);
  await checkNameCollision(ctx, name, ownerRepo);
  ctx.out(`Copying ${template.name} into ${name}...`);
  await mustSucceed("lxc copy", copyInstance(ctx, template.name, name));
  await mustSucceed("record forge role", configSet(ctx, name, "user.forge.role", ROLE_TASK));
  await mustSucceed("record forge task", configSet(ctx, name, "user.forge.task", task));
  ctx.out(`Starting container ${name}...`);
  await mustSucceed("lxc start", startInstance(ctx, name));
  return name;
}

// Non bloquant, comme le flag `behind` de `forge list` : l'outil expose, et
// l'opérateur décide quand reconstruire.
async function warnIfTemplateBehind(ctx: Context, template: ForgeContainer): Promise<void> {
  const stamp = await containerImageCommit(ctx, template.name);
  const latest = await latestImageCommitFor(ctx, template.mode);
  if (buildStatus(stamp, latest) !== "behind") return;
  ctx.err(`WARNING: template ${template.name} is behind ${baseImageFor(template.mode)} (@${stamp} vs @${latest}).`);
  ctx.err(`Refresh it when convenient: forge template rebuild ${template.repo}`);
}
```

Adapt `refreshMain` to take the mode as a parameter instead of re-reading it,
and `pickStartTask` to list `taskContainersForRepo` task names plus the
`agentBranches` it already reads (run those git probes against the template's
name only when the template is Running; otherwise show container tasks and the
"new task" / "other branch…" entries alone).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/start.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/start.ts tests/start.test.ts
git commit -m "feat(start): copier le template en container de tâche"
```

---

### Task 9: The git host, and `forge finish`

`finish` must remove the worktree **before** deleting the container, and must
still work when the task container is stopped or already gone. Both need "some
container of this repo that can run git" — one small unit, tested on its own.

**Files:**
- Create: `scripts/lib/githost.ts`
- Modify: `scripts/lib/commands/finish.ts`
- Test: `tests/githost.test.ts`, `tests/resume-finish.test.ts`

**Interfaces:**
- Produces:
  - `type GitHost = { name: string; release(): Promise<void> }`
  - `acquireGitHost(ctx, ownerRepo, preferred?: string): Promise<GitHost>`
- `release()` stops the container **only if `acquireGitHost` started it**.

- [ ] **Step 1: Write the failing git-host test**

```ts
// tests/githost.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import { acquireGitHost } from "../scripts/lib/githost.ts";

function ctxFor(fleet: { name: string; status: string; role: string; task: string }[]) {
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify(fleet.map((c) => ({ name: c.name, status: c.status }))) },
      ...fleet.flatMap((c) => [
        { match: `config get ${c.name} user.forge.repo`, stdout: "o/r" },
        { match: `config get ${c.name} user.forge.mode`, stdout: "autonomous" },
        { match: `config get ${c.name} user.forge.role`, stdout: c.role },
        { match: `config get ${c.name} user.forge.task`, stdout: c.task },
      ]),
    ],
  });
}

test("a running preferred container is used as-is and released without stopping", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-feat", status: "Running", role: "task", task: "feat" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-feat");
  assert.equal(host.name, "agent-o-r-feat");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("another running task container is preferred over waking the template", async () => {
  const ctx = ctxFor([
    { name: "agent-o-r", status: "Stopped", role: "template", task: "" },
    { name: "agent-o-r-dead", status: "Stopped", role: "task", task: "dead" },
    { name: "agent-o-r-live", status: "Running", role: "task", task: "live" },
  ]);
  const host = await acquireGitHost(ctx, "o/r", "agent-o-r-dead");
  assert.equal(host.name, "agent-o-r-live");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "start"));
});

test("with nothing running, the template is started and stopped again on release", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Stopped", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  assert.equal(host.name, "agent-o-r");
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc start agent-o-r"));
  await host.release();
  assert.ok(ctx.calls.some((c) => c.join(" ") === "lxc stop agent-o-r"));
});

test("a running template is used without being stopped afterwards", async () => {
  const ctx = ctxFor([{ name: "agent-o-r", status: "Running", role: "template", task: "" }]);
  const host = await acquireGitHost(ctx, "o/r");
  await host.release();
  assert.ok(!ctx.calls.some((c) => c[1] === "stop"));
});

test("a repo with no container at all is a ForgeError", async () => {
  await assert.rejects(() => acquireGitHost(ctxFor([]), "o/r"), ForgeError);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test tests/githost.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the module**

```ts
// scripts/lib/githost.ts
// « Quel container peut faire tourner git pour ce repo ? »
//
// Le montage est partagé : il n'y a qu'un .git, visible depuis le template
// comme depuis n'importe quelle tâche. C'est ce qui permet à `finish` de
// retirer la worktree d'une tâche dont le container est éteint — sans quoi
// chaque nettoyage laisserait une entrée .git/worktrees/<task> orpheline.
//
// On préfère toujours un container DÉJÀ démarré : réveiller le template pour
// une commande git est le dernier recours, et on le rendort ensuite.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { describeContainers, ROLE_TASK, ROLE_TEMPLATE } from "./containers.ts";
import { startInstance, stopInstance } from "./lxd.ts";

export type GitHost = { name: string; release(): Promise<void> };

const noop = async (): Promise<void> => {};

export async function acquireGitHost(
  ctx: Context, ownerRepo: string, preferred?: string,
): Promise<GitHost> {
  const mine = (await describeContainers(ctx))
    .filter((c) => c.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (mine.length === 0) throw new ForgeError(`no container for ${ownerRepo} to run git in.`);

  const running = mine.filter((c) => c.status === "Running");
  const pick = running.find((c) => c.name === preferred)
    ?? running.find((c) => c.role === ROLE_TASK)
    ?? running.find((c) => c.role === ROLE_TEMPLATE);
  if (pick) return { name: pick.name, release: noop };

  const template = mine.find((c) => c.role === ROLE_TEMPLATE);
  if (!template) throw new ForgeError(`no running container and no template for ${ownerRepo}.`);

  await mustSucceed("lxc start", startInstance(ctx, template.name));
  return {
    name: template.name,
    release: async () => { await stopInstance(ctx, template.name); },
  };
}
```

- [ ] **Step 4: Run it**

Run: `node --test tests/githost.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing `finish` tests**

Add to `tests/resume-finish.test.ts`:

```ts
test("finish removes the worktree before deleting the container", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running" });
  assert.equal(await cmdFinish(ctx, "o/r", "feat", true), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  const removed = joined.findIndex((s) => s.includes("worktree remove"));
  const deleted = joined.findIndex((s) => s === "lxc delete agent-o-r-feat --force");
  assert.ok(removed >= 0 && deleted >= 0);
  assert.ok(removed < deleted, "sinon .git/worktrees/feat reste orpheline");
});

test("finish on a stopped task container goes through the template", async () => {
  const ctx = finishCtx({ task: "feat", status: "Stopped" });
  await cmdFinish(ctx, "o/r", "feat", true);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.some((s) => s.startsWith("lxc exec agent-o-r ") && s.includes("worktree remove")));
  assert.ok(joined.some((s) => s === "lxc start agent-o-r"));
  assert.ok(joined.some((s) => s === "lxc stop agent-o-r"));
});

test("finish runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running", dirty: true });
  await assert.rejects(() => cmdFinish(ctx, "o/r", "feat", false), /uncommitted changes/);
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});

test("finish retains the branch and says so", async () => {
  const ctx = finishCtx({ task: "feat", status: "Running" });
  await cmdFinish(ctx, "o/r", "feat", true);
  assert.match(ctx.out_lines.join("\n"), /branch agent\/feat retained/);
});

test("finish cleans a worktree whose container is already gone", async () => {
  const ctx = finishCtx({ task: "feat", status: null });   // no task container in the fleet
  assert.equal(await cmdFinish(ctx, "o/r", "feat", true), 0);
  assert.ok(ctx.calls.some((c) => c.join(" ").includes("worktree remove")));
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});
```

- [ ] **Step 6: Run and watch them fail**

Run: `node --test tests/resume-finish.test.ts`
Expected: FAIL — `cmdFinish` still targets a repo container and never deletes.

- [ ] **Step 7: Rewrite `finish`**

```ts
export async function cmdFinish(
  ctx: Context, repo: string | undefined, task: string | undefined, force: boolean,
): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const taskName = await resolveTask(ctx, ownerRepo, task, USAGE);
  validateTaskName(taskName);

  const container = await containerForTask(ctx, ownerRepo, taskName);
  const host = await acquireGitHost(ctx, ownerRepo, container?.name);
  try {
    const dir = worktreeAbsPath(taskName);
    if ((await execAsAgent(ctx, host.name, `test -e ${dir}`)).code !== 0 && !container) {
      throw new ForgeError(`no worktree .trees/${taskName} and no container for task '${taskName}' in ${ownerRepo}.`);
    }

    if (!force) await checkWorktree(ctx, host.name, dir);

    if (container && container.status === "Running") {
      await execAsAgent(ctx, container.name, `tmux kill-session -t ${taskName} 2>/dev/null || true`);
    }

    ctx.out(`Removing worktree .trees/${taskName}...`);
    const flag = force ? "--force " : "";
    await mustSucceed("git worktree remove", execAsAgent(ctx, host.name,
      `git -C /workspace worktree remove ${flag}.trees/${taskName}`));
  } finally {
    await host.release();
  }

  // Après la worktree, jamais avant : supprimer le container d'abord
  // laisserait .git/worktrees/<task> orpheline dans le montage partagé.
  if (container) {
    ctx.out(`Deleting container ${container.name}...`);
    await mustSucceed("lxc delete", deleteInstance(ctx, container.name));
  }

  ctx.out(`Finished task ${taskName} (branch agent/${taskName} retained).`);
  return 0;
}
```

Note `host.release()` runs in `finally` **before** the delete: if the git host
*is* the task container being deleted, `release()` is the no-op branch, so
nothing stops a container that is about to be removed.

- [ ] **Step 8: Run the tests**

Run: `node --test tests/githost.test.ts tests/resume-finish.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/githost.ts scripts/lib/commands/finish.ts tests/githost.test.ts tests/resume-finish.test.ts
git commit -m "feat(finish): retirer la worktree via un git host, puis supprimer le container de la tâche"
```

---

### Task 10: `forge stop` becomes a pause; `forge delete` becomes repo-level

**Files:**
- Modify: `scripts/lib/commands/stop.ts`, `scripts/lib/commands/delete.ts`, `scripts/lib/wip.ts`
- Test: `tests/stop-delete.test.ts`, `tests/wip.test.ts`

**Interfaces:**
- Produces:
  - `cmdStop(ctx, repo?: string, task?: string): Promise<number>` — **the `force` parameter is gone**
  - `cmdDelete(ctx, repo?: string, force: boolean): Promise<number>` — unchanged signature, repo-wide behaviour
  - `checkAllWorktrees(ctx, container, ownerRepo)` in `wip.ts` keeps its name but now takes the git host's container name from the caller (no signature change needed — the caller passes the git host).

- [ ] **Step 1: Write the failing tests**

Replace the WIP-related `stop` tests in `tests/stop-delete.test.ts` with:

```ts
test("stop pauses one task without any WIP pre-flight", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running", other: "Running" } });
  assert.equal(await cmdStop(ctx, "o/r", "feat"), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc stop agent-o-r-feat"));
  assert.ok(!joined.includes("lxc stop agent-o-r-other"), "une pause ne touche pas les voisines");
  assert.ok(!joined.some((s) => s.includes("status --porcelain")), "plus de pré-vol sur stop");
});

test("stop without a task pauses every running container of the repo", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running", other: "Stopped" }, template: "Running" });
  await cmdStop(ctx, "o/r", undefined);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc stop agent-o-r-feat"));
  assert.ok(joined.includes("lxc stop agent-o-r"));
  assert.ok(!joined.includes("lxc stop agent-o-r-other"), "déjà arrêtée");
});

test("stop names the task when it has no container", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running" } });
  await assert.rejects(() => cmdStop(ctx, "o/r", "absent"), /absent/);
});

test("delete removes every task container and the template", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped", other: "Stopped" }, template: "Stopped" });
  assert.equal(await cmdDelete(ctx, "o/r", true), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc delete agent-o-r-feat --force"));
  assert.ok(joined.includes("lxc delete agent-o-r-other --force"));
  assert.ok(joined.includes("lxc delete agent-o-r --force"));
});

test("delete deletes the template last", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped" }, template: "Stopped" });
  await cmdDelete(ctx, "o/r", true);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.indexOf("lxc delete agent-o-r-feat --force") < joined.indexOf("lxc delete agent-o-r --force"));
});

test("delete runs the WIP pre-flight across every worktree unless forced", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running" }, dirty: true });
  await assert.rejects(() => cmdDelete(ctx, "o/r", false), /uncommitted changes/);
  assert.ok(!ctx.calls.some((c) => c[1] === "delete"));
});

test("delete says the host mount survives", async () => {
  const ctx = fleetCtx({ tasks: {}, template: "Stopped" });
  await cmdDelete(ctx, "o/r", true);
  assert.match(ctx.out_lines.join("\n"), /workspace|mount/i);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/stop-delete.test.ts`
Expected: FAIL — `cmdStop` takes `(ctx, repo, force)` and still pre-flights.

- [ ] **Step 3: Rewrite both commands**

```ts
// scripts/lib/commands/stop.ts
// forge stop [<owner/repo>] [<task>]
//
// `stop` n'est plus « couper le repo » mais « mettre cette tâche en pause ».
// Aucun pré-vol WIP : tout ce qu'il pourrait mettre en danger (code, commits,
// WIP, node_modules) vit dans le montage hôte et survit. Ajouter une friction
// ici découragerait précisément le geste qui libère RAM, CPU et Docker.
export async function cmdStop(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  if (task) {
    validateTaskName(task);
    const container = await requireContainerForTask(ctx, ownerRepo, task);
    if (container.status !== "Running") {
      ctx.out(`Task ${task} is already stopped.`);
      return 0;
    }
    ctx.out(`Stopping container ${container.name}...`);
    await mustSucceed("lxc stop", stopInstance(ctx, container.name));
    return 0;
  }

  const running = (await describeContainers(ctx))
    .filter((c) => c.repo.toLowerCase() === ownerRepo.toLowerCase() && c.status === "Running");
  if (running.length === 0) {
    ctx.out(`Nothing running for ${ownerRepo}.`);
    return 0;
  }
  for (const c of running) {
    ctx.out(`Stopping container ${c.name}...`);
    await mustSucceed("lxc stop", stopInstance(ctx, c.name));
  }
  return 0;
}
```

```ts
// scripts/lib/commands/delete.ts
// forge delete [<owner/repo>] [--force]
//
// Niveau repo : toutes les tâches ET le template. Le montage hôte
// (~/workspaces/<container>) survit délibérément — il porte le clone, les
// branches et le WIP, et un re-provisioning l'adopte tel quel.
export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  const mine = (await describeContainers(ctx))
    .filter((c) => c.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (mine.length === 0) throw new ForgeError(`no container for ${ownerRepo}.`);

  if (!force) {
    const host = await acquireGitHost(ctx, ownerRepo);
    try { await checkAllWorktrees(ctx, host.name); } finally { await host.release(); }
  }

  // Les tâches d'abord, le template en dernier : il est le seul git host
  // restant si une étape échoue en route.
  const tasks = mine.filter((c) => c.role === ROLE_TASK);
  const rest = mine.filter((c) => c.role !== ROLE_TASK);
  for (const c of [...tasks, ...rest]) {
    ctx.out(`Deleting container ${c.name}...`);
    await mustSucceed("lxc delete", deleteInstance(ctx, c.name));
  }
  ctx.out(`Deleted every container for ${ownerRepo}. The host workspace mount (clone, branches, WIP) survives.`);
  return 0;
}
```

In `scripts/lib/wip.ts`, update the `checkAllWorktrees` comment to say it is
run against a **git host** container, since the worktrees it walks belong to
the shared mount rather than to that container.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/stop-delete.test.ts tests/wip.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/stop.ts scripts/lib/commands/delete.ts scripts/lib/wip.ts \
        tests/stop-delete.test.ts tests/wip.test.ts
git commit -m "feat(stop,delete): stop devient une pause par tâche, delete agit sur tout le repo"
```

---

### Task 11: `forge resume` and `resolve.ts` over task containers

**Files:**
- Modify: `scripts/lib/commands/resume.ts`, `scripts/lib/commands/resolve.ts`
- Test: `tests/resume-finish.test.ts`, `tests/resolve.test.ts`

**Interfaces:**
- Produces: `resolveTask(ctx, ownerRepo: string, task: string | undefined, usage: string): Promise<string>` — **signature changed**: it now takes the repo, not a container, and lists task **containers** (config reads only, no `lxc exec`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/resolve.test.ts
test("resolveTask lists task containers without any lxc exec", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" }, answers: [2] });
  assert.equal(await resolveTask(ctx, "o/r", undefined, "usage"), "api");
  assert.ok(!ctx.calls.some((c) => c[1] === "exec"), "un menu doit rester instantané");
});

test("resolveTask passes a named task straight through", async () => {
  const ctx = fleetCtx({ tasks: {} });
  assert.equal(await resolveTask(ctx, "o/r", "given", "usage"), "given");
});

test("resolveTask explains when the repo has no task container", async () => {
  const ctx = fleetCtx({ tasks: {}, template: "Stopped" });
  await assert.rejects(() => resolveTask(ctx, "o/r", undefined, "usage"), /no task container/);
});
```

```ts
// tests/resume-finish.test.ts
test("resume starts a stopped task container and attaches to it", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Stopped" } });
  assert.equal(await cmdResume(ctx, "o/r", "feat"), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc start agent-o-r-feat"));
  assert.ok(ctx.calls.some((c) => c.includes("tmux")));
});

test("resume refuses a task with no container, pointing at start", async () => {
  const ctx = fleetCtx({ tasks: { feat: "Running" } });
  await assert.rejects(() => cmdResume(ctx, "o/r", "absent"), /forge start/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/resolve.test.ts tests/resume-finish.test.ts`
Expected: FAIL — `resolveTask` still takes a container name.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/commands/resolve.ts
export async function resolveTask(
  ctx: Context, ownerRepo: string, task: string | undefined, usage: string,
): Promise<string> {
  if (task) return task;

  // Uniquement des lectures de clés de config : un menu sous TAB ou une
  // invite interactive ne doit jamais attendre un `lxc exec`.
  const tasks = (await taskContainersForRepo(ctx, ownerRepo)).map((c) => c.task).filter(Boolean);
  if (tasks.length === 0) {
    throw new ForgeError(`no task container in ${ownerRepo}. Create one with 'forge start ${ownerRepo} <task>'.`);
  }
  const idx = await ctx.prompt.pick("Task", tasks);
  if (idx === null) throw new ForgeError(usage);
  return tasks[idx - 1];
}
```

```ts
// scripts/lib/commands/resume.ts
export async function cmdResume(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const taskName = await resolveTask(ctx, ownerRepo, task, USAGE);
  validateTaskName(taskName);

  const container = await containerForTask(ctx, ownerRepo, taskName);
  if (!container) {
    throw new ForgeError(
      `no container for task '${taskName}' in ${ownerRepo}. Start it with 'forge start ${ownerRepo} ${taskName}'.`,
    );
  }
  if (container.status !== "Running") {
    ctx.out(`Starting container ${container.name}...`);
    await mustSucceed("lxc start", startInstance(ctx, container.name));
  }

  ctx.out(`Attaching to ${container.name} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container.name, taskName, process.env.TERM ?? "xterm-256color"));
}
```

Update `cmdFinish`'s `resolveTask` call from `(ctx, container, task, USAGE)` to
`(ctx, ownerRepo, task, USAGE)`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/resolve.test.ts tests/resume-finish.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/resume.ts scripts/lib/commands/resolve.ts tests/resolve.test.ts tests/resume-finish.test.ts
git commit -m "feat(resume): adresser les containers de tâche, menus sans lxc exec"
```

---

### Task 12: `forge list` grouped by repo

**Files:**
- Modify: `scripts/lib/commands/list.ts`
- Test: `tests/list.test.ts`

**Interfaces:**
- Consumes: `describeContainers`, `isLegacy`, `buildStatus`, `latestImageCommitFor`, `containerImageCommit`, `sessionStates`.
- Produces: `cmdList(ctx): Promise<number>` — unchanged signature.

- [ ] **Step 1: Write the failing tests**

```ts
test("list groups tasks under their repo and shows the template's build state", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" }, template: "Stopped", stamp: "aaa", latest: "aaa" });
  await cmdList(ctx);
  const out = ctx.out_lines.join("\n");
  assert.match(out, /REPO\s+MODE\s+TEMPLATE/);
  assert.match(out, /o\/r\s+autonomous\s+ok/);
  assert.match(out, /^\s+cli\s+Running/m);
  assert.match(out, /^\s+api\s+Stopped/m);
});

test("list flags a template behind the base image", async () => {
  const ctx = fleetCtx({ tasks: {}, template: "Stopped", stamp: "old", latest: "new" });
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /behind/);
});

test("list reports the tmux session state of a running task", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running" }, sessions: "cli 1\n" });
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /cli\s+Running\s+attached/);
});

test("list does not probe sessions in a stopped task container", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Stopped" } });
  await cmdList(ctx);
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("list-sessions")));
});

test("list flags a legacy container with no role", async () => {
  const ctx = legacyCtx();
  await cmdList(ctx);
  assert.match(ctx.out_lines.join("\n"), /old model|recreate/);
});

test("list still issues exactly one lxc list", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" } });
  await cmdList(ctx);
  assert.equal(ctx.calls.filter((c) => c[1] === "list").length, 1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/list.test.ts`
Expected: FAIL — the current output has a `STATE`/`BUILD` header and no grouping.

- [ ] **Step 3: Implement**

```ts
const HEADER = ["REPO", "MODE", "TEMPLATE"];

export async function cmdList(ctx: Context): Promise<number> {
  const latestByMode = new Map<string, string>([
    ["agent-base", await latestImageCommitFor(ctx, "autonomous")],
    ["agent-base-super", await latestImageCommitFor(ctx, "super")],
  ]);

  const all = await describeContainers(ctx);
  const repos: string[] = [];
  for (const c of all) if (c.repo && !repos.includes(c.repo)) repos.push(c.repo);

  const entries: Entry[] = [];
  const legacy: string[] = [];

  for (const repo of repos) {
    const mine = all.filter((c) => c.repo === repo);
    for (const c of mine.filter(isLegacy)) legacy.push(c.name);

    const template = mine.find((c) => c.role === ROLE_TEMPLATE);
    const mode = template?.mode || mine[0]?.mode || "-";
    let build = "missing";
    if (template) {
      const stamp = await containerImageCommit(ctx, template.name);
      const latest = latestByMode.get(baseImageFor(template.mode)) ?? "";
      build = buildLabel(buildStatus(stamp, latest));
    }

    const entry: Entry = { cells: [repo, mode, build], tasks: [] };
    for (const c of mine.filter((x) => x.role === ROLE_TASK)) {
      // Un container arrêté ne peut pas être inspecté.
      let session = "—";
      if (c.status === "Running") {
        const attached = (await sessionStates(ctx, c.name)).get(c.task);
        session = attached === undefined ? "no session" : attached ? "attached" : "detached";
      }
      entry.tasks.push([c.task, c.status, session]);
    }
    entries.push(entry);
  }

  const widths = columnWidths([HEADER, ...entries.map((e) => e.cells)]);
  const taskWidths = columnWidths(entries.flatMap((e) => e.tasks));
  ctx.out(formatRow(HEADER, widths));
  for (const entry of entries) {
    ctx.out(formatRow(entry.cells, widths));
    for (const t of entry.tasks) ctx.out(formatRow(t, taskWidths, "  "));
  }
  for (const name of legacy) {
    ctx.out(`${name}: old model (no user.forge.role) — recreate it: forge delete + forge start`);
  }
  return 0;
}
```

`buildLabel` gains one branch: `"missing"` stays as passed through when there
is no template.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/list.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/list.ts tests/list.test.ts
git commit -m "feat(list): regrouper par repo, état du template, détection des containers hérités"
```

---

### Task 13: `forge template rebuild`

**Files:**
- Create: `scripts/lib/commands/template.ts`
- Test: `tests/template.test.ts`

**Interfaces:**
- Consumes: `templateForRepo`, `taskContainersForRepo` (Task 2), `provisionTemplate` (Task 7), `deleteInstance`.
- Produces: `cmdTemplate(ctx, sub: string | undefined, repo: string | undefined): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/template.test.ts
test("template rebuild deletes the old template and provisions a new one", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: {}, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  assert.equal(await cmdTemplate(ctx, "rebuild", "o/r"), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc delete agent-o-r --force"));
  assert.ok(joined.some((s) => s.startsWith("lxc launch")));
  assert.ok(joined.indexOf("lxc delete agent-o-r --force") < joined.findIndex((s) => s.startsWith("lxc launch")));
});

test("template rebuild never prompts for a token when the store has one", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: {}, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  await cmdTemplate(ctx, "rebuild", "o/r");
  assert.ok(!ctx.err_lines.some((l) => l.includes("Paste the token")));
});

test("template rebuild leaves existing task containers alone", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: { cli: "Running" }, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  await cmdTemplate(ctx, "rebuild", "o/r");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(!joined.includes("lxc delete agent-o-r-cli --force"));
  assert.match(ctx.err_lines.join("\n"), /existing task/i);
});

test("template rebuild on a repo with no template is a ForgeError", async () => {
  const ctx = fleetCtx({ template: null, tasks: {} });
  await assert.rejects(() => cmdTemplate(ctx, "rebuild", "o/r"), /no template/);
});

test("an unknown subcommand yields the usage", async () => {
  await assert.rejects(() => cmdTemplate(fleetCtx({ template: "Stopped", tasks: {} }), "bogus", "o/r"),
    /Usage: forge template/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/template.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the command**

```ts
// scripts/lib/commands/template.ts
// forge template rebuild [<owner/repo>]
//
// Reconstruit le template depuis l'image de base courante. Le PAT vit dans le
// store hôte (credentials.ts), donc rien n'est à recoller : c'est ce qui rend
// cette commande utilisable à chaque fois que `forge list` affiche `behind`.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireTemplateForRepo, taskContainersForRepo } from "../containers.ts";
import { deleteInstance } from "../lxd.ts";
import { readToken } from "../credentials.ts";
import { provisionTemplate } from "./provision.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge template rebuild [<owner/repo>]";

export async function cmdTemplate(ctx: Context, sub: string | undefined, repo?: string): Promise<number> {
  if (sub !== "rebuild") throw new ForgeError(USAGE);
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);

  const template = await requireTemplateForRepo(ctx, ownerRepo);

  // Les tâches en cours ne sont PAS touchées : elles ont déjà leur copie, et
  // les recréer perdrait leur état Docker. Elles rattraperont la nouvelle base
  // à leur prochain `forge finish` + `forge start`.
  const tasks = await taskContainersForRepo(ctx, ownerRepo);
  if (tasks.length > 0) {
    ctx.err(`Note: ${tasks.length} existing task container(s) keep the old base until they are finished and restarted.`);
  }
  if (!readToken(ownerRepo)) {
    ctx.err(`No stored token for ${ownerRepo} — provisioning will ask for one and store it.`);
  }

  ctx.out(`Deleting the old template ${template.name}...`);
  await mustSucceed("lxc delete", deleteInstance(ctx, template.name));

  await provisionTemplate(ctx, ownerRepo);
  ctx.out(`Template for ${ownerRepo} rebuilt.`);
  return 0;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/template.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/template.ts tests/template.test.ts
git commit -m "feat(template): forge template rebuild, sans recoller de PAT"
```

---

### Task 14: Dispatch, completion, and the end-to-end harness

**Files:**
- Modify: `scripts/forge.ts`, `scripts/lib/commands/completion.ts`, `tests/lib/fake-lxc.ts`
- Test: `tests/completion.test.ts`, `tests/e2e.test.ts`

**Interfaces:**
- Consumes: every `cmd*` from Tasks 4, 5, 10–13.
- Produces: the CLI's final argv contract.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/completion.test.ts
test("the emitted bash function offers the new top-level commands", () => {
  const script = completionScript("/abs/forge");
  assert.match(script, /start resume finish stop delete list template token claude image completion/);
  assert.match(script, /template\)/);
  assert.match(script, /token\)/);
  assert.match(script, /claude\)/);
});

test("completion tasks lists task containers without any lxc exec", async () => {
  const ctx = fleetCtx({ tasks: { cli: "Running", api: "Stopped" } });
  await cmdCompletion(ctx, "tasks", "o/r");
  assert.deepEqual(ctx.out_lines, ["cli", "api"]);
  assert.ok(!ctx.calls.some((c) => c[1] === "exec"));
});

test("completion tasks on an unknown repo prints nothing and does not throw", async () => {
  const ctx = fleetCtx({ tasks: {} });
  assert.equal(await cmdCompletion(ctx, "tasks", "nobody/nothing"), 0);
  assert.deepEqual(ctx.out_lines, []);
});
```

```ts
// tests/e2e.test.ts — extend the existing fake-lxc driven cases
test("forge stop <repo> <task> reaches lxc stop on the task container", async () => {
  const { code, stdout } = await runForge(["stop", "moroine/agent-forge", "cli"]);
  assert.equal(code, 0);
  assert.match(stdout, /agent-moroine-agent-forge-cli/);
});

test("forge --help lists the new commands", async () => {
  const { stdout } = await runForge(["--help"]);
  for (const cmd of ["template", "token", "claude"]) assert.match(stdout, new RegExp(cmd));
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/completion.test.ts tests/e2e.test.ts`
Expected: FAIL — unknown commands, and `fake-lxc` answers no role keys.

- [ ] **Step 3: Teach `fake-lxc.ts` the new model**

```ts
const DEFAULT_LIST = [
  { name: "agent-moroine-agent-forge", status: "Stopped" },
  { name: "agent-moroine-agent-forge-cli", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
];

const REPOS: Record<string, string> = {
  "agent-moroine-agent-forge": "moroine/agent-forge",
  "agent-moroine-agent-forge-cli": "moroine/agent-forge",
  "agent-acme-widgets": "acme/widgets",
};
const MODES: Record<string, string> = {
  "agent-moroine-agent-forge": "autonomous",
  "agent-moroine-agent-forge-cli": "autonomous",
  "agent-acme-widgets": "supervised",
};
const ROLES: Record<string, string> = {
  "agent-moroine-agent-forge": "template",
  "agent-moroine-agent-forge-cli": "task",
  "agent-acme-widgets": "template",
};
const TASKS: Record<string, string> = { "agent-moroine-agent-forge-cli": "cli" };
```

and extend the `config get` branch with `user.forge.role` → `ROLES` and
`user.forge.task` → `TASKS`.

- [ ] **Step 4: Wire the dispatcher**

In `scripts/forge.ts`, update `USAGE` to the command table from the spec §2 and
the switch:

```ts
    case "start": return cmdStart(ctx, a, b);
    case "resume": return cmdResume(ctx, a, b);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, b);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "template": return cmdTemplate(ctx, a, b);
    case "token": return cmdToken(ctx, a, b);
    case "claude": return cmdClaude(ctx, a, b);
    case "image": return cmdImage(ctx, a, b);
    case "completion": return cmdCompletion(ctx, a, b);
```

Note `stop` now takes `b` (the task) where it used to take `force`.

- [ ] **Step 5: Update the completion script and `completion tasks`**

In `completionScript`, extend the first `compgen -W` list to
`"start resume finish stop delete list template token claude image completion"`,
add `stop` to the commands whose third word completes a task, and add cases:

```bash
    template)   [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "rebuild" -- "$cur")) ;;
    token)      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "set rm import" -- "$cur")) ;;
    claude)     [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "update list" -- "$cur")) ;;
```

and in `cmdCompletion`, replace the `tasks` branch body with:

```ts
  if (sub === "tasks") {
    if (!repo) throw new ForgeError(USAGE);
    validateRepo(repo);
    // Aucune erreur pour un repo inconnu : la complétion ne doit jamais
    // interrompre une frappe, et aucune tâche est une réponse valide.
    for (const c of await taskContainersForRepo(ctx, repo)) if (c.task) ctx.out(c.task);
    return 0;
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run check`
Expected: PASS everywhere, no type errors. Any remaining reference to the
deleted `requireContainerForRepo` surfaces here — fix it at the call site.

- [ ] **Step 7: Commit**

```bash
git add scripts/forge.ts scripts/lib/commands/completion.ts tests/lib/fake-lxc.ts \
        tests/completion.test.ts tests/e2e.test.ts
git commit -m "feat(cli): brancher template/token/claude, stop par tâche, complétion à jour"
```

---

### Task 15: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `templates/CLAUDE.md`
- Test: `tests/test-readme-docs.sh`, `tests/test-claude-template.sh`

**Interfaces:**
- Consumes: the final command surface from Task 14.

- [ ] **Step 1: Write the failing doc assertions**

In `tests/test-readme-docs.sh`, add:

```bash
assert_contains 'forge template rebuild'
assert_contains 'forge token'
assert_contains 'forge claude update'
assert_contains '.forge-cache'
assert_contains 'user.forge.role'
assert_not_contains 'forge stop <owner/repo> [--force]'
```

In `tests/test-claude-template.sh`, add:

```bash
assert_contains 'ton propre container'
assert_contains '/workspace/.forge-cache'
assert_not_contains 'Plusieurs tâches peuvent tourner en parallèle, chacune dans son worktree'
```

- [ ] **Step 2: Run and watch them fail**

Run: `bash tests/test-readme-docs.sh; bash tests/test-claude-template.sh`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `README.md`**

- Architecture block: show the template + task containers hanging off one host
  mount (copy the §1 diagram from the spec).
- Command reference: replace the table with the §2 surface, including the
  `stop` semantics change ("pause, no WIP pre-flight").
- New subsections: **Host credential store** (`forge token set|rm|import`, the
  `chmod 600` rule, why it is not under `~/workspaces`), **claude-code
  distribution** (`forge claude update|list`, the versioned mount and why
  running sessions are unaffected), **Shared caches** (`.forge-cache/`, the
  `EXDEV` reason it lives inside the repo mount).
- Setup: add `forge claude update` to the first-run steps, right after
  `forge image build`, since no container ships `claude-code` any more.
- Migration: the three-command sequence from spec §8.

- [ ] **Step 4: Update `CLAUDE.md` (project conventions)**

Add, next to the "Mode super" block:

```markdown
### Modèle container par tâche
Depuis `specs/2026-09-20-container-per-task-design.md`, un container = une
tâche. Le montage hôte reste par repo (clone et `.git` partagés) ; chaque
tâche est une copie du container **template** (`user.forge.role=template`),
toujours stoppé. Les caches npm/pnpm vivent dans `/workspace/.forge-cache/` —
dans le montage du repo, seul endroit où les hardlinks pnpm survivent
(`EXDEV`) : ne pas les déplacer vers un device dédié.
```

- [ ] **Step 5: Update `templates/CLAUDE.md` (the agent's own instructions)**

- **Environnement**: the agent now has *its own* container; `/workspace` is
  shared with the repo's other tasks, so other `.trees/*` may be visible —
  stay in yours.
- **Docker**: state that ports no longer collide with other agents, since each
  task has its own network namespace.
- Add a **Caches** line: `npm`/`pnpm` are already pointed at
  `/workspace/.forge-cache/` — do not reconfigure them.
- **Supervised retrieval**: the `git remote add` snippet keeps pointing at the
  repo's host mount (`~/workspaces/agent-<owner>-<repo>`), which is
  **unchanged** — but `<container>` in the instructions is now the task
  container name, so spell the mount path explicitly rather than deriving it
  from `hostname`.

- [ ] **Step 6: Run the doc tests and the whole suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md templates/CLAUDE.md tests/test-readme-docs.sh tests/test-claude-template.sh
git commit -m "docs: modèle container par tâche, store de PAT, montage claude, caches partagés"
```

---

### Task 16: Integration tests — the three assertions that can disprove the design

These need a live LXD and therefore a `super` container (or the host). They are
opt-in and must be skipped cleanly without `FORGE_INTEGRATION=1`.

**Files:**
- Create: `tests/integration/container-per-task.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `createContext()`, `copyInstance`, `addDiskDevice` — the real ones,
  against a real `lxc`.

- [ ] **Step 1: Write the test file**

```ts
// tests/integration/container-per-task.test.ts
// Opt-in : FORGE_INTEGRATION=1 npm run test:integration, dans un container
// super (ou sur l'hôte). Ces trois assertions sont les seules du design qui
// ne peuvent pas être tranchées par un fake — elles portent sur le
// comportement réel de LXD et du noyau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../scripts/lib/context.ts";
import { addDiskDevice, copyInstance } from "../../scripts/lib/lxd.ts";

const RUN = process.env.FORGE_INTEGRATION === "1";
const ctx = createContext();
const PREFIX = `forge-it-${process.pid}`;

async function lxc(...argv: string[]) {
  const r = await ctx.exec(["lxc", ...argv]);
  assert.equal(r.code, 0, `lxc ${argv.join(" ")} failed: ${r.stderr}`);
  return r;
}
const agent = (name: string, script: string) =>
  ctx.exec(["lxc", "exec", name, "--", "su", "-", "aiuser", "-c", script]);

test("the same host directory mounted into two containers stays consistent", { skip: !RUN }, async (t) => {
  const shared = mkdtempSync(join(tmpdir(), "forge-shared-"));
  writeFileSync(join(shared, "from-host"), "host\n");
  const a = `${PREFIX}-a`, b = `${PREFIX}-b`;
  t.after(async () => { await ctx.exec(["lxc", "delete", a, "--force"]); await ctx.exec(["lxc", "delete", b, "--force"]); });

  await lxc("launch", "agent-base", a, "--profile", "agent");
  await lxc("launch", "agent-base", b, "--profile", "agent");
  await addDiskDevice(ctx, a, "workspace", shared, "/workspace");
  await addDiskDevice(ctx, b, "workspace", shared, "/workspace");

  const write = await agent(a, "echo from-a > /workspace/from-a");
  assert.equal(write.code, 0, write.stderr);
  const read = await agent(b, "cat /workspace/from-a");
  assert.equal(read.stdout.trim(), "from-a", "b doit voir ce que a a écrit");

  // Propriété cohérente : même raw.idmap des deux côtés, donc pas de shift.
  const owner = await agent(b, "stat -c %U /workspace/from-a");
  assert.equal(owner.stdout.trim(), "aiuser");
  assert.equal(readFileSync(join(shared, "from-a"), "utf8").trim(), "from-a");
  assert.equal(statSync(join(shared, "from-a")).uid, 1000, "vu comme moroine côté hôte");
});

test("hardlinks work between .forge-cache and a worktree (the §5 assumption)", { skip: !RUN }, async (t) => {
  const shared = mkdtempSync(join(tmpdir(), "forge-hardlink-"));
  const name = `${PREFIX}-hl`;
  t.after(async () => { await ctx.exec(["lxc", "delete", name, "--force"]); });

  await lxc("launch", "agent-base", name, "--profile", "agent");
  await addDiskDevice(ctx, name, "workspace", shared, "/workspace");

  const r = await agent(name,
    "mkdir -p /workspace/.forge-cache/pnpm /workspace/.trees/t/node_modules && " +
    "echo payload > /workspace/.forge-cache/pnpm/blob && " +
    "ln /workspace/.forge-cache/pnpm/blob /workspace/.trees/t/node_modules/blob && " +
    "stat -c %h /workspace/.forge-cache/pnpm/blob");
  assert.equal(r.code, 0, `le hardlink a échoué (EXDEV ?) : ${r.stderr}`);
  assert.equal(r.stdout.trim(), "2", "les deux chemins doivent partager un inode");
});

test("a super container copied from a stopped template starts its nested LXD", { skip: !RUN || !process.env.FORGE_INTEGRATION_SUPER }, async (t) => {
  const tpl = `${PREFIX}-tpl`, copy = `${PREFIX}-copy`;
  t.after(async () => { await ctx.exec(["lxc", "delete", tpl, "--force"]); await ctx.exec(["lxc", "delete", copy, "--force"]); });

  await lxc("launch", "agent-base-super", tpl, "--profile", "agent-super");
  await lxc("exec", tpl, "--", "snap", "wait", "system", "seed.loaded");
  await lxc("exec", tpl, "--", "/snap/bin/lxd", "init", "--minimal");
  await lxc("stop", tpl);                       // la copie DOIT partir d'un template arrêté

  await copyInstance(ctx, tpl, copy);
  await lxc("start", copy);
  const r = await ctx.exec(["lxc", "exec", copy, "--", "/snap/bin/lxc", "list", "-f", "json"]);
  assert.equal(r.code, 0, `le LXD imbriqué de la copie ne répond pas : ${r.stderr}`);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});
```

- [ ] **Step 2: Verify the skip path**

Run: `npm run test:integration`
Expected: PASS with every test reported as skipped (no `FORGE_INTEGRATION`).

- [ ] **Step 3: Run them for real**

Run: `FORGE_INTEGRATION=1 FORGE_INTEGRATION_SUPER=1 npm run test:integration`
Expected: PASS. **If the hardlink test fails with `EXDEV`**, stop: §5 of the
spec is wrong, and the cache placement must be revisited before going further —
report it rather than working around it.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/container-per-task.test.ts
git commit -m "test: intégration — montage partagé, hardlinks du cache, copie d'un template super"
```

---

### Task 17: Full verification and publication

- [ ] **Step 1: Run everything**

Run: `npm test && npm run check`
Expected: PASS, zero type errors.

- [ ] **Step 2: Run the integration layer**

Run: `FORGE_INTEGRATION=1 npm run test:integration`
Expected: PASS (needs a super container; if unavailable, say so explicitly in
the PR body rather than claiming it passed).

- [ ] **Step 3: Read the diff against the spec**

Walk `git diff main...HEAD` and confirm, section by section: the template is
stopped at the end of provisioning; `finish` removes the worktree before the
container; `stop` has no pre-flight; the PAT never appears in an `argv`; the
cache path is `/workspace/.forge-cache`; `pre-bash.sh` is untouched.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin agent/forge-separate-containers
gh pr create --base main \
  --title "feat: un container par tâche (isolation réseau/Docker)" \
  --body "Implémente docs/superpowers/specs/2026-09-20-container-per-task-design.md. …"
```

Never merge the PR.

---

## Self-review

**Spec coverage.** §1 entities → Tasks 2, 7, 8. §2 command surface → Tasks 8–14.
§3 credentials → Task 4 (store) + Task 7 (use). §4 claude-code → Task 5 (host)
+ Task 6 (container). §5 caches → Task 7 (setup) + Task 16 (the EXDEV
assertion). §6 security/profile → Task 6 (device) + Task 15 (docs); the
"non-goal: `/workspace` stays shared" needs no code. §7 super mode → Task 7
(`lxd init` in the template) + Task 16 (copy assertion). §8 migration → Task 4
(`token import`) + Task 15 (documented sequence). Testing section → Tasks 2–16
throughout, integration in Task 16. Documentation section → Task 15.

**Type consistency.** `ForgeContainer` is defined once (Task 2) and consumed
under that exact name by Tasks 7–13. `provisionTemplate` returns it. The
`resolveTask(ctx, ownerRepo, task, usage)` signature change is made in Task 11
and its two callers (`resume`, `finish`) are updated in Tasks 11 and 9
respectively — `finish` is written first, so Task 11's step 3 explicitly
revisits it. `cmdStop` loses its `force` parameter in Task 10 and the
dispatcher follows in Task 14.

**Ordering note for the executor.** Task 2 deletes `requireContainerForRepo`,
so `npm run check` stays red from Task 2 until Task 14 fixes the last call
site. That is deliberate — each task's *own* tests must pass, but the
type-check gate is Task 14's, not every task's.
