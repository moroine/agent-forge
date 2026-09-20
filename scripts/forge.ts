// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import type { Context } from "./lib/context.ts";
import { createContext, ForgeError } from "./lib/context.ts";
import { cmdStart } from "./lib/commands/start.ts";
import { cmdResume } from "./lib/commands/resume.ts";
import { cmdFinish } from "./lib/commands/finish.ts";
import { cmdStop } from "./lib/commands/stop.ts";
import { cmdDelete } from "./lib/commands/delete.ts";
import { cmdList } from "./lib/commands/list.ts";
import { cmdTemplate } from "./lib/commands/template.ts";
import { cmdToken } from "./lib/commands/token.ts";
import { cmdClaude } from "./lib/commands/claude.ts";
import { cmdImage } from "./lib/commands/image.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";

const USAGE = `Usage: forge <command> [args]

Commands:
  start [<owner/repo>] [<task>]        Copy the template + worktree + attach
  resume [<owner/repo>] [<task>]       Re-attach (starts the container if stopped)
  finish [<owner/repo>] [<task>] [--force]
                                        WIP pre-flight, then worktree removed and
                                        container deleted. Branch retained.
  stop [<owner/repo>] [<task>]         Pause a container, no WIP pre-flight
                                        (without <task>: every container of the repo)
  delete [<owner/repo>] [--force]      WIP pre-flight across all worktrees, then
                                        deletes the tasks AND the template.
                                        The host mount survives.
  list                                 Show all containers, grouped by repo: template
                                        state, then one line per task
  template rebuild [<owner/repo>]      Rebuild the template from agent-base,
                                        credentials re-read from the host store
  token set|rm|import [<owner/repo>]   Manage the host PAT store
  claude update [<version>] | list     Install a claude-code version on the host,
                                        switch 'current'
  image build|update [super]           Rebuild agent-base (or, with super, agent-base-super = base + nested LXD)
  completion bash                      Print a bash completion function (eval it in ~/.bashrc)
  completion repos                     List managed owner/repo, one per line (machine-readable)
  completion tasks <owner/repo>        List a repo's task names, one per line (machine-readable)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

function dispatch(ctx: Context, positionals: string[], force: boolean): Promise<number> {
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case "start": return cmdStart(ctx, a, b);
    case "resume": return cmdResume(ctx, a, b);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, b);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "template": return cmdTemplate(ctx, a, b);
    case "token": return cmdToken(ctx, a, b);
    case "claude": return cmdClaude(ctx, a, b);
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
      options: { force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    return await dispatch(ctx, positionals, values.force === true);
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
