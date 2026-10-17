// forge image build (spec "Image → forge image build"). forge drives the
// lifecycle (launch, publish, stamp); ansible/image.yml only configures the
// one instance it is given. Ansible's output streams live, as v1's
// forge-image.sh did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { loadConfig } from "../config.ts";
import { BASE_IMAGE } from "../containers.ts";
import { checkHost, checkIpForward, checkStoragePool, type ProcPaths } from "../host.ts";
import {
  deleteInstance, forgeProject, imageExists, imageFingerprint, incus, instanceExists, listObjects, waitReady,
} from "../incus.ts";
import { PROFILE } from "../objects.ts";
import { configPath, repoRoot } from "../paths.ts";

// Not "agent-…": `forge list` never shows it.
export const BUILD_INSTANCE = "forge-image-build";
// No cloud-init: with it, every instance would recreate the ubuntu account and
// its passwordless sudo (spec "Decisions").
export const SOURCE_IMAGE = "images:ubuntu/26.04";
const USAGE = "Usage: forge image build";

export type ImageOptions = { proc?: ProcPaths; root?: string };

export async function cmdImage(
  ctx: Context, sub: string | undefined, extra?: string, opts: ImageOptions = {},
): Promise<number> {
  if (sub !== "build" || extra !== undefined) throw new ForgeError(USAGE);
  const root = opts.root ?? repoRoot();
  const project = forgeProject();

  // 1. Preconditions, and the commit (step 7), before anything is created.
  await checkHost(ctx, { proc: opts.proc });
  const file = configPath();
  await checkStoragePool(ctx, loadConfig(file).storagePool, file);
  checkIpForward(opts.proc);
  const hasProject = (await listObjects(ctx, "project")).some((p) => p.name === project);
  if (!hasProject || !(await listObjects(ctx, "profile")).some((p) => p.name === PROFILE)) {
    throw new ForgeError(`profile ${PROFILE} not found in Incus project ${project}. Run 'forge setup' first.`);
  }
  if ((await ctx.exec(["ansible-playbook", "--version"])).code !== 0) {
    throw new ForgeError(
      "ansible-playbook not found. On an agent-forge VM the host playbook installs it; " +
      "in local Linux mode, install your distribution's ansible package.");
  }
  if ((await ctx.exec(["ansible-doc", "-t", "connection", "community.general.incus"])).code !== 0) {
    throw new ForgeError(
      "Ansible's community.general.incus connection plugin is missing. Ubuntu's ansible package ships it; " +
      "with ansible-core alone, run: ansible-galaxy collection install community.general");
  }
  const commit = await buildCommit(ctx, root);

  // 2. A leftover from a failed build: kept for debugging, removed now.
  if (await instanceExists(ctx, BUILD_INSTANCE)) {
    ctx.out(`Removing ${BUILD_INSTANCE}, left by a failed build...`);
    await mustSucceed(`delete ${BUILD_INSTANCE}`, deleteInstance(ctx, BUILD_INSTANCE));
  }

  // 3-4. The profile brings nesting (rootless Docker starts its daemon during
  // the build), the network and the ACL.
  ctx.out(`Launching ${BUILD_INSTANCE} from ${SOURCE_IMAGE}...`);
  await mustSucceed(`launch ${BUILD_INSTANCE}`,
    ctx.exec(incus("launch", SOURCE_IMAGE, BUILD_INSTANCE, "--profile", PROFILE)));
  await waitReady(ctx, BUILD_INSTANCE);

  // 5. Configure. Nothing is written in the repo directory, which is
  // read-only on an Ansible host.
  const code = await ctx.attach(ansibleArgv(project, root));
  if (code !== 0) {
    throw new ForgeError(
      `ansible-playbook failed (exit code ${code}). ${BUILD_INSTANCE} is left for debugging ` +
      `(incus --project ${project} exec ${BUILD_INSTANCE} -- bash); the next build removes it. ` +
      `${BASE_IMAGE} is unchanged.`);
  }

  // 6. Publish. On Incus 7.0, publish --reuse already removes the image that
  // held the alias; the probe below covers an Incus that keeps it. Either way
  // the previous image goes only once the new one carries the alias and the
  // stamp, so an agent-base exists at every moment.
  const previous = await imageFingerprint(ctx, BASE_IMAGE);
  await mustSucceed(`stop ${BUILD_INSTANCE}`, ctx.exec(incus("stop", BUILD_INSTANCE)));
  await mustSucceed(`publish ${BASE_IMAGE}`,
    ctx.exec(incus("publish", BUILD_INSTANCE, "--alias", BASE_IMAGE, "--reuse")));
  await mustSucceed(`stamp ${BASE_IMAGE}`,
    ctx.exec(incus("image", "set-property", BASE_IMAGE, "user.forge.commit", commit)));
  const current = await imageFingerprint(ctx, BASE_IMAGE);
  if (previous && previous !== current && (await imageExists(ctx, previous))) {
    await mustSucceed(`delete the previous ${BASE_IMAGE}`, ctx.exec(incus("image", "delete", previous)));
  }
  await mustSucceed(`delete ${BUILD_INSTANCE}`, deleteInstance(ctx, BUILD_INSTANCE));
  ctx.out(`Image ${BASE_IMAGE} published (build ${commit}).`);
  return 0;
}

export function ansibleArgv(project: string, root: string): string[] {
  return [
    "ansible-playbook",
    "-i", `${BUILD_INSTANCE},`,
    "-e", "ansible_connection=community.general.incus",
    "-e", `ansible_incus_project=${project}`,
    "-e", "ansible_pipelining=true",
    join(root, "ansible", "image.yml"),
  ];
}

// The commit the image is built from (spec step 7): the release's COMMIT file,
// written by the host playbook's installation (which has no .git), else the
// checkout's HEAD (local mode, development).
export async function buildCommit(ctx: Context, root: string): Promise<string> {
  try {
    const commit = readFileSync(join(root, "COMMIT"), "utf8").trim();
    if (commit) return commit;
  } catch {
    // No COMMIT file: a checkout.
  }
  const r = await ctx.exec(["git", "-C", root, "rev-parse", "HEAD"]);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new ForgeError(
    `cannot tell which commit ${root} is: no COMMIT file, and not a git checkout ` +
    `(${r.stderr.trim() || `exit code ${r.code}`}).`);
}
