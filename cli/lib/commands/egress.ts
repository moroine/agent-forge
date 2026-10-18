// forge egress [<owner/repo>] [strict|open] and forge egress log [<owner/repo>].
//
// Switching only touches Incus configuration of a STOPPED container (conntrack
// keeps connections opened before an ACL change alive). The calls are ordered
// so that an interruption leaves the container stricter, never looser: the ACL
// goes on first when going strict and comes off last when going open. The
// files inside the container follow at the next `forge start`.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { loadAllowlist } from "../allowlist.ts";
import { allowlistPath } from "../paths.ts";
import { requireContainerForRepo } from "../containers.ts";
import {
  configSet, configSetMany, configUnset, deviceOverride, deviceRemove, deviceSet, execArgv, forgeProject,
  listInstances,
} from "../incus.ts";
import { PROXY_INSTANCE, effectiveEgress, egressNames, type EgressMode } from "../objects.ts";
import { SQUID_ACCESS_LOG } from "../proxy.ts";
import { ENV_KEYS, proxyEnv, requireStrictRuntime } from "../strict.ts";
import { columnWidths, formatRow } from "../table.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge egress [<owner/repo>] [strict|open] | forge egress log [<owner/repo>]\n" +
  "Old lines of the log may name the wrong container: addresses are reused.";
const MARKER = "user.forge.egress";

export type LogEntry = { time: string; client: string; result: "allowed" | "denied"; method: string; host: string };

// One line of squid's native access.log:
// time elapsed client action/code size method url ident hierarchy type
export function parseSquidLine(line: string): LogEntry | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 7 || !/^\d+(\.\d+)?$/.test(f[0])) return null;
  const [action, code] = f[3].split("/");
  if (!action || !code) return null;
  const [client, method, target] = [f[2], f[5], f[6]];
  let host = target;
  if (method !== "CONNECT") {
    try {
      host = new URL(target).host;
    } catch {
      // Not a URL: keep the field as is.
    }
  }
  return {
    time: new Date(Number(f[0]) * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    client,
    result: action.startsWith("TCP_DENIED") || code === "403" ? "denied" : "allowed",
    method,
    host,
  };
}

async function cmdLog(ctx: Context, repo: string | undefined): Promise<number> {
  let only: string | null = null;
  if (repo) {
    validateRepo(repo);
    only = await requireContainerForRepo(ctx, repo);
  }
  const r = await execArgv(ctx, PROXY_INSTANCE, ["tail", "-n", "200", SQUID_ACCESS_LOG]);
  if (r.code !== 0) {
    throw new ForgeError(`${PROXY_INSTANCE} is not reachable; run 'forge setup' (${r.stderr.trim() || `exit code ${r.code}`})`);
  }
  // The current holder of each address; an address nobody holds is shown as is.
  const holders = new Map<string, string>();
  for (const i of await listInstances(ctx)) for (const a of i.ipv4) holders.set(a, i.name);

  const rows: string[][] = [];
  for (const line of r.stdout.split("\n")) {
    const e = parseSquidLine(line);
    if (!e) continue;
    const container = holders.get(e.client) ?? e.client;
    if (only && container !== only) continue;
    rows.push([e.time, container, e.result, e.method, e.host]);
  }
  const header = ["TIME", "CONTAINER", "RESULT", "METHOD", "HOST"];
  const widths = columnWidths([header, ...rows]);
  ctx.out(formatRow(header, widths));
  for (const row of rows) ctx.out(formatRow(row, widths));
  return 0;
}

export async function cmdEgress(ctx: Context, a?: string, b?: string): Promise<number> {
  if (a === "log") return cmdLog(ctx, b);
  if (b !== undefined && b !== "strict" && b !== "open") throw new ForgeError(USAGE);

  const repo = await resolveRepo(ctx, a, USAGE);
  validateRepo(repo);
  const container = await requireContainerForRepo(ctx, repo);
  const instance = (await listInstances(ctx)).find((i) => i.name === container);
  if (!instance) throw new ForgeError(`container ${container} not found.`);

  const current = effectiveEgress(instance.expandedDevices, egressNames(forgeProject()));

  if (b === undefined) {
    ctx.out(`${repo}: ${current}`);
    if (current === "strict") {
      const { entries } = loadAllowlist(allowlistPath());
      ctx.out(`allowlist: ${allowlistPath()} (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`);
    }
    return 0;
  }

  if (current === "?") {
    throw new ForgeError(
      `${container}: its eth0 device does not match open or strict (changed by hand?). ` +
      `Refusing to overwrite it: inspect it with 'incus --project ${forgeProject()} config device show ${container}'.`);
  }
  if (current === b) {
    ctx.out(`${repo}: already ${b}`);
    return 0;
  }
  if (instance.status !== "Stopped") {
    throw new ForgeError(`${container} is running: stop it first: forge stop ${repo}`);
  }

  const mode: EgressMode = b;
  if (mode === "strict") await toStrict(ctx, container, instance.devices.eth0 !== undefined);
  else await toOpen(ctx, container, instance.config, instance.devices.eth0 !== undefined);
  ctx.out(`${repo}: now ${mode}. The settings inside the container follow at the next forge start.`);
  return 0;
}

// Order: the NIC filter, then the environment, then the marker.
async function toStrict(ctx: Context, container: string, hasLocalNic: boolean): Promise<void> {
  const plan = await requireStrictRuntime(ctx);
  const names = egressNames(forgeProject());
  const nic = {
    "security.acls": names.strictAcl,
    "security.acls.default.egress.action": "reject",
    "security.acls.default.ingress.action": "reject",
  };
  await mustSucceed(`restricting the eth0 of ${container}`,
    hasLocalNic ? deviceSet(ctx, container, "eth0", nic) : deviceOverride(ctx, container, "eth0", nic));
  const env = Object.fromEntries(Object.entries(proxyEnv(plan)).map(([k, v]) => [`environment.${k}`, v]));
  await mustSucceed(`setting the proxy environment of ${container}`, configSetMany(ctx, container, env));
  await mustSucceed(`marking ${container} strict`, configSet(ctx, container, MARKER, "strict"));
}

// Order: the marker, the environment, then the NIC filter last. Only keys the
// instance has are unset (Incus refuses to unset an absent one).
async function toOpen(
  ctx: Context, container: string, config: Record<string, string>, hasLocalNic: boolean,
): Promise<void> {
  await mustSucceed(`marking ${container} open`, configSet(ctx, container, MARKER, "open"));
  for (const key of ENV_KEYS) {
    if (key in config) await mustSucceed(`unsetting ${key} of ${container}`, configUnset(ctx, container, key));
  }
  if (hasLocalNic) await mustSucceed(`restoring the eth0 of ${container}`, deviceRemove(ctx, container, "eth0"));
}
