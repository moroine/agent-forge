// Commands run on the forge host from the laptop, over the SSH alias forge
// wrote in ~/.ssh/config.d/agent-forge.config.
import type { Context, ExecResult } from "../context.ts";
import { shellQuote } from "../shell.ts";
import type { LaptopHost } from "./state.ts";

// ssh joins its arguments with spaces and hands them to the remote shell: each
// word is quoted so it arrives as one.
const remoteCommand = (argv: string[]): string => argv.map(shellQuote).join(" ");

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
