// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { herdrEnv, showNotification } from "./lib/herdr.ts";
import { ackAfterRun, collectNotices, noticeBody } from "./lib/popup.ts";
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
import { cmdAttach } from "./lib/commands/attach.ts";
import { cmdTaskBase } from "./lib/commands/task-base.ts";
import { cmdUploadPack } from "./lib/commands/upload-pack.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";
import { cmdCloud } from "./lib/commands/cloud.ts";
import { cmdInstall } from "./lib/commands/install.ts";
import { cmdOpen } from "./lib/commands/open.ts";
import { cmdFetch } from "./lib/commands/fetch.ts";
import { cmdShip } from "./lib/commands/ship.ts";
import { cmdRelay } from "./lib/commands/relay.ts";
import { currentSide, requireSide } from "./lib/side.ts";

const USAGE = `Usage: forge <command> [args]

On the forge host:
  setup                             Create or update forge's Incus project, bridge, ACLs and profiles,
                                    the egress proxy (forge-proxy) and its allowlist
  start [--strict] [<owner/repo>] [<task>]
                                    Provision (if needed) and start/attach a task session
  resume [<owner/repo>] [<task>]    Re-attach a task's agent (--all: every forge tab left bare by a herdr restart)
  finish [<owner/repo>] [<task>]    Remove a finished task's worktree
  stop [<owner/repo>] [--force]     Stop a container (blocked on dirty/unpushed WIP unless --force)
  delete [<owner/repo>] [--force]   Delete a container (blocked on dirty/unpushed WIP unless --force; --force also skips
                                    the "no forge metadata" confirmation)
  list                              Show all containers: repo, mode, egress, state, build
  egress [<owner/repo>] [strict|open]
                                    Show or switch a stopped container's egress
  egress log [<owner/repo>]         Show the proxy's recent requests (old lines may name the
                                    wrong container: addresses are reused)
  attach <container> <task>         Run a task's agent in this terminal (what herdr tabs run)
  upload-pack <container> [<path>]  Serve a container's repository to git fetch (see the README, "Get the work back")
  task-base <container> [<task>]    Print the ref a task started from (every task, tab-separated, without <task>)
  relay publish [<task>]            On the contributor's dev VM: publish agent/<task> through the relay
  relay pr <task> --title <text> --body-file <file|->
                                    Open the task's pull request (the body from a file, or stdin with -)
  relay comment <pr> --body-file <file|->
  relay reply <pr> <comment-id> --body-file <file|->
                                    Comment on a pull request, or reply to one of its comments
  relay read <number>               Read an issue or pull request thread (trusted accounts only)
  relay ci <pr> [<job-id>]          List a pull request's CI runs, or print one job's log
  image build                       Build the agent-base image (Ansible, through Incus)
  image commit                      Print the commit agent-base was built from (nothing if no image)
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
  completion repos                  List managed owner/repo, one per line (machine-readable)
  completion tasks <owner/repo>     List a repo's task names, one per line (machine-readable)

On your laptop:
  install [--remote <address>] [--host <name>]
                                    Install or update a forge host: the local Lima VM by default, a new
                                    remote VM with --remote, an installed host with --host
  open [--host <name>]              Open herdr on a forge host
  cloud create [--host <name>]      Create the dev VM and its relay on AWS and install them (or resume
                                    that install)
  cloud start|stop|rebuild [--host <name>]
                                    Start the VMs and open herdr, stop them (disks kept), or replace
                                    the dev VM with a new one (its disk is lost)
  cloud rebuild-relay [--host <name>]
                                    Replace the relay with a new one: a new bot token and signing key
  fetch [--host <name>]             Fetch the agents' branches into this clone and list the tasks
  ship <task> [--host <name>]       Re-sign a task's new commits, push agent/<task> and open its PR
                                    (a stacked task ships with the tasks under it, bottom first)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

type LaptopOptions = { remote?: string; host?: string };
type RelayArgs = { title?: string; bodyFile?: string };

function dispatch(
  ctx: Context, positionals: string[], force: boolean, strict: boolean, all: boolean, laptop: LaptopOptions, relay: RelayArgs,
): Promise<number> {
  const [cmd, a, b] = positionals;
  // --strict ne vaut que pour `start` (création d'un container strict).
  if (strict && cmd !== "start") throw new ForgeError(`--strict only applies to 'forge start'\n${USAGE}`);
  switch (cmd) {
    case "setup": return cmdSetup(ctx);
    case "start": return cmdStart(ctx, a, b, { strict });
    case "resume": return cmdResume(ctx, a, b, all);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, force);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "egress": return cmdEgress(ctx, a, b);
    case "attach": return cmdAttach(ctx, a, b);
    case "upload-pack": return cmdUploadPack(ctx, a);
    case "task-base": return cmdTaskBase(ctx, a, b);
    case "relay": return cmdRelay(ctx, a, positionals.slice(2), relay);
    case "image": return cmdImage(ctx, a, b);
    case "completion": return cmdCompletion(ctx, a, b);
    case "install": return cmdInstall(ctx, laptop);
    case "cloud": return cmdCloud(ctx, a, { host: laptop.host });
    case "open": return cmdOpen(ctx, { host: laptop.host });
    case "fetch": return cmdFetch(ctx, { host: laptop.host });
    case "ship": return cmdShip(ctx, a, { host: laptop.host });
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

// Un onglet herdr lance `exec forge attach …` : le pane se ferme avec forge.
// Dans un pane (HERDR_ENV=1 et HERDR_PANE_ID), un attach qui échoue ou un
// agent sorti en erreur laisse donc de quoi lire avant la fermeture.
function attachInHerdrPane(cmd: string | undefined): boolean {
  return cmd === "attach" && process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

async function main(): Promise<number> {
  const base = createContext();
  const { ctx, notices } = collectNotices(base);
  let cmd: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        force: { type: "boolean" }, strict: { type: "boolean" }, all: { type: "boolean" },
        remote: { type: "string" }, host: { type: "string" },
        title: { type: "string" }, "body-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    cmd = positionals[0];
    // Chaque commande a son côté : la mauvaise machine reçoit une ligne qui dit où aller.
    requireSide(cmd, currentSide());
    // Seul resume connaît --all : ailleurs, il serait ignoré en silence.
    if (values.all && cmd !== "resume") throw new ForgeError("--all only goes with resume: forge resume --all");
    // De même pour les options des commandes du laptop.
    if (values.remote !== undefined && cmd !== "install") {
      throw new ForgeError("--remote only goes with install: forge install --remote <address>");
    }
    if (values.host !== undefined && !["install", "open", "fetch", "ship", "cloud"].includes(cmd)) {
      throw new ForgeError("--host only goes with install, open, fetch, ship and cloud: forge install --host <name>, " +
        "forge open --host <name>, forge fetch --host <name>, forge ship <task> --host <name>, forge cloud start --host <name>");
    }
    if ((values.title !== undefined || values["body-file"] !== undefined) && cmd !== "relay") {
      throw new ForgeError("--title and --body-file only go with relay: forge relay pr <task> --title <text> --body-file <file>");
    }
    const laptop = { remote: values.remote, host: values.host };
    const code = await dispatch(ctx, positionals, values.force === true, values.strict === true, values.all === true, laptop,
      { title: values.title, bodyFile: values["body-file"] });
    // Politique d'acquittement de la popup herdr, qui se ferme avec le processus :
    // - un code de sortie non nul, ou une exception : on attend Entrée ;
    // - un succès sans rien à lire : elle se ferme aussitôt ;
    // - un succès qui a écrit des WARNING/NOTICE ou appelé ctx.notify : ces lignes
    //   partent en une notification herdr (voir cli/lib/popup.ts). On n'attend
    //   Entrée que si herdr répond shown:false (aucun client herdr attaché) ou a échoué ;
    //   avec un client attaché elle répond shown:true, toast affiché ou non.
    const popup = !!herdrEnv()?.popup;
    const attachPane = attachInHerdrPane(cmd);
    const ack = ackAfterRun({ popup, attachPane, code, threw: false, notices: notices.length });
    if (ack === "wait") {
      if (code !== 0 && attachPane) ctx.err(`the agent exited with code ${code}`);
      ctx.err("Press Enter to close");
      await waitForLine();
    } else if (ack === "notify") {
      let shown = false;
      try {
        shown = await showNotification(ctx, herdrEnv()!, `forge ${cmd}`, noticeBody(notices));
      } catch (e) {
        // Le contexte de base : cette ligne ne doit pas être collectée.
        base.err(`herdr notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!shown) {
        ctx.err("Press Enter to close");
        await waitForLine();
      }
    }
    return code;
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    // Dans la popup herdr, la fenêtre se ferme avec le processus : on laisse
    // le temps de lire l'erreur. De même pour un attach dans un pane herdr.
    if (ackAfterRun({ popup: !!herdrEnv()?.popup, attachPane: attachInHerdrPane(cmd), code: null, threw: true, notices: notices.length }) === "wait") {
      ctx.err("Press Enter to close");
      await waitForLine();
    }
    return 1;
  }
}

process.exit(await main());
