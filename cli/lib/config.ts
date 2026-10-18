// forge's own configuration (spec "forge's configuration"): an optional JSON
// file where every key has a default. Validation is strict: a typo must stop
// forge with the file, the key and the expected form, never be ignored.
import { readFileSync } from "node:fs";
import { ForgeError } from "./context.ts";
import { PRIVATE_RANGES, cidrWithin, isHostAddress, parseCidr } from "./ipv4.ts";

export type Limits = { cpu: number | string | null; memory: string; processes: number; rootDisk: string };
export type ForgeConfig = { network: { ipv4Address: string }; storagePool: string; limits: Limits };

export const DEFAULT_CONFIG: ForgeConfig = {
  network: { ipv4Address: "10.77.0.1/24" },
  storagePool: "default",
  limits: { cpu: null, memory: "75%", processes: 10000, rootDisk: "50GiB" },
};

// An Incus size: "50GiB", "12GB", "512MiB".
const SIZE = /^[0-9]+(\.[0-9]+)?(B|[kKMGTPE]i?B)$/;
const PERCENT = /^([1-9][0-9]?|100)%$/;
// limits.cpu as a string: a CPU set such as "0-3" or "0,2,4-7".
const CPU_SET = /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/;
const POOL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadConfig(path: string): ForgeConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new ForgeError(`${path}: cannot read it: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ForgeError(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  return parseConfig(path, raw);
}

export function parseConfig(path: string, raw: unknown): ForgeConfig {
  const invalid = (key: string, expected: string, got: unknown) =>
    new ForgeError(`${path}: ${key} must be ${expected}, got ${JSON.stringify(got)}`);

  // An object's own keys, after refusing any key forge does not know. `key`
  // is the object's dotted path, "" at the top level.
  const fields = (value: unknown, key: string, known: string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid(key || "the file's content", "a JSON object", value);
    }
    for (const k of Object.keys(value)) {
      if (!known.includes(k)) {
        throw new ForgeError(`${path}: unknown key ${key ? `${key}.${k}` : k} (known: ${known.join(", ")})`);
      }
    }
    return value as Record<string, unknown>;
  };

  const config = structuredClone(DEFAULT_CONFIG);
  const top = fields(raw, "", ["network", "storagePool", "limits"]);

  if (top.network !== undefined) {
    const network = fields(top.network, "network", ["ipv4Address"]);
    const value = network.ipv4Address;
    if (value !== undefined) {
      const cidr = typeof value === "string" ? parseCidr(value) : null;
      const valid = cidr !== null && cidr.prefix <= 27 && isHostAddress(cidr) &&
        PRIVATE_RANGES.some((r) => cidrWithin(cidr, parseCidr(r)!));
      if (!valid) {
        throw invalid("network.ipv4Address",
          "the bridge's address with a prefix of /27 or wider, inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16 " +
          '(such as "10.77.0.1/24")', value);
      }
      config.network.ipv4Address = value as string;
    }
  }

  if (top.storagePool !== undefined) {
    if (typeof top.storagePool !== "string" || !POOL.test(top.storagePool)) {
      throw invalid("storagePool", 'the name of an Incus storage pool (such as "default")', top.storagePool);
    }
    config.storagePool = top.storagePool;
  }

  if (top.limits !== undefined) {
    const limits = fields(top.limits, "limits", ["cpu", "memory", "processes", "rootDisk"]);
    const { cpu, memory, processes, rootDisk } = limits;
    if (cpu !== undefined) {
      const valid = cpu === null ||
        (typeof cpu === "number" && Number.isInteger(cpu) && cpu > 0) ||
        (typeof cpu === "string" && CPU_SET.test(cpu));
      if (!valid) {
        throw invalid("limits.cpu", 'null (no limit), a number of CPUs (such as 4) or a CPU set (such as "0-3")', cpu);
      }
      config.limits.cpu = cpu as number | string | null;
    }
    if (memory !== undefined) {
      if (typeof memory !== "string" || !(SIZE.test(memory) || PERCENT.test(memory))) {
        throw invalid("limits.memory", 'a size (such as "12GiB") or a percentage of the host\'s memory (such as "75%")', memory);
      }
      config.limits.memory = memory;
    }
    if (processes !== undefined) {
      if (typeof processes !== "number" || !Number.isInteger(processes) || processes <= 0) {
        throw invalid("limits.processes", "a positive integer (such as 10000)", processes);
      }
      config.limits.processes = processes;
    }
    if (rootDisk !== undefined) {
      if (typeof rootDisk !== "string" || !SIZE.test(rootDisk)) {
        throw invalid("limits.rootDisk", 'a size (such as "50GiB")', rootDisk);
      }
      config.limits.rootDisk = rootDisk;
    }
  }
  return config;
}
