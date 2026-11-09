// forge cloud (spec §5.6): the contributor's dev VM and its relay from the
// laptop. `create` installs a cloud host (or resumes its install), `start`
// and `stop` switch the instances on and off, `rebuild` replaces the dev VM
// with a new one, `rebuild-relay` the relay.
import { existsSync } from "node:fs";
import { ForgeError, type Context } from "../context.ts";
import { repoRoot } from "../paths.ts";
import {
  applyInteractive, applyQuiet, currentPublicIp, DEV_INSTANCE, infraFor, loadCloudSettings, RELAY_INSTANCE,
  saveCloudSettings, tofuStatePath,
} from "../laptop/cloud.ts";
import { forgetHostKeys } from "../laptop/lima.ts";
import { remoteExec } from "../laptop/remote.ts";
import { loadHosts, saveHost, type LaptopHost } from "../laptop/state.ts";
import { CLOUD_STEPS, cmdInstall, relayReached } from "./install.ts";
import { cmdOpen } from "./open.ts";

export type CloudOptions = { host?: string; checkout?: string; sleep?: (ms: number) => Promise<void> };

const USAGE = "forge cloud create|start|stop|rebuild|rebuild-relay [--host <name>]";
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

// Start works on a finished install only: before that, the SSH address or
// the OpenTofu state may be missing, and the install resumes first. A host
// installed before the relay existed lacks its step: create --host adds the
// relay.
function installed(host: LaptopHost): LaptopHost {
  if (!CLOUD_STEPS.every((s) => host.done.includes(s))) {
    throw new ForgeError(`${host.name}'s install is not finished: run forge cloud create --host ${host.name} to resume it`);
  }
  return host;
}

// Stop needs only what OpenTofu acts on: its state, there once an apply has
// run, and the SSH address its variables carry. No install step is asked
// for: instances run, and cost money, whatever step an install or an update
// stopped at (the SSH wait of a first create, a rebuild's reinstall, the relay
// step). applyQuiet still refuses any change but starting and stopping.
function stoppable(host: LaptopHost): LaptopHost {
  if (!existsSync(tofuStatePath(host.name)) || !loadCloudSettings(host.name).sshCidr) {
    throw new ForgeError(
      `${host.name} has no OpenTofu state or no SSH address yet, so nothing to stop: ` +
      `run forge cloud create --host ${host.name} to resume its install`,
    );
  }
  return host;
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
    case "start": return start(ctx, installed(await selectCloudHost(ctx, opts.host)), checkout, sleep);
    case "stop": return stop(ctx, stoppable(await selectCloudHost(ctx, opts.host)), checkout);
    case "rebuild": return rebuild(ctx, await selectCloudHost(ctx, opts.host), checkout, sleep);
    case "rebuild-relay": return rebuildRelay(ctx, await selectCloudHost(ctx, opts.host), checkout, sleep);
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
  // The new instance's cloud-init needs its metadata service. So does the
  // relay's until it is reached: a host installed before the relay existed
  // gets its relay from this apply.
  await applyInteractive(ctx, infraFor(host.name, checkout), { dev: true, relay: !(await relayReached(ctx, host)) },
    [`-replace=${DEV_INSTANCE}`]);
  // The Elastic IP stays, the instance gets new host keys: the old entries would refuse them.
  await forgetHostKeys(ctx, [host.name, host.address]);
  host.done = ["inventory"];
  saveHost(host);
  return cmdInstall(ctx, { host: host.name, checkout, sleep });
}

// A new relay (spec §5.6, §5.7), the dev VM left as it is: suspected of
// compromise, or broken. Its credentials go with its disk, so the install
// that follows redoes the playbooks (the dev VM pins the new relay's key)
// and the relay step (a new token, a new push key and signing key to register).
async function rebuildRelay(ctx: Context, host: LaptopHost, checkout: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  const relay = host.relayAddress;
  if (!relay) throw new ForgeError(`${host.name} has no relay yet: forge cloud create --host ${host.name} creates it`);
  const i = await ctx.prompt.pick(
    `Rebuild ${host.name}'s relay from scratch? The bot's token and its two keys go with it: ` +
    "you will paste a new token and register a new push key and a new signing key.",
    ["rebuild it", "stop"],
  );
  if (i !== 1) throw new ForgeError(`${host.name}'s relay is left as it is`);
  // The runbook is printed last after any apply attempt: a failed apply may
  // have destroyed the old relay already, and the install's relay step fails
  // until the new keys are registered.
  try {
    // The new relay's cloud-init needs its metadata service; the dev VM's stays off.
    await applyInteractive(ctx, infraFor(host.name, checkout), { dev: false, relay: true }, [`-replace=${RELAY_INSTANCE}`]);
    // The Elastic IP stays, the instance gets new host keys: the old entry would refuse them.
    await forgetHostKeys(ctx, [relay]);
    host.done = host.done.filter((s) => s !== "playbook" && s !== "relay");
    saveHost(host);
    return await cmdInstall(ctx, { host: host.name, checkout, sleep });
  } finally {
    ctx.out(`Once ${host.name}'s old relay is replaced, its credentials still work on GitHub. On the bot's account:`);
    ctx.out("  1. revoke the old token (Settings > Developer settings > Personal access tokens);");
    ctx.out("  2. remove both old keys, the authentication key and the signing key (Settings > SSH and GPG keys);");
    ctx.out("  3. register the two new keys the relay's setup prints: the push key as an Authentication Key, the other as a Signing Key.");
    ctx.out(`If the relay step did not finish, run forge cloud create --host ${host.name} again.`);
  }
}
