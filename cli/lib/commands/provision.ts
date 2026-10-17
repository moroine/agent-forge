// Provisioning d'un container neuf (spec v2, « Provisioning »). C'est la
// seule commande qui modifie l'hôte : elle crée ~/workspaces/<container> et y
// clone par SSH, avec l'agent de l'humain. Un seul mode : supervised — aucun
// credential GitHub, aucune clé de signature, aucun compte bot dans le
// container. Les chemins hôte restent surchargeables par variable
// d'environnement (paths.ts) pour que les tests ne touchent jamais un vrai home.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { BASE_IMAGE, latestImageCommit } from "../containers.ts";
import {
  configSet, execAsAgent, execAsAgentArgv, forgeProject, imageExists, incus, listObjects, waitReady,
} from "../incus.ts";
import { PROFILE } from "../objects.ts";
import { forgeHome, repoRoot, workspacesDir } from "../paths.ts";

// Le concept de mode reste (pre-bash.sh, CLAUDE.md, user.forge.mode) : le mode
// autonome pourra revenir sans restructurer. v2 n'en provisionne qu'un.
const MODE = "supervised";

export async function provisionContainer(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  // Préconditions, toutes vérifiées avant de rien créer.
  const credentials = join(forgeHome(), ".claude", ".credentials.json");
  if (!existsSync(credentials)) {
    throw new ForgeError(`${credentials} not found. Run 'claude auth login' on the host first.`);
  }
  const identity = await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  const workspaceDir = join(workspacesDir(), container);
  const reuseWorkspace = await workspaceIsReusable(ctx, workspaceDir, ownerRepo);

  ctx.out(`Creating container ${container}...`);
  await mustSucceed("incus launch", ctx.exec(incus("launch", BASE_IMAGE, container, "--profile", PROFILE)));
  await waitReady(ctx, container);

  // Le clone vit sur l'hôte : le container n'a jamais de credential GitHub.
  const remote = `git@github.com:${ownerRepo}.git`;
  mkdirSync(workspaceDir, { recursive: true });
  if (reuseWorkspace) {
    // Le clone survivant a pu être fait par un container v1 autonome (origin
    // en HTTPS) : on le réaligne sur l'URL SSH du clone hôte.
    ctx.out(`Reusing the existing clone in ${workspaceDir}...`);
    await mustSucceed("realign origin remote", ctx.exec(["git", "-C", workspaceDir, "remote", "set-url", "origin", remote]));
  } else {
    ctx.out(`Cloning ${ownerRepo} on the host...`);
    await mustSucceed("clone repository", ctx.exec(["git", "clone", remote, workspaceDir]));
  }
  ctx.out("Mounting workspace...");
  // raw.idmap (profil agent-forge) mappe l'utilisateur hôte sur aiuser : pas
  // de shift sur ce device — un projet restreint l'interdirait de toute façon.
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", container, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));

  // L'agent commite sous l'identité de l'humain, sans signature : l'humain
  // re-signe en publiant. Le trailer Co-Authored-By de Claude Code marque
  // toujours les commits de l'agent.
  ctx.out("Configuring git (your identity, unsigned commits)...");
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email], ["commit.gpgsign", "false"]]) {
    await mustSucceed(`git config ${key}`, execAsAgentArgv(ctx, container, ["git", "config", "--global", key, value]));
  }

  ctx.out("Reusing Claude Code credentials from host...");
  await mustSucceed("create .claude directory", execAsAgent(ctx, container, "mkdir -p /home/aiuser/.claude"));
  await pushFile(ctx, "push Claude credentials", credentials, container, "/home/aiuser/.claude/.credentials.json", 1001, "600");

  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    container, "/home/aiuser/.claude.json", 1001, "600");

  ctx.out("Installing Claude global instructions...");
  await pushFile(ctx, "push CLAUDE.md", join(repoRoot(), "container", "CLAUDE.md"),
    container, "/home/aiuser/.claude/CLAUDE.md", 1001, "644");

  // URL HTTPS explicite, pas la forme owner/repo : claude résoudrait cette
  // dernière en git@github.com, et le container n'a — délibérément — aucune
  // confiance SSH envers GitHub.
  ctx.out("Installing Claude plugins...");
  await mustSucceed("install Claude plugins", execAsAgent(ctx, container,
    "claude plugin marketplace add https://github.com/anthropics/claude-plugins-official.git && claude plugin install superpowers@claude-plugins-official"));

  // Le hook et les réglages appartiennent à root : l'agent ne peut pas les
  // réécrire en place.
  ctx.out("Installing Claude security hooks...");
  await mustSucceed("create hooks directory",
    ctx.exec(incus("exec", container, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks")));
  await pushFile(ctx, "push pre-bash.sh", join(repoRoot(), "container", "pre-bash.sh"),
    container, "/home/aiuser/.claude/hooks/pre-bash.sh", 0, "755");
  await pushFile(ctx, "push Claude settings", join(repoRoot(), "container", "settings.json"),
    container, "/home/aiuser/.claude/settings.json", 0, "644");
  await requireHookBlocks(ctx, container);

  await refreshClaude(ctx, container);

  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, container, `echo '${MODE}' > /home/aiuser/.claude/forge-mode`));
  await mustSucceed("record forge mode", configSet(ctx, container, "user.forge.mode", MODE));

  // Les trois étapes ci-dessous n'ont ni la même cible ni la même fiabilité :
  // elles restent séparées (v1).
  ctx.out("Installing git-lfs filters...");
  // `--skip-repo` : les filtres clean/smudge/process, dans la config globale,
  // sans toucher aux hooks du dépôt. Déterministe, donc fatal s'il échoue.
  await mustSucceed(`git-lfs filters in ${container}`,
    execAsAgent(ctx, container, "git lfs install --skip-repo"));

  ctx.out("Ignoring worktrees in the main clone...");
  // Première commande du container à toucher /workspace : un montage
  // illisible se manifeste ici, avec un message lisible.
  await mustSucceed(`worktree exclude in ${container}`, execAsAgent(ctx, container,
    "cd /workspace && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }"));

  ctx.out("Installing git-lfs hooks in /workspace...");
  // Best-effort : `git lfs install` refuse d'écraser un pre-push qu'il ne
  // reconnaît pas (husky, lefthook, hooks d'un autre git-lfs). Les filtres
  // sont là, seul le hook d'upload manque.
  const hooks = await execAsAgent(ctx, container, "cd /workspace && git lfs install");
  if (hooks.code !== 0) {
    ctx.err(`WARNING: installing git-lfs hooks in /workspace failed: ${hooks.stderr.trim() || `exit code ${hooks.code}`}`);
    ctx.err("The LFS filters are installed, so LFS files still check out and commit normally; only the pre-push");
    ctx.err("upload hook is missing. Expected when the project manages its own hooks (husky, lefthook) or when");
    ctx.err("they were written by another git-lfs version. If a task touches LFS-tracked files, run");
    ctx.err("'git lfs update --manual' in /workspace to merge the hooks by hand.");
  }

  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit",
    configSet(ctx, container, "user.forge.image_commit", await latestImageCommit(ctx)));

  // En dernier : c'est cette clé qui fait reconnaître le container par
  // checkNameCollision.
  ctx.out("Recording forge metadata...");
  await mustSucceed("record forge repo", configSet(ctx, container, "user.forge.repo", ownerRepo));

  // L'hôte de forge n'est connu que de l'humain ; le sous-projet 5 affine.
  ctx.err("");
  ctx.err("Retrieve this container's work from your machine with:");
  ctx.err(`  git remote add ${container} ssh://${userInfo().username}@<forge-host>${workspaceDir}`);
  ctx.out(`Container ${container} provisioned.`);
}

