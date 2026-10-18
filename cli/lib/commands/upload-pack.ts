// forge upload-pack <container> [<path>]
//
// Invoked by the dev machine's `git fetch` through
// remote.<c>.uploadpack = "forge upload-pack <c>": over SSH, git runs
// `forge upload-pack <c> '<path>'` on the host. forge then execs
// git-upload-pack inside the container as aiuser, so the host never runs git
// in a repository the agent writes. The path git appends is ignored: the
// repository served is always /workspace.
//
// stdout carries the git protocol. This command must never write to it, not
// even a progress line: errors go through forge.ts's catch, on stderr.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { containerRepo, isRunning } from "../containers.ts";
import { startInstance, uploadPackArgv } from "../incus.ts";
import { validateContainerName } from "../validate.ts";

export async function cmdUploadPack(
  ctx: Context,
  container: string | undefined,
  gitProtocol: string | undefined = process.env.GIT_PROTOCOL,
): Promise<number> {
  // The name comes from an SSH client: validated before any call.
  validateContainerName(container ?? "");
  const name = container as string;

  if (!(await containerRepo(ctx, name))) {
    throw new ForgeError(`${name} is not a forge container (no user.forge.repo)`);
  }
  if (!(await isRunning(ctx, name))) {
    await mustSucceed("incus start", startInstance(ctx, name));
  }
  return ctx.attach(uploadPackArgv(name, gitProtocol));
}
