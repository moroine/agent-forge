// forge setup (spec "forge setup"): converges everything forge owns inside
// Incus. Idempotent: run it once per host, and again after changing the
// config. Every mode runs it (a VM provisioned by Ansible, remote or Lima); a
// bare-metal run outside Ansible warns that no VM protects this machine.
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Context } from "../context.ts";
import { loadConfig } from "../config.ts";
import { converge, ensureProject, type Outcome } from "../converge.ts";
import {
  checkHost, checkIpForward, checkStoragePool, detectVirt, exposedHostAddresses, runsOnBareMetalOutsideAnsible,
  type ProcPaths,
} from "../host.ts";
import { forgeProject, listInstances } from "../incus.ts";
import {
  ACL, BRIDGE, PROFILE, desiredAcl, desiredBridge, desiredProfile, desiredProject, rawLxcAllowed,
} from "../objects.ts";
import { configPath, repoRoot } from "../paths.ts";

export type SetupOptions = {
  proc?: ProcPaths;
  ids?: { uid: number; gid: number };
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
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

  // 5. Host addresses the ACL does not cover (spike, point 5).
  for (const address of exposedHostAddresses((opts.interfaces ?? networkInterfaces)(), config.network.ipv4Address)) {
    ctx.err(`WARNING: host address ${address} is outside the ranges ${ACL} rejects: containers can reach host ` +
      `services listening on it, unless a host firewall drops traffic from ${BRIDGE}.`);
  }
  return 0;
}