// Sondes : un code non nul veut dire « pas réglé ».
async function hostGitIdentity(ctx: Context): Promise<{ name: string; email: string }> {
  const name = (await ctx.exec(["git", "config", "--global", "--includes", "user.name"])).stdout.trim();
  const email = (await ctx.exec(["git", "config", "--global", "--includes", "user.email"])).stdout.trim();
  if (!name || !email) {
    throw new ForgeError(
      "the agent commits under your git identity, which is not set on this host. Run:\n" +
      '  git config --global user.name "Your Name"\n' +
      "  git config --global user.email you@example.com\n" +
      "then run forge start again.");
  }
  return { name, email };
}

// `forge start` vérifie, avant de rien créer, que `forge setup` et
// `forge image build` sont passés.
async function requireRuntime(ctx: Context): Promise<void> {
  if (!(await listObjects(ctx, "profile")).some((p) => p.name === PROFILE)) {
    throw new ForgeError(`profile ${PROFILE} not found in Incus project ${forgeProject()}. Run 'forge setup' first.`);
  }
  if (!(await imageExists(ctx, BASE_IMAGE))) {
    throw new ForgeError(`image ${BASE_IMAGE} not found. Run 'forge image build' first.`);
  }
}

// Preuve que le hook garde vraiment CE container, dans les deux sens. Un hook
// qui ne peut pas lire sa commande (image sans jq, constaté le 2026-10-17)
// laissait tout passer ; devenu fail-closed, il refuse tout — sûr, mais
// l'agent ne peut plus rien lancer. On lui soumet donc, en tant qu'aiuser, une
// commande qu'il doit refuser (exit 2) et une qu'il doit laisser passer
// (exit 0). Les marqueurs forge-hook-probe-* rendent les lignes du journal
// d'audit (/workspace/.claude/bash-audit.log) explicites.
const hookProbe = (command: string) =>
  `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"${command}"}}' | /home/aiuser/.claude/hooks/pre-bash.sh`;

