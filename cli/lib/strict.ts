// Strict containers: the proxy settings written inside them, the arguments that
// launch a container strict, and the hooks that re-apply the settings whenever
// one starts. The ACL on the NIC is what enforces; these settings only point
// the tools at the proxy, so a failure to write them is never a way out.
import { ForgeError, mustSucceed, type Context } from "./context.ts";
import { loadConfig } from "./config.ts";
import { requireStrictIncus } from "./host.ts";
import {
  configGet, configSetMany, execArgv, execAsAgent, forgeProject, listInstances, listObjects, pullText, pushText,
  startInstance, type Instance,
} from "./incus.ts";
import { proxyPlan, type ProxyPlan } from "./ipv4.ts";
import {
  PROXY_INSTANCE, PROXY_PORT, effectiveEgress, egressNames, type EgressMode, type EgressNames,
} from "./objects.ts";
import { configPath } from "./paths.ts";

// All three are root's, under /etc. forge writes them as root at every start,
// after the agent has run: never as root through a path the agent owns (its
// home), where a symlink would redirect the write to /etc/passwd or a FIFO
// would hang the read. systemd applies drop-ins in /etc/systemd/user/<unit>.d/
// to that unit of every user manager, aiuser's rootless Docker included.
export const PROXY_FILES = {
  profile: "/etc/profile.d/agent-forge-proxy.sh",
  apt: "/etc/apt/apt.conf.d/90agent-forge-proxy",
  docker: "/etc/systemd/user/docker.service.d/agent-forge-proxy.conf",
} as const;

const EGRESS_KEY = "user.forge.egress";
const REPO_KEY = "user.forge.repo";
const PROXY_RECIPE_KEY = "user.forge.proxy_recipe";
const LOOPBACK = "localhost,127.0.0.1,::1";
const DOCKER_RESTART = "systemctl --user daemon-reload && systemctl --user restart docker";

// The seven variables, in the order of the instance keys.
const VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"] as const;
export const ENV_KEYS: readonly string[] = VARIABLES.map((v) => `environment.${v}`);

export function proxyEnv(plan: ProxyPlan): Record<string, string> {
  const url = `http://${plan.proxyAddress}:${PROXY_PORT}`;
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url,
    NO_PROXY: LOOPBACK, no_proxy: LOOPBACK,
    // Makes Node's built-in fetch and http honor the variables above.
    NODE_USE_ENV_PROXY: "1",
  };
}

const shellQuote = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;

// Login shells (su - aiuser, ssh) read /etc/profile.d.
export function profileScript(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join("");
}

export function aptConf(plan: ProxyPlan): string {
  const url = `http://${plan.proxyAddress}:${PROXY_PORT}`;
  return `Acquire::http::Proxy "${url}";\nAcquire::https::Proxy "${url}";\n`;
}

// The rootless Docker daemon runs as a systemd user unit, which does not see
// the instance environment: it gets the variables through a drop-in
// (PROXY_FILES.docker, system-wide, read by aiuser's user manager).
export function dockerDropIn(env: Record<string, string>): string {
  return `[Service]\n${Object.entries(env).map(([k, v]) => `Environment="${k}=${v}"\n`).join("")}`;
}

export function currentPlan(): ProxyPlan {
  return proxyPlan(loadConfig(configPath()).network.ipv4Address, egressNames(forgeProject()).slot);
}

// Arguments for `incus launch`/`init`: override eth0 three times (ACL, default
// egress and ingress actions), then the environment and the marker.
export function strictLaunchArgs(plan: ProxyPlan, names: EgressNames): string[] {
  const nic = [
    `security.acls=${names.strictAcl}`,
    "security.acls.default.egress.action=reject",
    "security.acls.default.ingress.action=reject",
  ].flatMap((p) => ["-d", `eth0,${p}`]);
  const env = Object.entries(proxyEnv(plan)).flatMap(([k, v]) => ["-c", `environment.${k}=${v}`]);
  return [...nic, ...env, "-c", `${EGRESS_KEY}=strict`];
}

// The strict ACL and a completed forge-proxy must exist; both come from
// `forge setup`.
export async function requireStrictRuntime(ctx: Context): Promise<ProxyPlan> {
  await requireStrictIncus(ctx);
  const names = egressNames(forgeProject());
  if (!(await listObjects(ctx, "network acl")).some((a) => a.name === names.strictAcl)) {
    throw new ForgeError(`the network ACL ${names.strictAcl} does not exist. Run 'forge setup'.`);
  }
  const proxy = (await listInstances(ctx)).find((i) => i.name === PROXY_INSTANCE);
  if (!proxy || !proxy.config[PROXY_RECIPE_KEY]) {
    throw new ForgeError(`${PROXY_INSTANCE} does not exist or is incomplete. Run 'forge setup'.`);
  }
  return currentPlan();
}

