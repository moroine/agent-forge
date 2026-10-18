// The forge-owned bare mirror of a container's GitHub repository.
//
// Host-side git must never run inside ~/workspaces/<container>: the agent
// writes that repository (.git/config, hooks), so any git command there would
// run the agent's commands on the host. Instead forge keeps its own bare
// mirror, outside the workspaces directory, and only ever runs git on it.
// The mirror is mounted read-only in the container, which clones from it.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, ExecResult } from "./context.ts";
import { ForgeError } from "./context.ts";
import { deviceNames, execAsAgentArgv } from "./incus.ts";
import { validateRepo } from "./validate.ts";

export const MIRROR_MOUNT = "/forge/origin.git";
export const ORIGIN_DEVICE = "origin";

// Where the repository comes from, and which transports git may use for it.
export type GitRemote = { url(ownerRepo: string): string; protocol: string[] };

// SSH only: every other transport (file, ext, https...) is refused, so a
// hostile URL or redirect cannot reach a local path or run a helper.
export const GITHUB: GitRemote = {
  url: (ownerRepo) => `git@github.com:${ownerRepo}.git`,
  protocol: ["-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always"],
};

// Never let git ask a question on a terminal forge does not control.
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

// Reduces a remote URL to its `owner/repo`, whatever its form:
// git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git
// including through an SSH alias (~/.ssh/config), hence the comparison on the
// path alone and not on the host.
export function remoteRepo(url: string): string {
  const match = url.trim().replace(/\.git$/, "").match(/([^/:]+\/[^/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

// The lowercased owner/repo the mirror was cloned from, or null when there is
// no mirror (no exec at all) or git cannot tell. A probe: never fatal.
export async function mirrorRepo(ctx: Context, mirror: string): Promise<string | null> {
  if (!existsSync(mirror)) return null;
  const r = await ctx.exec(["git", `--git-dir=${mirror}`, "config", "--get", "remote.origin.url"], { env: GIT_ENV });
  if (r.code !== 0) return null;
  return remoteRepo(r.stdout) || null;
}

export async function ensureMirror(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<"created" | "kept"> {
  validateRepo(ownerRepo);
  if (existsSync(mirror)) {
    const other = await mirrorRepo(ctx, mirror);
    if (other !== ownerRepo.toLowerCase()) {
      throw new ForgeError(
        `${mirror} is a mirror of ${other ?? "an unknown repository"}, not ${ownerRepo}: ` +
        "two repos share the container name. Move it aside and run the command again.");
    }
    return "kept";
  }
  mkdirSync(dirname(mirror), { recursive: true });
  const r = await ctx.exec(
    ["git", ...remote.protocol, "clone", "--bare", remote.url(ownerRepo), mirror], { env: GIT_ENV });
  if (r.code !== 0) {
    throw new ForgeError(
      `create mirror failed: ${r.stderr.trim() || `exit code ${r.code}`}\n` +
      "Is your SSH agent forwarded? Attach with ForwardAgent yes and run the command again.");
  }
  return "created";
}

// The URL is on the command line, not read back from the mirror's config, so
// a mirror whose config was altered cannot redirect the fetch. The caller
// decides what a failure means.
export function refreshMirror(
  ctx: Context, mirror: string, ownerRepo: string, remote: GitRemote = GITHUB,
): Promise<ExecResult> {
  validateRepo(ownerRepo);
  return ctx.exec([
    "git", `--git-dir=${mirror}`, ...remote.protocol,
    "fetch", "--prune", "--no-recurse-submodules", remote.url(ownerRepo),
    "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
  ], { env: GIT_ENV });
}

// In the container, as aiuser. LFS smudge is skipped: the mirror holds no
// LFS objects and the container has no network path to fetch them.
export function cloneWorkspace(ctx: Context, container: string): Promise<ExecResult> {
  return execAsAgentArgv(ctx, container,
    ["env", "GIT_LFS_SKIP_SMUDGE=1", "git", "clone", "--no-local", MIRROR_MOUNT, "/workspace"]);
}

// A reused workspace may still point at GitHub (or anywhere): re-aim origin.
export function pointOriginAtMirror(ctx: Context, container: string): Promise<ExecResult> {
  return execAsAgentArgv(ctx, container, ["git", "-C", "/workspace", "remote", "set-url", "origin", MIRROR_MOUNT]);
}

export async function hasOriginDevice(ctx: Context, container: string): Promise<boolean> {
  return (await deviceNames(ctx, container)).includes(ORIGIN_DEVICE);
}
