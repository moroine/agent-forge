// Which machine a command runs on: the forge host (Incus, herdr server) or the
// maintainer's laptop (install, open, and later fetch and ship). The same CLI
// runs on both, so each command states its side and the wrong one gets a
// one-line pointer instead of a confusing failure further down.
import { existsSync } from "node:fs";
import { ForgeError } from "./context.ts";

export type Side = "host" | "laptop";

// The playbook's install root: present on every Ansible host, however forge
// is run there.
const HOST_ROOT = "/opt/agent-forge";

// FORGE_SIDE (host or laptop) overrides the detection: tests and odd setups.
export function currentSide(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): Side {
  if (env.FORGE_SIDE === "host" || env.FORGE_SIDE === "laptop") return env.FORGE_SIDE;
  return exists(HOST_ROOT) ? "host" : "laptop";
}

export const LAPTOP_COMMANDS = ["install", "open", "fetch", "ship", "cloud", "hc-via"] as const;

const HOST_COMMANDS = [
  "setup", "start", "resume", "finish", "stop", "delete", "list", "egress", "attach", "upload-pack", "task-base", "image", "relay", "team", "hc-exec", "api",
] as const;

// `completion` and `team` are for both sides: each is the current side's own
// (on the laptop, `team` forwards to the host and registers Herdr App's machines).
export function commandSide(cmd: string): Side {
  if (cmd === "completion" || cmd === "team") return currentSide();
  return (LAPTOP_COMMANDS as readonly string[]).includes(cmd) ? "laptop" : "host";
}

// Unknown commands pass: dispatch reports them with the usage.
export function requireSide(cmd: string, side: Side): void {
  if (cmd === "team") return;
  const known = (LAPTOP_COMMANDS as readonly string[]).includes(cmd) || (HOST_COMMANDS as readonly string[]).includes(cmd);
  if (!known || commandSide(cmd) === side) return;
  if (side === "host") {
    throw new ForgeError(`forge ${cmd} runs on your laptop, in the agent-forge checkout.`);
  }
  throw new ForgeError(`forge ${cmd} runs on the forge host: ssh <host> forge ${cmd}.`);
}
