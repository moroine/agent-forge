// forge setup (spec "forge setup"): converges everything forge owns inside
// Incus. Idempotent: run it once per host, and again after changing the
// config. Every mode runs it (a VM provisioned by Ansible, remote or Lima); a
// bare-metal run outside Ansible warns that no VM protects this machine.
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Context } from "../context.ts";
import { loadConfig } from "../config.ts";
import { converge, ensureProject, type Outcome } from "../converge.ts";
import { loadAllowlist } from "../allowlist.ts";
import { ForgeError } from "../context.ts";
import { ensureHerdrConfig } from "../herdr-config.ts";
import {
  checkHost, checkIpForward, checkStoragePool, detectVirt, exposedHostAddresses, gateOverrideWarning,
  runsOnBareMetalOutsideAnsible, strictGateOverridden, strictModeSupported, type ProcPaths,
} from "../host.ts";
import { forgeProject, listInstances, serverInfo } from "../incus.ts";
import { proxyPlan } from "../ipv4.ts";
import {
  ACL, BRIDGE, PROFILE, PROXY_PROFILE, desiredAcl, desiredBridge, desiredProfile, desiredProject,
  desiredProxyAcl, desiredProxyProfile, desiredStrictAcl, effectiveEgress, egressNames, proxyInstance, rawLxcAllowed,
} from "../objects.ts";
import { allowlistPath, configPath, repoRoot } from "../paths.ts";
import { convergeProxy } from "../proxy.ts";

export type SetupOptions = {
  proc?: ProcPaths;
  ids?: { uid: number; gid: number };
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  // Retry budget for the proxy's first apt-get update (tests set aptDelayMs: 0),
  // and the pause between probes of squid's port after a reload.
  aptAttempts?: number;
  aptDelayMs?: number;
  waitDelayMs?: number;
  virt?: () => string | null;
  releaseRoot?: string;
};

