// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import type { Context } from "./lib/context.ts";
import { createContext, ForgeError } from "./lib/context.ts";
import { cmdSetup } from "./lib/commands/setup.ts";
import { cmdStop } from "./lib/commands/stop.ts";
import { cmdDelete } from "./lib/commands/delete.ts";
import { cmdList } from "./lib/commands/list.ts";
import { cmdEgress } from "./lib/commands/egress.ts";
import { cmdImage } from "./lib/commands/image.ts";
import { cmdTaskBase } from "./lib/commands/task-base.ts";
import { cmdUploadPack } from "./lib/commands/upload-pack.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";
import { cmdCloud } from "./lib/commands/cloud.ts";
import { cmdInstall } from "./lib/commands/install.ts";
import { cmdOpen } from "./lib/commands/open.ts";
import { cmdFetch } from "./lib/commands/fetch.ts";
import { cmdShip } from "./lib/commands/ship.ts";
import { cmdRelay } from "./lib/commands/relay.ts";
import { cmdApi } from "./lib/commands/api.ts";
import { cmdTeam } from "./lib/commands/team.ts";
import { cmdTeamLaptop } from "./lib/commands/team-laptop.ts";
import { cmdHcVia } from "./lib/commands/hc-via.ts";
import { cmdHcExec } from "./lib/commands/hc-exec.ts";
import { currentSide, requireSide } from "./lib/side.ts";

