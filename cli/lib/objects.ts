// The Incus objects `forge setup` owns, as pure data: what each one must look
// like given forge's config and the caller's UID/GID (spec "forge setup →
// Objects"). converge.ts compares them with what Incus holds; nothing here
// talks to Incus.
import type { ForgeConfig } from "./config.ts";
import { DEFAULT_PROJECT } from "./incus.ts";
import { REJECTED_RANGES, dhcpRanges, type ProxyPlan } from "./ipv4.ts";

// Shared with sub-project 1: the host firewall matches the bridge by name.
export const BRIDGE = "forgebr0";
export const ACL = "forge-egress";
export const PROFILE = "agent-forge";
// The strict-mode proxy: its instance, its profile and its listening port.
export const PROXY_INSTANCE = "forge-proxy";
export const PROXY_PROFILE = "forge-proxy";
export const PROXY_PORT = 3128;
// aiuser in the image (role forge_image).
export const AGENT_UID = 1001;

export type Desired = { description: string; config: Record<string, string> };
export type DesiredProfile = Desired & { devices: Record<string, Record<string, string>> };
export type DesiredAcl = Desired & { ingress: Record<string, string>[]; egress: Record<string, string>[] };
export type Ids = { uid: number; gid: number };

// A project with features.networks=true can only hold OVN networks, not a
// bridge: the bridge and the ACL live in `default` (spec "Decisions").
export const PROJECT_FEATURES: Record<string, string> = {
  "features.images": "true",
  "features.profiles": "true",
  "features.storage.volumes": "true",
  "features.networks": "false",
};

// v1's capability drops (former config/lxd-agent-profile.yaml), unchanged. Defense
// in depth only: aiuser holds no capabilities.
export const RAW_LXC = [
  "lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct",
  "lxc.cap.drop = net_broadcast",
  "lxc.cap.drop = mac_override mac_admin",
  "lxc.cap.drop = bpf perfmon",
  "lxc.cap.drop = audit_control audit_read",
  "lxc.cap.drop = wake_alarm block_suspend",
  "lxc.cap.drop = linux_immutable lease ipc_lock ipc_owner",
  "lxc.cap.drop = syslog",
].join("\n") + "\n";

export function desiredProject(): Desired {
  return { description: "agent-forge: agent containers, their profile and image", config: { ...PROJECT_FEATURES } };
}

export function desiredBridge(cfg: ForgeConfig): Desired {
  return {
    description: "agent-forge: bridge of the agent containers (managed by forge setup)",
    config: { "ipv4.address": cfg.network.ipv4Address, "ipv4.nat": "true", "ipv6.address": "none",
      // The block below .10 is reserved for the proxies' fixed addresses.
      "ipv4.dhcp.ranges": dhcpRanges(cfg.network.ipv4Address),
    },
  };
}

export function desiredAcl(): DesiredAcl {
  return {
    description: "agent-forge: no private, link-local, CGNAT or multicast destination (managed by forge setup)",
    config: {},
    ingress: [],
    egress: [{ action: "reject", state: "enabled", destination: REJECTED_RANGES.join(",") }],
  };
}

export function desiredProfile(cfg: ForgeConfig, ids: Ids, opts: { rawLxc: boolean }): DesiredProfile {
  const config: Record<string, string> = {
    "environment.HOME": "/home/aiuser",
    "security.privileged": "false",
    // Rootless Docker needs nesting.
    "security.nesting": "true",
    "security.syscalls.deny_default": "true",
    "limits.memory": cfg.limits.memory,
    "limits.processes": String(cfg.limits.processes),
    // The caller (the forge user) is aiuser inside: workspace files keep
    // belonging to the caller on the host, with no shift and no chown.
    "raw.idmap": `uid ${ids.uid} ${AGENT_UID}\ngid ${ids.gid} ${AGENT_UID}`,
  };
  if (cfg.limits.cpu !== null) config["limits.cpu"] = String(cfg.limits.cpu);
  if (opts.rawLxc) config["raw.lxc"] = RAW_LXC;
  return {
    description: "agent-forge: agent containers (managed by forge setup)",
    config,
    devices: {
      eth0: {
        type: "nic",
        name: "eth0",
        network: BRIDGE,
        // At NIC level, the ACL also covers container → host and container →
        // container traffic (spike, point 5).
        "security.acls": ACL,
        "security.acls.default.egress.action": "allow",
        "security.acls.default.ingress.action": "reject",
      },
      root: { type: "disk", path: "/", pool: cfg.storagePool, size: cfg.limits.rootDisk },
    },
  };
}

