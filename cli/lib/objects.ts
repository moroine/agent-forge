// The Incus objects `forge setup` owns, as pure data: what each one must look
// like given forge's config and the caller's UID/GID (spec "forge setup →
// Objects"). converge.ts compares them with what Incus holds; nothing here
// talks to Incus.
import type { ForgeConfig } from "./config.ts";
import { REJECTED_RANGES } from "./ipv4.ts";

// Shared with sub-project 1: the host firewall matches the bridge by name.
export const BRIDGE = "forgebr0";
export const ACL = "forge-egress";
export const PROFILE = "agent-forge";
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
    config: { "ipv4.address": cfg.network.ipv4Address, "ipv4.nat": "true", "ipv6.address": "none" },
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
