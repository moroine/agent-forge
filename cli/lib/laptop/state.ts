// The laptop's record of the forge hosts it installed (`forge install`), kept
// in <state>/hosts.json. It holds no secret: only addresses, account names and
// paths to key files.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ForgeError, type Context } from "../context.ts";
import { laptopStateDir } from "../paths.ts";

export type InstallStep = "vm" | "inventory" | "playbook" | "ssh" | "identity" | "claude" | "setup" | "image";

const STEPS: readonly string[] = ["vm", "inventory", "playbook", "ssh", "identity", "claude", "setup", "image"];
const KINDS: readonly string[] = ["lima", "remote", "cloud"];
const EXPOSURES: readonly string[] = ["local", "public", "lan"];

export type LaptopHost = {
  name: string;
  kind: "lima" | "remote" | "cloud";
  address: string;
  port: number;
  user: string;
  admin: string;
  // The key the admin account accepts: the admin's private key file, or the
  // chosen GitHub key's .pub under forgeKeyPath(name); for Lima, its own key.
  adminKey: string;
  exposure: "local" | "public" | "lan";
  identityAgent?: string;
  // The checkout commit the playbook last deployed: another one, after a git
  // pull, is deployed again on the next forge install.
  deployed?: string;
  done: InstallStep[];
};

export function validHostName(name: string): boolean {
  return /^forge-[a-z0-9][a-z0-9-]*$/.test(name);
}

function statePath(): string {
  return join(laptopStateDir(), "hosts.json");
}

export function hostDir(name: string): string {
  return join(laptopStateDir(), "hosts", name);
}

export function inventoryPath(name: string): string {
  return join(hostDir(name), "inventory.yml");
}

export function forgeKeyPath(name: string): string {
  return join(hostDir(name), "forge-key.pub");
}

export function knownHostsPath(): string {
  return join(laptopStateDir(), "known_hosts");
}

function isHost(h: unknown): h is LaptopHost {
  if (typeof h !== "object" || h === null) return false;
  const o = h as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string";
  // A valid name only: hostDir(name) is removed recursively when a host is forgotten.
  return str("name") && validHostName(o.name as string) && str("address") && str("user") && str("admin") && str("adminKey") &&
    typeof o.port === "number" && Number.isInteger(o.port) &&
    str("kind") && KINDS.includes(o.kind as string) &&
    str("exposure") && EXPOSURES.includes(o.exposure as string) &&
    (o.identityAgent === undefined || typeof o.identityAgent === "string") &&
    (o.deployed === undefined || typeof o.deployed === "string") &&
    Array.isArray(o.done) && o.done.every((s) => typeof s === "string" && STEPS.includes(s));
}

export function loadHosts(): LaptopHost[] {
  const path = statePath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ForgeError(`${path}: not valid JSON (${(e as Error).message}); fix or remove the file`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isHost)) {
    throw new ForgeError(`${path}: not a list of forge hosts; fix or remove the file`);
  }
  return parsed;
}

// Atomic write: temp file next to the target, then rename; 0600 file in a 0700 directory.
function writeHosts(hosts: LaptopHost[]): void {
  const path = statePath();
  const dir = laptopStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.forge-tmp`;
  writeFileSync(tmp, JSON.stringify(hosts, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

export function saveHost(host: LaptopHost): void {
  const hosts = loadHosts();
  const i = hosts.findIndex((h) => h.name === host.name);
  if (i === -1) hosts.push(host); else hosts[i] = host;
  writeHosts(hosts);
}

export function forgetHost(name: string): void {
  writeHosts(loadHosts().filter((h) => h.name !== name));
}

export async function selectHost(ctx: Context, wanted?: string): Promise<LaptopHost> {
  const hosts = loadHosts();
  if (wanted !== undefined) {
    const found = hosts.find((h) => h.name === wanted);
    if (found) return found;
    const names = hosts.map((h) => h.name).join(", ") || "none";
    throw new ForgeError(`unknown host ${wanted}: known hosts are ${names}`);
  }
  if (hosts.length === 0) throw new ForgeError("no forge host yet: run forge install");
  if (hosts.length === 1) return hosts[0];
  const i = await ctx.prompt.pick("Host", hosts.map((h) => h.name));
  if (i === null) throw new ForgeError("several forge hosts: pass --host <name>");
  return hosts[i - 1];
}
