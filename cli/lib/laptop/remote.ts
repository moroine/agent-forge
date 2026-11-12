// Commands run on the forge host from the laptop, over the SSH alias forge
// wrote in ~/.ssh/config.d/agent-forge.config; and the admin's, by address,
// on a machine that has no alias (yet).
import { ForgeError, type Context, type ExecResult } from "../context.ts";
import { shellQuote } from "../shell.ts";
import { sshOption } from "./ssh-config.ts";
import { knownHostsPath, type LaptopHost } from "./state.ts";

// ssh joins its arguments with spaces and hands them to the remote shell: each
// word is quoted so it arrives as one.
export const remoteCommand = (argv: string[]): string => argv.map(shellQuote).join(" ");

// The alias forwards the agent, for the agents' clones under herdr; none of
// install's steps on the host needs it, so they turn it off.
const NO_AGENT = ["-o", "ForwardAgent=no"];

// Never prompts (BatchMode): a missing key fails instead of hanging.
export function remoteExec(ctx: Context, host: LaptopHost, argv: string[], input?: string): Promise<ExecResult> {
  const cmd = ["ssh", "-o", "BatchMode=yes", ...NO_AGENT, host.name, "--", remoteCommand(argv)];
  // Stdin, never argv: a secret must not show in a process list.
  return input === undefined ? ctx.exec(cmd) : ctx.exec(cmd, { input });
}

// Inherits the terminal; `tty` for a command that asks the user something.
export function remoteAttach(ctx: Context, host: LaptopHost, argv: string[], tty = false): Promise<number> {
  return ctx.attach(["ssh", ...NO_AGENT, ...(tty ? ["-t"] : []), host.name, "--", remoteCommand(argv)]);
}

// The agent forwarded, for the host commands that reach GitHub with it (the
// team's origin mirror): `forge team up` and `forge team sync`. A cloud host
// never gets it: its VM holds no key of the developer's.
// Outside the shared connection (ControlPath=none): OpenSSH forwards the agent
// to a multiplexed session only if the master connection does, and the master
// is often opened by a command without it (NO_AGENT). This costs one key touch
// per command, which suits a deliberate gesture.
export function remoteAttachForwarding(ctx: Context, host: LaptopHost, argv: string[]): Promise<number> {
  if (host.kind === "cloud") throw new ForgeError(`${host.name} is a cloud host: it never gets your SSH agent, so this command is not for it.`);
  return ctx.attach(["ssh", "-A", "-o", "ControlPath=none", host.name, "--", remoteCommand(argv)]);
}

// The admin's `ssh … <command>` to `address` (the host's, or its relay's),
// with forge's known_hosts and one key. By address, not by an alias whose
// ForwardAgent no would apply: a Host * of ~/.ssh/config must not forward the
// agent to a cloud VM. `command` is ssh's last arguments, as they are.
export function adminSsh(host: LaptopHost, address: string, options: string[] = [], command: string[] = ["true"]): string[] {
  const argv = ["ssh", "-o", sshOption("UserKnownHostsFile", knownHostsPath()), "-o", "IdentitiesOnly=yes", ...options];
  if (host.kind === "cloud") argv.push("-o", "ForwardAgent=no");
  if (host.identityAgent) argv.push("-o", sshOption("IdentityAgent", host.identityAgent));
  argv.push("-i", host.adminKey, `${host.admin}@${address}`, ...command);
  return argv;
}

// remoteExec and remoteAttach, as the admin, by address.
export function adminExec(ctx: Context, host: LaptopHost, address: string, argv: string[], input?: string): Promise<ExecResult> {
  const cmd = adminSsh(host, address, ["-o", "BatchMode=yes"], ["--", remoteCommand(argv)]);
  return input === undefined ? ctx.exec(cmd) : ctx.exec(cmd, { input });
}

export function adminAttach(ctx: Context, host: LaptopHost, address: string, argv: string[]): Promise<number> {
  return ctx.attach(adminSsh(host, address, [], ["--", remoteCommand(argv)]));
}