async function requireHookBlocks(ctx: Context, container: string): Promise<void> {
  ctx.out("Checking that the security hook guards the agent...");
  const rebuild = "Rebuild the image ('forge image build'), then delete " +
    `${container} and start the task again.`;
  // Le hook termine ses phrases par un point : on le retire avant d'enchaîner.
  const detail = (r: ExecResult) => {
    const stderr = r.stderr.trim().replace(/\.+$/, "");
    return stderr ? `: ${stderr}` : "";
  };

  const deny = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("sudo true # forge-hook-probe-deny")]);
  if (deny.code !== 2) {
    throw new ForgeError(
      `the container's security hook let a forbidden command through (exit code ${deny.code}, expected 2)${detail(deny)}. ` +
      `The agent would run unguarded, so provisioning stops. ${rebuild}`);
  }
  const allow = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("true # forge-hook-probe-allow")]);
  if (allow.code !== 0) {
    throw new ForgeError(
      `the container's security hook refuses a harmless command (exit code ${allow.code}, expected 0)${detail(allow)}. ` +
      `The agent could not run anything, so provisioning stops. ${rebuild}`);
  }
}

// `incus file push` avec propriétaire et mode. uid 0 : fichier que l'agent ne
// peut pas modifier.
function pushFile(ctx: Context, step: string, source: string, container: string, dest: string, uid: 0 | 1001, mode: string) {
  return mustSucceed(step, ctx.exec(incus("file", "push", source, `${container}${dest}`,
    "--uid", String(uid), "--gid", String(uid), "--mode", mode)));
}

// La version de l'image fonctionne : un échec ici (réseau, dépôt) est un
// avertissement, pas une raison d'abandonner le provisioning.
async function refreshClaude(ctx: Context, container: string): Promise<void> {
  ctx.out("Updating Claude Code...");
  const apt = (...args: string[]) =>
    ctx.exec(incus("exec", container, "--env", "DEBIAN_FRONTEND=noninteractive", "--", "apt-get", ...args));
  let r = await apt("update");
  if (r.code === 0) r = await apt("install", "--only-upgrade", "-y", "claude-code");
  if (r.code !== 0) {
    ctx.err(`WARNING: updating Claude Code failed, the image's version stays: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}

// `forge delete` ne supprime QUE le container : ~/workspaces/<container> est
// monté depuis l'hôte et survit délibérément (delete.ts). On tranche ici,
// avant de rien créer :
//   - clone du même repo  -> on le réutilise (le travail supervised non
//     récupéré est la seule copie qui existe : on n'efface rien) ;
//   - autre chose non vide -> on s'arrête sans y toucher.
async function workspaceIsReusable(ctx: Context, workspaceDir: string, ownerRepo: string): Promise<boolean> {
  if (!existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0) return false;

  // Sonde : un code non nul est une réponse (« pas un dépôt git »), pas une
  // panne — d'où l'absence de mustSucceed.
  const origin = await ctx.exec(["git", "-C", workspaceDir, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || remoteRepo(origin.stdout) !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `${workspaceDir} already exists, is not empty, and is not a clone of ${ownerRepo}. ` +
      "It is the only copy of whatever it contains, so provisioning stops rather than overwrite it: " +
      "move it aside (or remove it) and run the command again.");
  }
  return true;
}

// Réduit une URL de remote à son `owner/repo`, quelle que soit sa forme :
// git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git
// — y compris via un alias SSH (~/.ssh/config), d'où la comparaison sur le
// chemin seul et pas sur l'hôte.
function remoteRepo(url: string): string {
  const match = url.trim().replace(/\.git$/, "").match(/([^/:]+\/[^/]+)$/);
  return match ? match[1].toLowerCase() : "";
}
