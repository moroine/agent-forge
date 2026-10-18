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
import { readAllowlist } from "../allowlist.ts";
import { allowlistPath } from "../paths.ts";
import { requireContainerForRepo } from "../containers.ts";
import {
  configSet, configSetMany, configUnset, deviceOverride, deviceRemove, deviceSet, execArgv, forgeProject,
  listInstances, listLeases, type Instance,
} from "../incus.ts";
import { BRIDGE, effectiveEgress, egressNames, proxyInstance, type EgressMode } from "../objects.ts";
import { SQUID_ACCESS_LOG } from "../proxy.ts";
import { ENV_KEYS, currentPlan, egressMismatch, proxyEnv, requireStrictRuntime } from "../strict.ts";
import { columnWidths, formatRow } from "../table.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge egress [<owner/repo>] [strict|open] | forge egress log [<owner/repo>]\n" +
  "Old lines of the log may name the wrong container: addresses are reused.";
const MARKER = "user.forge.egress";

export type LogEntry = {
  time: string; client: string; result: "allowed" | "denied" | "error"; method: string; host: string;
};

// squid's action: TCP_DENIED* is the proxy's refusal; NONE* is a request squid
// could not serve at all (an invalid request, a squid-side error); anything
// else reached the destination (an origin's own 403 included).
function resultOf(action: string): LogEntry["result"] {
  if (action.startsWith("TCP_DENIED")) return "denied";
  if (action.startsWith("NONE")) return "error";
  return "allowed";
}

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
      // A URL without a host (squid's "error:invalid-request") keeps the field.
      host = new URL(target).host || target;
    } catch {
      // Not a URL: keep the field as is.
    }
  }
  return {
    time: new Date(Number(f[0]) * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    client,
    result: resultOf(action),
    method,
    host,
  };
}

// The log's fields come from the agents' requests: no control character (C0,
// DEL, C1) reaches the terminal, so no escape sequence either.
const printable = (field: string): string => field.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

async function cmdLog(ctx: Context, repo: string | undefined): Promise<number> {
  let only: string | null = null;
  if (repo) {
    validateRepo(repo);
    only = await requireContainerForRepo(ctx, repo);
  }
  const r = await execArgv(ctx, proxyInstance(), ["tail", "-n", "200", SQUID_ACCESS_LOG]);
  if (r.code !== 0) {
    throw new ForgeError(`${proxyInstance()} is not reachable; run 'forge setup' (${r.stderr.trim() || `exit code ${r.code}`})`);
  }
  // The holder of each address: the DHCP leases first (a stopped instance
  // keeps its lease but `incus list` shows it no address), then the current
  // addresses, which win. An address nobody holds is shown as is, and so is
  // one whose lease names no host ("*" is dnsmasq's placeholder).
  const holders = new Map<string, string>();
  for (const l of await listLeases(ctx, BRIDGE)) {
    if (l.hostname !== "" && l.hostname !== "*") holders.set(l.address, l.hostname);
  }
  for (const i of await listInstances(ctx)) for (const a of i.ipv4) holders.set(a, i.name);

  const rows: string[][] = [];
  for (const line of r.stdout.split("\n")) {
    const e = parseSquidLine(line);
    if (!e) continue;
    const container = holders.get(e.client) ?? e.client;
    if (only && container !== only) continue;
    rows.push([e.time, container, e.result, e.method, e.host].map(printable));
  }
  const header = ["TIME", "CONTAINER", "RESULT", "METHOD", "HOST"];
  const widths = columnWidths([header, ...rows]);
  ctx.out(formatRow(header, widths));
  for (const row of rows) ctx.out(formatRow(row, widths));
  return 0;
}

function switchComplete(instance: Instance, mode: EgressMode): boolean {
  const marker = instance.config[MARKER];
  if (mode === "strict") {
    const env = proxyEnv(currentPlan());
    return marker === "strict" && Object.entries(env).every(([k, v]) => instance.config[`environment.${k}`] === v);
  }
  return (marker === "open" || marker === undefined) && !ENV_KEYS.some((k) => k in instance.config) &&
    instance.devices.eth0 === undefined;
}

