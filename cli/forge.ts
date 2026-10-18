// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import type { Context } from "./lib/context.ts";
import { createContext, ForgeError } from "./lib/context.ts";
import { cmdSetup } from "./lib/commands/setup.ts";
import { cmdStart } from "./lib/commands/start.ts";
import { cmdResume } from "./lib/commands/resume.ts";
import { cmdFinish } from "./lib/commands/finish.ts";
import { cmdStop } from "./lib/commands/stop.ts";
import { cmdDelete } from "./lib/commands/delete.ts";
import { cmdList } from "./lib/commands/list.ts";
import { cmdEgress } from "./lib/commands/egress.ts";
import { cmdImage } from "./lib/commands/image.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";

const USAGE = `Usage: forge <command> [args]

Commands:
  setup                             Create or update forge's Incus project, bridge, ACLs and profiles,
                                    the egress proxy (forge-proxy) and its allowlist
  start [--strict] [<owner/repo>] [<task>]
                                    Provision (if needed) and start/attach a task session
  resume [<owner/repo>] [<task>]    Re-attach an existing task's session
  finish [<owner/repo>] [<task>]    Remove a finished task's worktree
  stop [<owner/repo>] [--force]     Stop a container (blocked on dirty/unpushed WIP unless --force)
  delete [<owner/repo>] [--force]   Delete a container (blocked on dirty/unpushed WIP unless --force)
  list                              Show all containers: repo, mode, egress, state, build
  egress [<owner/repo>] [strict|open]
                                    Show or switch a stopped container's egress
  egress log [<owner/repo>]         Show the proxy's recent requests (old lines may name the
                                    wrong container: addresses are reused)
  image build                       Build the agent-base image (Ansible, through Incus)
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
  completion repos                  List managed owner/repo, one per line (machine-readable)
  completion tasks <owner/repo>     List a repo's task names, one per line (machine-readable)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

function dispatch(ctx: Context, positionals: string[], force: boolean, strict: boolean): Promise<number> {
  const [cmd, a, b] = positionals;
  // --strict ne vaut que pour `start` (création d'un container strict).
  if (strict && cmd !== "start") throw new ForgeError(`--strict only applies to 'forge start'\n${USAGE}`);
  switch (cmd) {
    case "setup": return cmdSetup(ctx);
    case "start": return cmdStart(ctx, a, b, { strict });
    case "resume": return cmdResume(ctx, a, b);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, force);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "egress": return cmdEgress(ctx, a, b);
    case "image": return cmdImage(ctx, a, b);
    case "completion": return cmdCompletion(ctx, a, b);
    default: throw new ForgeError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const ctx = createContext();
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { force: { type: "boolean" }, strict: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    return await dispatch(ctx, positionals, values.force === true, values.strict === true);
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