export async function cmdSetup(ctx: Context, opts: SetupOptions = {}): Promise<number> {
  const ids = opts.ids ?? { uid: process.getuid!(), gid: process.getgid!() };
  const project = forgeProject();
  const report = (kind: string, name: string, outcome: Outcome) => ctx.out(`${kind} ${name}: ${outcome}`);

  // 0. No VM between the containers and this machine (spec sub-project 5,
  // "forge setup on bare metal"): only the Lima VM is documented locally. Said
  // first, before the host contract asks for changes that weaken the machine.
  if (runsOnBareMetalOutsideAnsible(opts.releaseRoot ?? repoRoot(), (opts.virt ?? detectVirt)())) {
    ctx.err("WARNING: forge runs directly on this machine, not in a VM: an agent that escapes its container " +
      "lands here, with this machine's keys and sessions. The supported local mode is a Lima VM (see the README).");
  }

  // 1-2. The host contract, then the config. The pool comes from the config,
  // so it is checked right after it; IPv4 forwarding comes last (step 4).
  await checkHost(ctx, { proc: opts.proc, uid: ids.uid });
  const file = configPath();
  const config = loadConfig(file);
  await checkStoragePool(ctx, config.storagePool, file);

  // 3. The objects, in order: the profile uses the bridge and the ACL.
  const projectState = await ensureProject(ctx, project, desiredProject());
  report("project", project, projectState.outcome);

  const bridge = await converge(ctx, "network", BRIDGE, desiredBridge(config));
  report("network", BRIDGE, bridge.outcome);
  if (bridge.outcome === "updated" && bridge.previous?.config?.["ipv4.address"] !== config.network.ipv4Address) {
    const running = (await listInstances(ctx)).filter((i) => i.status === "Running").map((i) => i.name);
    if (running.length > 0) {
      ctx.err(`WARNING: ${BRIDGE}'s address changed while ${running.join(", ")} run on it: ` +
        "they have no network until restarted (forge stop, then forge start).");
    }
  }

  report("network acl", ACL, (await converge(ctx, "network acl", ACL, desiredAcl())).outcome);

  const rawLxc = rawLxcAllowed(projectState.config);
  if (!rawLxc) {
    ctx.err(`NOTICE: project ${project} is restricted without restricted.containers.lowlevel=allow, so the ` +
      "profile goes without raw.lxc and v1's capability drops are lost there (defense in depth only: the " +
      "agent's user holds no capabilities).");
  }
  report("profile", PROFILE, (await converge(ctx, "profile", PROFILE, desiredProfile(config, ids, { rawLxc }))).outcome);

  // 4. IPv4 forwarding, now that the bridge exists.
  checkIpForward(opts.proc);

  // 4b. Strict mode: the two ACLs, the proxy profile, the allowlist and the
  // proxy itself. Older Incus releases can leave a NIC unfiltered when a filter
  // update fails, so they get the open mode only.
  const server = await serverInfo(ctx);
  const version = server.ok ? server.info.environment?.server_version ?? "unknown" : "unknown";
  const lifted = !strictModeSupported(version) && strictGateOverridden();
  if (lifted) ctx.err(gateOverrideWarning(version));
  if (!strictModeSupported(version) && !lifted) {
    ctx.err(`NOTICE: Incus ${version} is too old for strict mode (needs 7.0.2 or later on the 7.0 LTS line, or ` +
      "7.5.0 or later): the strict egress objects and forge-proxy are not created. Open mode is unaffected.");
  } else {
    const names = egressNames(project);
    const plan = proxyPlan(config.network.ipv4Address, names.slot);
    report("network acl", names.proxyAcl, (await converge(ctx, "network acl", names.proxyAcl, desiredProxyAcl(plan))).outcome);
    report("network acl", names.strictAcl, (await converge(ctx, "network acl", names.strictAcl, desiredStrictAcl(plan))).outcome);
    const proxyProfile = desiredProxyProfile(config, names, { rawLxc });
    report("profile", PROXY_PROFILE, (await converge(ctx, "profile", PROXY_PROFILE, proxyProfile)).outcome);

    // The allowlist is validated before anything touches the proxy.
    const { entries, created } = loadAllowlist(allowlistPath());
    if (created) ctx.out(`allowlist: created (default list, ${entries.length} entries)`);
    else if (entries.length === 0) ctx.out("allowlist: empty (strict containers reach nothing)");
    else ctx.out(`allowlist: ${entries.length} entries`);

    // Another container sitting on the proxy's fixed address would shadow it.
    const instances = await listInstances(ctx);
    const holder = instances.find((i) => i.name !== proxyInstance() && i.ipv4.includes(plan.proxyAddress));
    if (holder) {
      throw new ForgeError(`${holder.name} holds ${plan.proxyAddress}, the address reserved for ${proxyInstance()}. ` +
        `Stop it, then restart it (forge stop, forge start) so it takes a DHCP address, and run forge setup again.`);
    }

    const nic = { ...proxyProfile.devices.eth0, "ipv4.address": plan.proxyAddress };
    const proxy = await convergeProxy(ctx, { plan, entries, nic },
      { aptAttempts: opts.aptAttempts, aptDelayMs: opts.aptDelayMs, waitDelayMs: opts.waitDelayMs });
    report("instance", proxyInstance(), proxy.outcome);

    if (proxy.previousAddress !== null) {
      const strict = instances
        .filter((i) => i.name !== proxyInstance() && effectiveEgress(i.expandedDevices, names) === "strict")
        .map((i) => i.name);
      if (strict.length > 0) {
        ctx.err(`NOTICE: ${proxyInstance()} moved from ${proxy.previousAddress} to ${plan.proxyAddress}: ` +
          `${strict.join(", ")} still point at the old address and pick up the new one at their next start ` +
          "(forge stop, then forge start).");
      }
    }
  }

  // 5. Host addresses the ACL does not cover (spike, point 5).
  for (const address of exposedHostAddresses((opts.interfaces ?? networkInterfaces)(), config.network.ipv4Address)) {
    ctx.err(`WARNING: host address ${address} is outside the ranges ${ACL} rejects: containers can reach host ` +
      `services listening on it, unless a host firewall drops traffic from ${BRIDGE}.`);
  }

  // Last: forge's herdr bindings.
  await ensureHerdrConfig(ctx);
  return 0;
}
