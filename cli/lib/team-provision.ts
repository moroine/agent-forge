// Provisioning d'un membre d'équipe (DX 5, §5.2) : le même parcours que
// provisionContainer, sans ce qui est propre à une tâche (ni worktree, ni
// `.trees/`), plus ce qui est propre à un membre : ses capacités (clone et
// miroir `origin` pour `repo`, miroir d'équipe pour `read-team`), ses limites,
// ses marqueurs `user.forge.*` et ses plugins. Le container a son propre hc
// (dans l'image) : forge n'y lance une session qu'à l'assignation d'une tâche.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import {
  BASE_IMAGE, latestImageCommit, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY,
} from "./containers.ts";
import { configSet, configUnset, execAsAgent, execAsAgentArgv, forgeProject, incus, pushText, waitReady } from "./incus.ts";
import {
  cloneWorkspace, ensureMirror, ensureTeamMirror, MIRROR_MOUNT, mirrorRepo, ORIGIN_DEVICE, pointOriginAtMirror,
  requireMirrorOf, TEAM_DEVICE, TEAM_MOUNT, teamMirrorPath,
} from "./mirror.ts";
import {
  hostGitIdentity, LFS_FILTERS_INSTALL, LFS_HOOKS_INSTALL, pushClaudeToken, pushFile, refreshClaude,
  requireClaudeToken, requireHookBlocks, requireRuntime, workspaceIsReusable,
} from "./commands/provision.ts";
import { egressNames, PROFILE } from "./objects.ts";
import { mirrorPath, repoRoot, workspacesDir } from "./paths.ts";
import { applyStrictSettings, requireStrictRuntime, strictLaunchArgs } from "./strict.ts";
import type { Member } from "./team.ts";
import { ensureApiAccess } from "./api/access.ts";

const MODE = "supervised";
// Le seul marché de plugins que forge sait ajouter (comme Superpowers l'était
// avant la partie 1a) ; un plugin `nom@autre` est refusé avant toute création.
const MARKETPLACES: Record<string, string> = {
  "claude-plugins-official": "https://github.com/anthropics/claude-plugins-official.git",
};

// Les deux miroirs d'une équipe se nomment d'après elle : l'origine de son
// dépôt (comme celui d'un container, mais partagé par ses membres) et le miroir
// des branches des développeurs (teamMirrorPath).
export const originMirrorPath = (team: string) => mirrorPath(`team-${team}`);

export { ensureTeamMirror, teamMirrorPath };