async function restartDocker(ctx: Context, container: string): Promise<void> {
  const r = await execAsAgent(ctx, container, DOCKER_RESTART);
  if (r.code !== 0) {
    // The ACL already enforces; only Docker's own proxy settings are late.
    ctx.err(`WARNING: could not restart Docker in ${container}: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}

// Idempotent: writes only what differs, and restarts Docker only when its
// drop-in changed.
export async function applyStrictSettings(ctx: Context, container: string, plan: ProxyPlan): Promise<void> {
  const env = proxyEnv(plan);
  const instance = (await listInstances(ctx)).find((i) => i.name === container);
  const have = instance?.config ?? {};
  const wanted = Object.fromEntries(Object.entries(env).map(([k, v]) => [`environment.${k}`, v]));
  const differing = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => have[k] !== v));
  if (Object.keys(differing).length > 0) {
    await mustSucceed(`setting the proxy environment of ${container}`, configSetMany(ctx, container, differing));
  }
  const files: [string, string][] = [
    [PROXY_FILES.profile, profileScript(env)],
    [PROXY_FILES.apt, aptConf(plan)],
    [PROXY_FILES.docker, dockerDropIn(env)],
  ];
  let dockerChanged = false;
  for (const [path, content] of files) {
    if ((await pullText(ctx, container, path)) === content) continue;
    await mustSucceed(`writing ${path} in ${container}`, pushText(ctx, container, path, content, { uid: 0, gid: 0, mode: "644" }));
    if (path === PROXY_FILES.docker) dockerChanged = true;
  }
  if (dockerChanged) await restartDocker(ctx, container);
}

// Removes only forge's own files, by their fixed paths under /etc (`rm -f`
// removes a link itself, never what it points to). The instance environment
// keys are not touched: an open container never had them, and a former strict
// one keeps them harmlessly until recreated (unsetting an absent key would fail).
export async function clearStrictSettings(ctx: Context, container: string): Promise<void> {
  const hadDockerDropIn = (await execArgv(ctx, container, ["test", "-e", PROXY_FILES.docker])).code === 0;
  await mustSucceed(`removing the proxy settings of ${container}`,
    execArgv(ctx, container, ["rm", "-f", PROXY_FILES.profile, PROXY_FILES.apt, PROXY_FILES.docker]));
  if (hadDockerDropIn) await restartDocker(ctx, container);
}

export async function egressMode(ctx: Context, container: string): Promise<EgressMode | null> {
  const v = await configGet(ctx, container, EGRESS_KEY);
  return v === "strict" || v === "open" ? v : null;
}

// The marker and the effective NIC disagree on strict (a switch interrupted
// before its last step, or eth0 changed by hand): the message naming both
// states and the commands that finish the switch, or null when they agree.
// An open or absent marker on an unrecognized NIC ("?") is not a disagreement.
export function egressMismatch(instance: Instance, names: EgressNames): string | null {
  const marker = instance.config[EGRESS_KEY];
  const effective = effectiveEgress(instance.expandedDevices, names);
  if ((marker === "strict") === (effective === "strict")) return null;
  const repo = instance.config[REPO_KEY] || instance.name;
  const markerText = marker === undefined ? "without user.forge.egress" : `marked user.forge.egress=${marker}`;
  const nicText = effective === "?" ? "neither open nor strict (changed by hand?)" : effective;
  return `${instance.name} is ${markerText} but its eth0 is ${nicText}. ` +
    `Finish the switch on the stopped container: forge egress ${repo} strict (or forge egress ${repo} open).`;
}

// Before any `incus start` (also on a running container): the mode comes from
// the marker, but only when the NIC agrees, or the agent would be told one mode
// and get the other. A strict container needs a running proxy, otherwise it
// simply has no egress.
export async function egressBeforeStart(ctx: Context, container: string): Promise<EgressMode | null> {
  const mode = await egressMode(ctx, container);
  const instances = await listInstances(ctx);
  const instance = instances.find((i) => i.name === container);
  // A failed list (a probe) leaves the NIC unknown: only a strict marker is
  // then refused, the start itself reports the rest.
  if (!instance && mode === "strict") {
    throw new ForgeError(`refusing to start ${container}: it is marked strict, but 'incus list' did not show its eth0.`);
  }
  const mismatch = instance ? egressMismatch(instance, egressNames(forgeProject())) : null;
  if (mismatch !== null) throw new ForgeError(`refusing to start ${container}: ${mismatch}`);
  if (mode !== "strict") return mode;
  await requireStrictIncus(ctx);
  const proxy = instances.find((i) => i.name === PROXY_INSTANCE);
  if (!proxy) {
    ctx.err(`WARNING: ${PROXY_INSTANCE} is missing: ${container} starts without any egress. Run 'forge setup'.`);
  } else if (proxy.status !== "Running") {
    const r = await startInstance(ctx, PROXY_INSTANCE);
    if (r.code !== 0) {
      ctx.err(`WARNING: could not start ${PROXY_INSTANCE} (${r.stderr.trim() || `exit code ${r.code}`}): ` +
        `${container} has no egress until it runs. Run 'forge setup'.`);
    }
  }
  return mode;
}

// After the container runs: strict re-applies the settings, open removes them.
export async function egressAfterStart(ctx: Context, container: string, mode: EgressMode | null): Promise<void> {
  if (mode === "strict") await applyStrictSettings(ctx, container, currentPlan());
  else if (mode === "open") await clearStrictSettings(ctx, container);
}
