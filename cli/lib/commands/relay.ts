// forge relay: the contributor's dev VM talks to GitHub only through the
// relay. Each subcommand is one request; what comes back is text the agent's
// side did not write, so it passes through printable before it is shown.
import { readFileSync } from "node:fs";
import { ForgeError, type Context } from "../context.ts";
import { loadRelayClientConfig, publishBranch, relayCall } from "../relay/client.ts";
import type { Thread, ThreadItem } from "../relay/github.ts";
import { printable, printableText } from "../printable.ts";

export type RelayOptions = {
  title?: string;
  bodyFile?: string;
  cwd?: string;
  configFile?: string;
  // Stdin for --body-file -, replaceable by tests.
  stdin?: () => string;
};

const USAGE = "usage: forge relay publish [<task>] | pr <task> --title <text> --body-file <file|-> | " +
  "comment <pr> --body-file <file|-> | reply <pr> <comment-id> --body-file <file|-> | read <number> | ci <pr> [<job-id>]";

function integer(s: string | undefined, what: string): number {
  if (s === undefined || !/^[1-9][0-9]{0,8}$/.test(s)) throw new ForgeError(`${what} must be a positive integer\n${USAGE}`);
  return Number(s);
}

// A title or a body goes as given: the relay does the checks.
function body(opts: RelayOptions): string {
  if (opts.bodyFile === undefined) throw new ForgeError(`--body-file <file|-> is required\n${USAGE}`);
  try {
    return opts.bodyFile === "-" ? (opts.stdin ?? (() => readFileSync(0, "utf8")))() : readFileSync(opts.bodyFile, "utf8");
  } catch {
    throw new ForgeError(`cannot read ${opts.bodyFile}`);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function printThread(ctx: Context, t: Thread): void {
  ctx.out(printable(`#${t.number} ${t.kind}${t.title ? `: ${t.title}` : ""} (${t.state})`));
  for (const i of t.items as ThreadItem[]) {
    const where = i.path !== undefined ? `, ${i.path}${i.line !== undefined ? `:${i.line}` : ""}` : "";
    ctx.out(printable(`--- ${i.kind} ${i.id} by ${i.author}, ${i.createdAt}${where}`));
    ctx.out(printableText(i.body));
  }
  if (t.hidden > 0) ctx.out(`${t.hidden} items from other accounts hidden`);
}

export async function cmdRelay(ctx: Context, sub: string | undefined, args: string[], opts: RelayOptions = {}): Promise<number> {
  if (sub === undefined) throw new ForgeError(USAGE);
  const cfg = loadRelayClientConfig(opts.configFile);
  switch (sub) {
    case "publish": {
      const { head, url } = await publishBranch(ctx, cfg, opts.cwd, args[0]);
      ctx.out(`published ${head}`);
      ctx.out(printable(url));
      return 0;
    }
    case "pr": {
      if (args[0] === undefined || opts.title === undefined) throw new ForgeError(`pr needs <task> and --title\n${USAGE}`);
      const a = await relayCall(ctx, cfg, "open-pr", { branch: `agent/${args[0]}`, title: opts.title, body: body(opts) });
      ctx.out(printable(`#${a.number} ${str(a.url)}`));
      return 0;
    }
    case "comment": {
      const a = await relayCall(ctx, cfg, "comment", { pr: integer(args[0], "<pr>"), body: body(opts) });
      ctx.out(printable(str(a.url)));
      return 0;
    }
    case "reply": {
      const a = await relayCall(ctx, cfg, "reply", { pr: integer(args[0], "<pr>"), commentId: integer(args[1], "<comment-id>"), body: body(opts) });
      ctx.out(printable(str(a.url)));
      return 0;
    }
    case "read": {
      const a = await relayCall(ctx, cfg, "read", { number: integer(args[0], "<number>") });
      printThread(ctx, a.thread as Thread);
      return 0;
    }
    case "ci": {
      const pr = integer(args[0], "<pr>");
      if (args[1] !== undefined) {
        const a = await relayCall(ctx, cfg, "ci-log", { pr, job: integer(args[1], "<job-id>") });
        ctx.out(printableText(str(a.log)));
        return 0;
      }
      const a = await relayCall(ctx, cfg, "ci", { pr });
      const runs = (Array.isArray(a.runs) ? a.runs : []) as Record<string, unknown>[];
      for (const r of runs) ctx.out(printable(`${r.id}\t${str(r.name)}\t${str(r.status)}\t${r.conclusion ?? "-"}`));
      if (runs.length === 0) ctx.out("no runs");
      return 0;
    }
    default:
      throw new ForgeError(`unknown relay command '${sub}'\n${USAGE}`);
  }
}