// raw.lxc is refused in a restricted project unless its administrator allowed
// low-level container keys (spec "Restricted-project compatibility").
export function rawLxcAllowed(projectConfig: Record<string, string>): boolean {
  return projectConfig.restricted !== "true" || projectConfig["restricted.containers.lowlevel"] === "allow";
}

export type EgressNames = { slot: number; proxyAcl: string; strictAcl: string };

// agent-forge owns slot 0 and the plain ACL names. Any other project (the
// disposable ones of the tests) takes FORGE_PROXY_SLOT (1-7, default 1) and
// suffixed names, so it never collides with the real proxy. FORGE_PROXY_SLOT is
// test-only and deliberately undocumented, like FORGE_INCUS_PROJECT.
export function egressNames(project: string): EgressNames {
  if (project === DEFAULT_PROJECT) return { slot: 0, proxyAcl: "forge-proxy", strictAcl: "forge-egress-strict" };
  const raw = process.env.FORGE_PROXY_SLOT ?? "1";
  const slot = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(slot >= 1 && slot <= 7)) throw new Error(`FORGE_PROXY_SLOT must be an integer from 1 to 7, got "${raw}"`);
  return { slot, proxyAcl: `forge-proxy-${project}`, strictAcl: `forge-egress-strict-${project}` };
}

// forge-proxy: attached to the proxy only. Lets the bridge subnet reach the
// proxy's listening port and nothing else (the default ingress is reject).
export function desiredProxyAcl(plan: ProxyPlan): DesiredAcl {
  return {
    description: "agent-forge: the proxy accepts the bridge subnet on its port only (managed by forge setup)",
    config: {},
    ingress: [{ action: "allow", state: "enabled", protocol: "tcp", source: plan.subnet, destination_port: String(PROXY_PORT) }],
    egress: [],
  };
}

// forge-egress-strict: attached to strict containers, whose default egress is
// reject. Only the proxy and DHCP renewals (to the bridge) get through.
export function desiredStrictAcl(plan: ProxyPlan): DesiredAcl {
  return {
    description: "agent-forge: strict containers reach the proxy and DHCP only (managed by forge setup)",
    config: {},
    ingress: [],
    egress: [
      { action: "allow", state: "enabled", protocol: "tcp", destination: plan.proxyAddress, destination_port: String(PROXY_PORT) },
      { action: "allow", state: "enabled", protocol: "udp", destination: plan.bridgeAddress, destination_port: "67" },
    ],
  };
}

export function desiredProxyProfile(cfg: ForgeConfig, names: EgressNames, opts: { rawLxc: boolean }): DesiredProfile {
  const config: Record<string, string> = {
    "security.privileged": "false",
    "security.nesting": "false",
    "security.syscalls.deny_default": "true",
    "limits.memory": "512MiB",
    "limits.processes": "1000",
    "boot.autostart": "true",
  };
  if (opts.rawLxc) config["raw.lxc"] = RAW_LXC;
  return {
    description: "agent-forge: the egress proxy (managed by forge setup)",
    config,
    devices: {
      // No ipv4.address here: the address is set per instance (slot).
      eth0: {
        type: "nic",
        name: "eth0",
        network: BRIDGE,
        "security.acls": `${ACL},${names.proxyAcl}`,
        "security.acls.default.egress.action": "allow",
        "security.acls.default.ingress.action": "reject",
      },
      root: { type: "disk", path: "/", pool: cfg.storagePool, size: "4GiB" },
    },
  };
}

export type EgressMode = "open" | "strict";

// The mode a container really has, read from its expanded NIC (never a label).
export function effectiveEgress(devices: Record<string, Record<string, string>>, names: EgressNames): EgressMode | "?" {
  const nic = devices.eth0;
  if (nic?.["security.acls"] === names.strictAcl && nic["security.acls.default.egress.action"] === "reject") return "strict";
  if (nic?.["security.acls"] === ACL) return "open";
  return "?";
}
