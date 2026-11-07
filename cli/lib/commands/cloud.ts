// forge cloud (spec §5.6): the contributor's dev VM from the laptop. `create`
// installs a cloud host (or resumes its install), `start` and `stop` switch
// the instance on and off, `rebuild` replaces the instance with a new one.
import { ForgeError, type Context } from "../context.ts";
import { repoRoot } from "../paths.ts";
import {
  applyInteractive, applyQuiet, currentPublicIp, DEV_INSTANCE, infraFor, loadCloudSettings, saveCloudSettings,
} from "../laptop/cloud.ts";
import { forgetHostKeys } from "../laptop/lima.ts";
import { remoteExec } from "../laptop/remote.ts";
import { loadHosts, saveHost, type LaptopHost } from "../laptop/state.ts";
import { cmdInstall } from "./install.ts";
import { cmdOpen } from "./open.ts";

export type CloudOptions = { host?: string; checkout?: string; sleep?: (ms: number) => Promise<void> };

const USAGE = "forge cloud create|start|stop|rebuild [--host <name>]";
// A stopped instance's sshd answers after a minute or two: probed every 5 s, 3 minutes at most.
const SSH_WAIT_MS = 5000;
const SSH_TRIES = 36;

// Like selectHost, among the cloud hosts only: a remote host is never offered.
async function selectCloudHost(ctx: Context, wanted?: string): Promise<LaptopHost> {
  const hosts = loadHosts();
  const clouds = hosts.filter((h) => h.kind === "cloud");
  if (wanted !== undefined) {
    const found = hosts.find((h) => h.name === wanted);
    if (!found) throw new ForgeError(`unknown host ${wanted}: known hosts are ${hosts.map((h) => h.name).join(", ") || "none"}`);
    if (found.kind !== "cloud") throw new ForgeError(`${wanted} is not a cloud host: forge install --host ${wanted} updates it`);
    return found;
  }
  if (clouds.length === 0) throw new ForgeError("no cloud host: run forge cloud create");
  if (clouds.length === 1) return clouds[0];
  const i = await ctx.prompt.pick("Cloud host", clouds.map((h) => h.name));
  if (i === null) throw new ForgeError("several cloud hosts: pass --host <name>");
  return clouds[i - 1];
}

export async function cmdCloud(ctx: Context, sub: string | undefined, opts: CloudOptions = {}): Promise<number> {
  const checkout = opts.checkout ?? repoRoot();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  switch (sub) {
    case "create": {
      // cmdInstall's host wins over `cloud`: a Lima or remote host must not get here.
      if (opts.host !== undefined) await selectCloudHost(ctx, opts.host);
      return cmdInstall(ctx, opts.host !== undefined ? { host: opts.host, checkout, sleep } : { cloud: true, checkout, sleep });
    }
    case "start": return start(ctx, await selectCloudHost(ctx, opts.host), checkout, sleep);
    case "stop": return stop(ctx, await selectCloudHost(ctx, opts.host), checkout);
    case "rebuild": return rebuild(ctx, await selectCloudHost(ctx, opts.host), checkout, sleep);
    default: throw new ForgeError(`usage: ${USAGE}`);
  }
}

async function start(ctx: Context, host: LaptopHost, checkout: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  // SSH is open to this machine's address only, which may have changed since the last start.
  saveCloudSettings(host.name, { ...loadCloudSettings(host.name), sshCidr: `${await currentPublicIp(ctx)}/32` });
  await applyQuiet(ctx, infraFor(host.name, checkout), true);
  for (let i = 0; i < SSH_TRIES; i++) {
    if (i > 0) await sleep(SSH_WAIT_MS);
    if ((await remoteExec(ctx, host, ["true"])).code === 0) return cmdOpen(ctx, { host: host.name });
  }
  throw new ForgeError(
    `${host.name} did not answer on SSH within ${(SSH_TRIES * SSH_WAIT_MS) / 60000} minutes: ` +
    "check the instance in the AWS console, and that this machine's public address has not changed",
  );
}

async function stop(ctx: Context, host: LaptopHost, checkout: string): Promise<number> {
  // The saved address stays: stopping needs no network lookup.
  await applyQuiet(ctx, infraFor(host.name, checkout), false);
  ctx.out(`${host.name} is stopped; its disks are kept, so the clone and the branches are still there. forge cloud start brings it back.`);
  return 0;
}

async function rebuild(ctx: Context, host: LaptopHost, checkout: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  const i = await ctx.prompt.pick(
    `Rebuild ${host.name} from scratch? Its disk goes, with the clone and every branch not yet published.`,
    ["rebuild it", "stop"],
  );
  if (i !== 1) throw new ForgeError(`${host.name} is left as it is`);
  await applyInteractive(ctx, infraFor(host.name, checkout), [`-replace=${DEV_INSTANCE}`]);
  // The Elastic IP stays, the instance gets new host keys: the old entries would refuse them.
  await forgetHostKeys(ctx, [host.name, host.address]);
  host.done = ["inventory"];
  saveHost(host);
  return cmdInstall(ctx, { host: host.name, checkout, sleep });
}