export async function provisionMember(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void> {
  const team = m.team === null ? null : cfg.teams[m.team];
  // Préconditions, toutes vérifiées avant de rien créer.
  requireClaudeToken();
  requirePlugins(m);
  const rolePrompt = m.prompt === null ? "" : readPrompt(m);
  const identity = team?.gitIdentity ?? await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  const plan = m.strict ? await requireStrictRuntime(ctx) : null;
  const readTeam = m.capabilities.includes("read-team");
  const workspaceDir = join(workspacesDir(), m.name);

  // Le miroir `origin` de l'équipe : créé (SSH, agent de l'humain) avant le
  // lancement, comme provisionContainer.
  const origin = m.repo !== null && m.team !== null ? originMirrorPath(m.team) : null;
  let reuseWorkspace: boolean;
  if (origin !== null && m.repo !== null) {
    const existing = await mirrorRepo(ctx, origin);
    if (existsSync(origin)) requireMirrorOf(origin, m.repo, existing);
    reuseWorkspace = workspaceIsReusable(workspaceDir, origin, m.repo, existing);
    ctx.out(existsSync(origin) ? `Reusing the team mirror ${origin}...` : `Fetching ${m.repo} into the team mirror...`);
    await ensureMirror(ctx, origin, m.repo);
  } else {
    reuseWorkspace = existsSync(workspaceDir) && readdirSync(workspaceDir).length > 0;
  }
  if (readTeam && m.team !== null) await ensureTeamMirror(ctx, m.team);

  ctx.out(`Creating container ${m.name}...`);
  const keys: string[] = [
    "-c", `${PROVISIONING_KEY}=${m.repo ?? m.name}`,
    "-c", `${PROVISIONING_WORKSPACE_KEY}=${reuseWorkspace ? "kept" : "new"}`,
    "-c", `user.forge.role=${m.role}`,
  ];
  if (m.team !== null) keys.push("-c", `user.forge.team=${m.team}`);
  if (m.repo !== null) keys.push("-c", `user.forge.repo=${m.repo}`);
  if (m.memory !== null) keys.push("-c", `limits.memory=${m.memory}`);
  if (m.cpu !== null) keys.push("-c", `limits.cpu=${m.cpu}`);
  const strictArgs = plan ? strictLaunchArgs(plan, egressNames(forgeProject())) : [];
  await mustSucceed("incus launch", ctx.exec(incus("launch", BASE_IMAGE, m.name, "--profile", PROFILE, ...keys, ...strictArgs)));
  await waitReady(ctx, m.name);
  if (plan) await applyStrictSettings(ctx, m.name, plan);

  mkdirSync(workspaceDir, { recursive: true });
  ctx.out("Mounting the mirrors and the workspace...");
  if (origin !== null) {
    await mustSucceed("mount mirror", ctx.exec(incus("config", "device", "add", m.name, ORIGIN_DEVICE, "disk",
      `source=${origin}`, `path=${MIRROR_MOUNT}`, "readonly=true")));
  }
  if (readTeam && m.team !== null) {
    await mustSucceed("mount team mirror", ctx.exec(incus("config", "device", "add", m.name, TEAM_DEVICE, "disk",
      `source=${teamMirrorPath(m.team)}`, `path=${TEAM_MOUNT}`, "readonly=true")));
  }
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", m.name, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));

  if (origin !== null) {
    if (reuseWorkspace) {
      ctx.out(`Reusing the existing clone in ${workspaceDir}...`);
      await mustSucceed("realign origin remote", pointOriginAtMirror(ctx, m.name));
    } else {
      ctx.out(`Cloning ${m.repo} in the container...`);
      await mustSucceed("clone repository", cloneWorkspace(ctx, m.name));
    }
  }

  if (origin !== null) {
    // Le hook écrit son journal d'audit dans /workspace/.claude : sans cette
    // exclusion, un clone neuf paraîtrait sale à l'assignation d'une tâche.
    await mustSucceed("audit log exclude", execAsAgent(ctx, m.name,
      "cd /workspace && { grep -qxF '/.claude/bash-audit.log' .git/info/exclude || echo '/.claude/bash-audit.log' >> .git/info/exclude; }"));
  }

  ctx.out("Configuring git (the team's identity, unsigned commits)...");
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email], ["commit.gpgsign", "false"]]) {
    await mustSucceed(`git config ${key}`, execAsAgentArgv(ctx, m.name, ["git", "config", "--global", key, value]));
  }
  if (readTeam && origin !== null) {
    // Un clone réutilisé peut déjà avoir le remote : `add` échoue alors, on le réaligne.
    const add = await execAsAgentArgv(ctx, m.name, ["git", "-C", "/workspace", "remote", "add", "team", TEAM_MOUNT]);
    if (add.code !== 0) {
      await mustSucceed("realign team remote",
        execAsAgentArgv(ctx, m.name, ["git", "-C", "/workspace", "remote", "set-url", "team", TEAM_MOUNT]));
    }
  }

  await pushClaudeToken(ctx, m.name);
  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    m.name, "/home/aiuser/.claude.json", 1001, "600");

  ctx.out("Installing Claude team instructions...");
  const instructions = readFileSync(join(repoRoot(), "container", "CLAUDE.md"), "utf8");
  await mustSucceed("push CLAUDE.md", pushText(ctx, m.name, "/home/aiuser/.claude/CLAUDE.md",
    rolePrompt === "" ? instructions : `${instructions}\n${rolePrompt}`, { uid: 1001, gid: 1001, mode: "644" }));
  await pushFile(ctx, "push forge-agent", join(repoRoot(), "container", "forge-agent"),
    m.name, "/usr/local/bin/forge-agent", 0, "755");
  await ensureApiAccess(ctx, m);

  // Le hook et les réglages appartiennent à root : l'agent ne peut pas les
  // réécrire en place.
  ctx.out("Installing Claude security hooks...");
  await mustSucceed("create hooks directory",
    ctx.exec(incus("exec", m.name, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks")));
  await pushFile(ctx, "push pre-bash.sh", join(repoRoot(), "container", "pre-bash.sh"),
    m.name, "/home/aiuser/.claude/hooks/pre-bash.sh", 0, "755");
  await mustSucceed("push Claude settings",
    pushText(ctx, m.name, "/home/aiuser/.claude/settings.json", settingsFor(m), { uid: 0, gid: 0, mode: "644" }));
  await requireHookBlocks(ctx, m.name);

  await refreshClaude(ctx, m.name, m.strict);
  await installPlugins(ctx, m);

  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, m.name, `echo '${MODE}' > /home/aiuser/.claude/forge-mode`));
  await mustSucceed("record forge mode", configSet(ctx, m.name, "user.forge.mode", MODE));

  ctx.out("Installing git-lfs filters...");
  await mustSucceed(`git-lfs filters in ${m.name}`, execAsAgent(ctx, m.name, LFS_FILTERS_INSTALL));
  if (origin !== null) {
    const hooks = await execAsAgent(ctx, m.name, `cd /workspace && ${LFS_HOOKS_INSTALL}`);
    if (hooks.code !== 0) {
      ctx.err(`WARNING: installing git-lfs hooks in /workspace failed: ${hooks.stderr.trim() || `exit code ${hooks.code}`}`);
    }
  }

  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit", configSet(ctx, m.name, "user.forge.image_commit", await latestImageCommit(ctx)));
  ctx.out("Recording forge metadata...");
  await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_KEY));
  await mustSucceed("clear provisioning marker", configUnset(ctx, m.name, PROVISIONING_WORKSPACE_KEY));
  ctx.out(`Container ${m.name} provisioned.`);
}

