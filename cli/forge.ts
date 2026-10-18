// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { herdrEnv } from "./lib/herdr.ts";
import type { Context } from "./lib/context.ts";
import { createContext, ForgeError } from "./lib/context.ts";
import { cmdSetup } from "./lib/commands/setup.ts";
import { cmdStart } from "./lib/commands/start.ts";
import { cmdResume } from "./lib/commands/resume.ts";
import { cmdFinish } from "./lib/commands/finish.ts";
import { cmdStop } from "./lib/commands/stop.ts";
import { cmdDelete } from "./lib/commands/delete.ts";
import { cmdList } from "./lib/commands/list.ts";
import { cmdImage } from "./lib/commands/image.ts";
import { cmdAttach } from "./lib/commands/attach.ts";
import { cmdUploadPack } from "./lib/commands/upload-pack.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";

const USAGE = `Usage: forge <command> [args]

Commands:
  setup                             Create or update forge's Incus project, bridge, ACL and profile
  start [<owner/repo>] [<task>]     Provision (if needed) and start/attach a task session
  resume [<owner/repo>] [<task>]    Re-attach a task's agent (--all: every forge tab left bare by a herdr restart)
  finish [<owner/repo>] [<task>]    Remove a finished task's worktree
  stop [<owner/repo>] [--force]     Stop a container (blocked on dirty/unpushed WIP unless --force)
  delete [<owner/repo>] [--force]   Delete a container (blocked on dirty/unpushed WIP unless --force)
  list                              Show all containers: repo, mode, state, build
  attach <container> <task>         Run a task's agent in this terminal (what herdr tabs run)
  upload-pack <container> [<path>]  Serve a container's repository to git fetch (see forge start's retrieval hint)
  image build                       Build the agent-base image (Ansible, through Incus)
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
  completion repos                  List managed owner/repo, one per line (machine-readable)
  completion tasks <owner/repo>     List a repo's task names, one per line (machine-readable)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

function dispatch(ctx: Context, positionals: string[], force: boolean, all: boolean): Promise<number> {
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case "setup": return cmdSetup(ctx);
    case "start": return cmdStart(ctx, a, b);
    case "resume": return cmdResume(ctx, a, b, all);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, force);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "attach": return cmdAttach(ctx, a, b);
    case "upload-pack": return cmdUploadPack(ctx, a);
    case "image": return cmdImage(ctx, a, b);
    case "completion": return cmdCompletion(ctx, a, b);
    default: throw new ForgeError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

// Une ligne, ou la fin de stdin.
function waitForLine(): Promise<void> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin });
    const finish = () => { rl.close(); done(); };
    rl.once("line", finish);
    rl.once("close", finish);
  });
}

async function main(): Promise<number> {
  const ctx = createContext();
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { force: { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    return await dispatch(ctx, positionals, values.force === true, values.all === true);
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    // Dans la popup herdr, la fenêtre se ferme avec le processus : on laisse
    // le temps de lire l'erreur.
    if (herdrEnv()?.popup) {
      ctx.err("Press Enter to close");
      await waitForLine();
    }
    return 1;
  }
}

process.exit(await main());