const USAGE = `Usage: forge <command> [args]

On the forge host:
  setup                             Create or update forge's Incus project, bridge, ACLs and profiles,
                                    the egress proxy (forge-proxy) and its allowlist
  stop [<owner/repo>] [--force]     Stop a container (blocked on dirty/unpushed WIP unless --force)
  delete [<owner/repo>] [--force]   Delete a container (blocked on dirty/unpushed WIP unless --force; --force also skips
                                    the "no forge metadata" confirmation)
  list                              Show all containers: repo, mode, egress, state, build
  egress [<owner/repo>] [strict|open]
                                    Show or switch a stopped container's egress
  egress log [<owner/repo>]         Show the proxy's recent requests (old lines may name the
                                    wrong container: addresses are reused)
  upload-pack <container> [<path>]  Serve a container's repository to git fetch (see the README, "Get the work back")
  task-base <container> [<task>]    Print the ref a task started from (every task, tab-separated, without <task>)
  team converge [<team>]            Create or start the agents of the configured teams (and the Pilot), refresh the team mirror
  team assign <container> [<task>]  Give a team member a task, the instruction read from stdin (a fresh session)
  team release <container>          Free a team member
  team status [--json]              Each member's task and session (refreshes the team mirror first)
  team sync <team>                  Refresh the team's origin mirror (needs the forwarded SSH agent), then the team mirror
  relay publish [<task>]            On the contributor's dev VM: publish agent/<task> through the relay
  relay pr <task> --title <text> --body-file <file|->
                                    Open the task's pull request (the body from a file, or stdin with -)
  relay comment <pr> --body-file <file|->
  relay reply <pr> <comment-id> --body-file <file|->
                                    Comment on a pull request, or reply to one of its comments
  relay read <number>               Read an issue or pull request thread (trusted accounts only)
  relay ci <pr> [<job-id>]          List a pull request's CI runs, or print one job's log
  api serve                         Answer the team containers' requests (the forge-api user service runs it)
  image build                       Build the agent-base image (Ansible, through Incus)
  image commit                      Print the commit agent-base was built from (nothing if no image)
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
  completion repos                  List managed owner/repo, one per line (machine-readable)

On your laptop:
  install [--remote <address>] [--host <name>] [--ssh-persist <duration>]
                                    Install or update a forge host: the local Lima VM by default, a new
                                    remote VM with --remote, an installed host with --host; the shared
                                    SSH connection lasts 8h after its last use, or --ssh-persist (30m, 2d)
  open [--host <name>]              Open herdr on a forge host
  cloud create [--host <name>]      Create the dev VM and its relay on AWS and install them (or resume
                                    that install)
  cloud start|stop|rebuild [--host <name>]
                                    Start the VMs and open herdr, stop them (disks kept), or replace
                                    the dev VM with a new one (its disk is lost)
  cloud rebuild-relay [--host <name>]
                                    Replace the relay with a new one: a new bot token, push key and
                                    signing key
  fetch [--host <name>]             Fetch the agents' branches into this clone and list the tasks
  team up [<team>] [--host <name>]  Converge the teams on the host, then add each agent as a Herdr App machine
                                    (team assign, release, status and sync also work from here, over SSH)
  ship <task> [--host <name>]       Re-sign a task's new commits, push agent/<task> and open its PR
                                    (a stacked task ships with the tasks under it, bottom first)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

type LaptopOptions = { remote?: string; host?: string; sshPersist?: string };
type RelayArgs = { title?: string; bodyFile?: string; json?: boolean };

function dispatch(
  ctx: Context, positionals: string[], force: boolean, laptop: LaptopOptions, relay: RelayArgs,
): Promise<number> {
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case "setup": return cmdSetup(ctx);
    case "stop": return cmdStop(ctx, a, force);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "egress": return cmdEgress(ctx, a, b);
    case "upload-pack": return cmdUploadPack(ctx, a);
    case "task-base": return cmdTaskBase(ctx, a, b);
    case "relay": return cmdRelay(ctx, a, positionals.slice(2), relay);
    case "team": return currentSide() === "laptop"
      ? cmdTeamLaptop(ctx, positionals.slice(1), { host: laptop.host, json: relay.json })
      : cmdTeam(ctx, positionals.slice(1), { json: relay.json });
    case "api": return cmdApi(ctx, a);
    case "hc-via": return cmdHcVia(ctx, a, b, positionals[3]);
    case "hc-exec": return cmdHcExec(ctx, a, b);
    case "image": return cmdImage(ctx, a, b);
    case "completion": return cmdCompletion(ctx, a);
    case "install": return cmdInstall(ctx, laptop);
    case "cloud": return cmdCloud(ctx, a, { host: laptop.host });
    case "open": return cmdOpen(ctx, { host: laptop.host });
    case "fetch": return cmdFetch(ctx, { host: laptop.host });
    case "ship": return cmdShip(ctx, a, { host: laptop.host });
    default: throw new ForgeError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const ctx = createContext();
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        force: { type: "boolean" },
        remote: { type: "string" }, host: { type: "string" }, "ssh-persist": { type: "string" },
        title: { type: "string" }, "body-file": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    const cmd = positionals[0];
    // Chaque commande a son côté : la mauvaise machine reçoit une ligne qui dit où aller.
    requireSide(cmd, currentSide());
    // De même pour les options des commandes du laptop.
    if (values.remote !== undefined && cmd !== "install") {
      throw new ForgeError("--remote only goes with install: forge install --remote <address>");
    }
    if (values.host !== undefined && !["install", "open", "fetch", "ship", "cloud", "team"].includes(cmd)) {
      throw new ForgeError("--host only goes with install, open, fetch, ship, cloud and team: forge install --host <name>, " +
        "forge open --host <name>, forge fetch --host <name>, forge ship <task> --host <name>, forge cloud start --host <name>");
    }
    if ((values.title !== undefined || values["body-file"] !== undefined) && cmd !== "relay") {
      throw new ForgeError("--title and --body-file only go with relay: forge relay pr <task> --title <text> --body-file <file>");
    }
    if (values.json && cmd !== "team") throw new ForgeError("--json only goes with team status: forge team status --json");
    if (values["ssh-persist"] !== undefined && cmd !== "install") {
      throw new ForgeError("--ssh-persist only goes with install: forge install --ssh-persist 2h");
    }
    const laptop = { remote: values.remote, host: values.host, sshPersist: values["ssh-persist"] };
    return await dispatch(ctx, positionals, values.force === true, laptop,
      { title: values.title, bodyFile: values["body-file"], json: values.json });
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