export async function cmdEgress(ctx: Context, a?: string, b?: string): Promise<number> {
  if (a === "log") return cmdLog(ctx, b);
  if (b !== undefined && b !== "strict" && b !== "open") throw new ForgeError(USAGE);

  const repo = await resolveRepo(ctx, a, USAGE);
  validateRepo(repo);
  const container = await requireContainerForRepo(ctx, repo);
  const instance = (await listInstances(ctx)).find((i) => i.name === container);
  if (!instance) throw new ForgeError(`container ${container} not found.`);

  const names = egressNames(forgeProject());
  const current = effectiveEgress(instance.expandedDevices, names);

  if (b === undefined) {
    ctx.out(`${repo}: ${current}`);
    if (current === "strict") {
      // Display only: the file is created by `forge setup`, never here.
      const path = allowlistPath();
      const entries = readAllowlist(path);
      ctx.out(entries === null
        ? `allowlist: ${path} (not created yet: run forge setup)`
        : `allowlist: ${path} (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`);
    }
    const unfinished = egressMismatch(instance, names) ??
      (current !== "?" && !switchComplete(instance, current)
        ? `the switch of ${container} to ${current} is not complete (its marker, proxy environment and eth0 do not all match). ` +
          `Finish it on the stopped container: forge egress ${repo} ${current}`
        : null);
    if (unfinished !== null) ctx.err(`WARNING: ${unfinished}`);
    return 0;
  }

  if (current === "?") {
    throw new ForgeError(
      `${container}: its eth0 device does not match open or strict (changed by hand?). ` +
      `Refusing to overwrite it: inspect it with 'incus --project ${forgeProject()} config device show ${container}'.`);
  }
  // "Already" only when the switch is complete: an interrupted one leaves the
  // NIC in the new mode but the marker or the environment behind.
  if (current === b && switchComplete(instance, b)) {
    ctx.out(`${repo}: already ${b}`);
    return 0;
  }
  if (instance.status !== "Stopped") {
    throw new ForgeError(`${container} is running: stop it first: forge stop ${repo}`);
  }

  const mode: EgressMode = b;
  const changes = mode === "strict"
    ? await toStrict(ctx, container, instance.devices.eth0 !== undefined)
    : await toOpen(ctx, container, instance.config, instance.devices.eth0 !== undefined);
  for (const change of changes) ctx.out(`changed: ${change}`);
  ctx.out(`${repo}: now ${mode}. The settings inside the container follow at the next forge start.`);
  return 0;
}

// Order: the NIC filter, then the environment, then the marker. Returns one
// line per step applied.
async function toStrict(ctx: Context, container: string, hasLocalNic: boolean): Promise<string[]> {
  const plan = await requireStrictRuntime(ctx);
  const names = egressNames(forgeProject());
  const nic = {
    "security.acls": names.strictAcl,
    "security.acls.default.egress.action": "reject",
    "security.acls.default.ingress.action": "reject",
  };
  await mustSucceed(`restricting the eth0 of ${container}`,
    hasLocalNic ? deviceSet(ctx, container, "eth0", nic) : deviceOverride(ctx, container, "eth0", nic));
  const proxy = proxyEnv(plan);
  const env = Object.fromEntries(Object.entries(proxy).map(([k, v]) => [`environment.${k}`, v]));
  await mustSucceed(`setting the proxy environment of ${container}`, configSetMany(ctx, container, env));
  await mustSucceed(`marking ${container} strict`, configSet(ctx, container, MARKER, "strict"));
  return [
    `eth0 filtered by ${names.strictAcl}, default egress and ingress reject`,
    `proxy environment set (${ENV_KEYS.length} keys, ${proxy.HTTPS_PROXY})`,
    `${MARKER}=strict`,
  ];
}

// Order: the marker, the environment, then the NIC filter last. Only keys the
// instance has are unset (Incus refuses to unset an absent one). Returns one
// line per step that had something to do.
async function toOpen(
  ctx: Context, container: string, config: Record<string, string>, hasLocalNic: boolean,
): Promise<string[]> {
  const changes: string[] = [];
  await mustSucceed(`marking ${container} open`, configSet(ctx, container, MARKER, "open"));
  changes.push(`${MARKER}=open`);
  const present = ENV_KEYS.filter((key) => key in config);
  for (const key of present) await mustSucceed(`unsetting ${key} of ${container}`, configUnset(ctx, container, key));
  if (present.length > 0) changes.push(`proxy environment removed (${present.length} ${present.length === 1 ? "key" : "keys"})`);
  if (hasLocalNic) {
    await mustSucceed(`restoring the eth0 of ${container}`, deviceRemove(ctx, container, "eth0"));
    changes.push("eth0 override removed, the profile's NIC applies again");
  }
  return changes;
}