// container/settings.json, plus `enabledPlugins` quand le rôle a des plugins.
function settingsFor(m: Member): string {
  const base = JSON.parse(readFileSync(join(repoRoot(), "container", "settings.json"), "utf8")) as Record<string, unknown>;
  if (m.plugins.length > 0) base.enabledPlugins = Object.fromEntries(m.plugins.map((p) => [p, true]));
  return `${JSON.stringify(base, null, 2)}\n`;
}

function marketplaceOf(plugin: string): string {
  return plugin.slice(plugin.indexOf("@") + 1);
}

function requirePlugins(m: Member): void {
  for (const plugin of m.plugins) {
    if (!plugin.includes("@") || !(marketplaceOf(plugin) in MARKETPLACES)) {
      throw new ForgeError(
        `${m.name}: plugin ${plugin} is not <name>@<marketplace> with a marketplace forge knows (${Object.keys(MARKETPLACES).join(", ")}).`);
    }
  }
}

function readPrompt(m: Member): string {
  try {
    return readFileSync(m.prompt!, "utf8");
  } catch (e) {
    throw new ForgeError(`${m.name}: cannot read the prompt file ${m.prompt}: ${(e as Error).message}`);
  }
}

// Comme Superpowers l'était avant la partie 1a : en strict, un échec est un
// avertissement (GitHub n'est peut-être pas dans la liste blanche).
async function installPlugins(ctx: Context, m: Member): Promise<void> {
  if (m.plugins.length === 0) return;
  ctx.out("Installing Claude plugins...");
  for (const market of new Set(m.plugins.map(marketplaceOf))) {
    const added = await execAsAgentArgv(ctx, m.name, ["claude", "plugin", "marketplace", "add", MARKETPLACES[market]]);
    if (added.code !== 0) return pluginFailure(ctx, m, added.stderr, added.code);
  }
  for (const plugin of m.plugins) {
    const r = await execAsAgentArgv(ctx, m.name, ["claude", "plugin", "install", plugin]);
    if (r.code !== 0) return pluginFailure(ctx, m, r.stderr, r.code);
  }
}

function pluginFailure(ctx: Context, m: Member, stderr: string, code: number): void {
  const why = stderr.trim() || `exit code ${code}`;
  if (!m.strict) throw new ForgeError(`install Claude plugins in ${m.name} failed: ${why}`);
  ctx.err(`WARNING: installing the plugins of ${m.name} failed (strict mode: ${why}). Allow the GitHub group in the egress allowlist, run forge setup, then install them inside the container.`);
}
