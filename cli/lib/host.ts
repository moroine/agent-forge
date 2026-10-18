// The host contract (spec "Host contract"): what the runtime needs from the
// host OS. forge never changes the host: each check only reads, and the first
// failure stops forge with the command that fixes it, for both kinds of host
// (an agent-forge VM provisioned by Ansible, or local Linux mode).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { forgeProject, serverInfo, storagePoolExists } from "./incus.ts";
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

// Strict mode needs the Incus releases where a failed NIC filter update can no
// longer leave the NIC unfiltered: 7.0.2+ on the 7.0 LTS line, or 7.5.0+.
export function strictModeSupported(version: string): boolean {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (major > 7) return true;
  if (major < 7) return false;
  return minor >= 5 || (minor === 0 && patch >= 2);
}

// Test-only lift of the version gate, so the integration suite can exercise
// strict mode on an Incus that is not packaged at 7.0.2 yet. It needs both the
// variable and a forge-selftest* project: the agent-forge project (the
// default) keeps the gate whatever the environment says. Deliberately not
// documented for users, like FORGE_INCUS_PROJECT.
export function strictGateOverridden(): boolean {
  return process.env.FORGE_TEST_ALLOW_INCUS_BELOW_GATE === "1" && forgeProject().startsWith("forge-selftest");
}

export function gateOverrideWarning(version: string): string {
  return `WARNING: FORGE_TEST_ALLOW_INCUS_BELOW_GATE lifts the strict-mode Incus version gate (Incus ${version}) ` +
    `for test project ${forgeProject()}: never use it outside the integration tests.`;
}

export async function requireStrictIncus(ctx: Context): Promise<string> {
  const server = await serverInfo(ctx);
  if (!server.ok) {
    throw new ForgeError(
      `cannot reach Incus (${server.error}). Check that Incus is installed and initialized, and that you are ` +
      "in the incus-admin group (log in again after being added to it).");
  }
  const version = server.info.environment?.server_version ?? "unknown";
  if (!strictModeSupported(version) && strictGateOverridden()) {
    ctx.err(gateOverrideWarning(version));
  } else if (!strictModeSupported(version)) {
    throw new ForgeError(
      "strict mode needs Incus 7.0.2 or later on the 7.0 LTS line, or 7.5.0 or later " +
      `(this host runs ${version}): earlier releases can leave a NIC unfiltered when a filter update fails. ` +
      "On an agent-forge VM, re-run the host playbook (ansible/site.yml); in local Linux mode, install Incus " +
      "from Zabbly (lts-7.0 or the feature channel).");
  }
  return version;
}

// Where an Ansible host keeps forge's releases (sub-project 1, role
// forge_users): forge run from anywhere else was not installed by the playbook.
const ANSIBLE_RELEASES = "/opt/agent-forge/releases/";

// True when nothing stands between the containers and this machine: forge was
// not installed by the playbook (a hardened, dedicated host) and the machine
// is not a VM. An unknown virtualization (null) counts as bare metal.
export function runsOnBareMetalOutsideAnsible(releaseRoot: string, virt: string | null): boolean {
  return !releaseRoot.startsWith(ANSIBLE_RELEASES) && (virt === null || virt === "none");
}

// systemd-detect-virt --vm prints the hypervisor, or "none" (exit 1) on bare
// metal; null when it cannot run (not installed).
export function detectVirt(): string | null {
  const r = spawnSync("systemd-detect-virt", ["--vm"], { encoding: "utf8" });
  if (r.error) return null;
  return r.stdout.trim() || null;
}
