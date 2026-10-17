// The host contract (spec "Host contract"): what the runtime needs from the
// host OS. forge never changes the host: each check only reads, and the first
// failure stops forge with the command that fixes it, for both kinds of host
// (an agent-forge VM provisioned by Ansible, or local Linux mode).
import { readFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { serverInfo, storagePoolExists } from "./incus.ts";
import { REJECTED_RANGES, addressIn, parseAddress } from "./ipv4.ts";
import { BRIDGE } from "./objects.ts";

export type ProcPaths = { restrictUserns: string; usernsClone: string; ipForward: string };

export const PROC: ProcPaths = {
  restrictUserns: "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  usernsClone: "/proc/sys/kernel/unprivileged_userns_clone",
  ipForward: "/proc/sys/net/ipv4/ip_forward",
};

// null when the file does not exist: on a kernel without that knob, the
// restriction it controls does not exist either.
export function readProc(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function sysctlFix(key: string, value: string, file: string): string {
  return [
    "On an agent-forge VM: re-run the host playbook (ansible/site.yml), which sets it.",
    "In local Linux mode:",
    `  sudo sysctl -w ${key}=${value}`,
    `  echo '${key} = ${value}' | sudo tee /etc/sysctl.d/${file}`,
  ].join("\n");
}

// Everything but the storage pool (whose name comes from the config) and IPv4
// forwarding (checked once the bridge exists).
export async function checkHost(ctx: Context, opts: { proc?: ProcPaths; uid?: number } = {}): Promise<void> {
  const proc = opts.proc ?? PROC;
  const uid = opts.uid ?? process.getuid!();
  if (uid === 0) {
    throw new ForgeError(
      "forge must not run as root: raw.idmap maps the calling user to the agent's user. Run it as the forge user.");
  }

  const server = await serverInfo(ctx);
  if (!server.ok) {
    throw new ForgeError(
      `cannot reach Incus (${server.error}). Check that Incus is installed and initialized, and that you are ` +
      "in the incus-admin group (log in again after being added to it).");
  }
  const firewall = server.info.environment?.firewall ?? "unknown";
  if (firewall !== "nftables") {
    throw new ForgeError(
      `Incus uses the "${firewall}" firewall driver, but network ACLs on a bridged NIC need "nftables". ` +
      "Install the nftables package, remove the legacy iptables rules, and restart Incus.");
  }

  const restrict = readProc(proc.restrictUserns);
  if (restrict !== null && restrict !== "0") {
    throw new ForgeError(
      `kernel.apparmor_restrict_unprivileged_userns is ${restrict}: inside containers, the agent's user cannot ` +
      "create user namespaces, which rootless Docker and Chrome's sandbox need.\n" +
      sysctlFix("kernel.apparmor_restrict_unprivileged_userns", "0", "60-agent-forge-userns.conf"));
  }
  const clone = readProc(proc.usernsClone);
  if (clone !== null && clone !== "1") {
    throw new ForgeError(
      `kernel.unprivileged_userns_clone is ${clone}: user namespaces are refused to unprivileged users, root ` +
      "inside unprivileged containers included.\n" +
      sysctlFix("kernel.unprivileged_userns_clone", "1", "60-agent-forge-userns-clone.conf"));
  }
}

export async function checkStoragePool(ctx: Context, pool: string, configFile: string): Promise<void> {
  if (await storagePoolExists(ctx, pool)) return;
  throw new ForgeError(
    `Incus storage pool "${pool}" not found. On an agent-forge VM, re-run the host playbook; in local Linux mode, ` +
    `create it (incus admin init) or set "storagePool" in ${configFile}.`);
}

export function checkIpForward(proc: ProcPaths = PROC): void {
  const value = readProc(proc.ipForward);
  if (value === "1") return;
  throw new ForgeError(
    `net.ipv4.ip_forward is ${value ?? "absent"}: containers on ${BRIDGE} would have no network.\n` +
    sysctlFix("net.ipv4.ip_forward", "1", "60-agent-forge-ip-forward.conf"));
}

// Host IPv4 addresses the ACL does not reject. A container can reach host
// services listening on them unless a host firewall drops bridge traffic: the
// Ansible host's does, a dev machine's usually does not (spike, point 5).
export function exposedHostAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, bridgeCidr: string): string[] {
  const bridge = bridgeCidr.split("/")[0];
  const exposed: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal || info.address === bridge) continue;
      const address = parseAddress(info.address);
      if (address !== null && !REJECTED_RANGES.some((r) => addressIn(address, r))) exposed.push(info.address);
    }
  }
  return exposed;
}
