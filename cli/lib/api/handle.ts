// Les cinq verbes de l'API (DX 5, §5.4) : le verbe, ses règles de capacités,
// puis les fonctions de l'hôte de la partie 1. L'appelant vient de la socket
// par laquelle la connexion est arrivée, jamais de la requête. Chaque appel
// laisse une ligne au journal, accepté ou refusé, avec sa raison.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import type { ForgeConfig } from "../config.ts";
import { deliverMessage, sessionState } from "../hc-session.ts";
import { assign, busyState, NO_BRANCH, release } from "../tasks.ts";
import { refreshTeamMirror } from "../team-mirror.ts";
import { memberNamed, type Member } from "../team.ts";
import { Journal, waitingOn, type Entry } from "./journal.ts";
import { parseRequest, type ApiRequest } from "./protocol.ts";

export type ApiDeps = { ctx: Context; cfg: ForgeConfig; journal: Journal; secrets: readonly string[]; now: () => Date };
export type ApiReply = { ok: true; [k: string]: unknown } | { ok: false; error: string };

// `assign` et `release` passent un à la fois, tous appelants confondus : deux
// Leads qui confient le même développeur libre au même instant ne le voient pas
// libre tous les deux. Les autres verbes n'attendent personne.
let exclusiveChain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = exclusiveChain.then(fn, fn);
  exclusiveChain = run.catch(() => {});
  return run;
}

const MIRROR_WARNING = "the team mirror could not be refreshed: your branch may not be readable yet";

export async function handleRequest(d: ApiDeps, caller: Member, line: string): Promise<ApiReply> {
  let req: ApiRequest;
  try {
    req = parseRequest(line, d.secrets);
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    d.journal.append(entryFields(caller, null, "refused", e.message), d.now());
    return { ok: false, error: e.message };
  }
  // L'identifiant d'un message se prend avant sa livraison : un refus de la
  // livraison le garde.
  let reserved: number | undefined;
  try {
    const done = await run(d, caller, req, (id) => { reserved = id; });
    const entry = d.journal.append(entryFields(caller, req, "ok", null), d.now(), done.id);
    return done.reply(entry.id);
  } catch (e) {
    if (e instanceof ForgeError) {
      d.journal.append(entryFields(caller, req, "refused", e.message), d.now(), reserved);
      return { ok: false, error: e.message };
    }
    d.journal.append(entryFields(caller, req, "refused", "internal error"), d.now(), reserved);
    throw e;
  }
}

function entryFields(caller: Member, req: ApiRequest | null, outcome: Entry["outcome"], error: string | null): Omit<Entry, "id" | "time"> {
  return {
    caller: caller.name, op: req?.op ?? null,
    to: req !== null && "to" in req ? req.to : null,
    task: req?.op === "assign" ? req.task : null,
    outcome, error,
    summary: req !== null && "summary" in req ? req.summary : null,
    text: req === null ? null : req.op === "assign" ? req.text : "body" in req ? req.body : null,
  };
}

type Done = { reply: (id: number) => ApiReply; id?: number };

async function run(d: ApiDeps, caller: Member, req: ApiRequest, reserve: (id: number) => void): Promise<Done> {
  const { ctx, cfg } = d;
  const mayTalkTo = (to: string) => {
    if (!caller.talkTo.includes(to)) throw new ForgeError(`${caller.name} may not talk to ${to}`);
  };
  const needCapability = (capability: "assign" | "ask-human") => {
    if (!caller.capabilities.includes(capability)) throw new ForgeError(`${caller.name} has no ${capability} capability`);
  };
  switch (req.op) {
    case "message": {
      mayTalkTo(req.to);
      // Un message n'est jamais mis en file : sans session vivante, il est refusé.
      const state = await sessionState(ctx, req.to);
      if (state === "none" || state === "exited") throw new ForgeError(`${req.to} has no live session`);
      // Le commit qu'un développeur annonce doit être lisible quand son Lead
      // reçoit le message ; un échec n'arrête pas le message, il se dit.
      let warning: string | null = null;
      if (caller.capabilities.includes("publish") && caller.team !== null) {
        try {
          const r = await refreshTeamMirror(ctx, cfg, caller.team);
          if (r.failed.includes(caller.name)) warning = MIRROR_WARNING;
        } catch {
          warning = MIRROR_WARNING;
        }
      }
      const id = d.journal.reserve();
      reserve(id);
      await deliverMessage(ctx, req.to, caller.name, id, req.summary, req.body);
      return { id, reply: (n) => ({ ok: true, id: n, ...(warning === null ? {} : { warning }) }) };
    }
    case "assign":
      needCapability("assign");
      mayTalkTo(req.to);
      await exclusive(() => assign(ctx, cfg, { to: req.to, task: req.task, text: req.text, by: caller.name }));
      return { reply: (id) => ({ ok: true, id }) };
    case "release":
      await exclusive(() => release(ctx, cfg, { to: req.to, by: caller.name }));
      return { reply: (id) => ({ ok: true, id }) };
    case "ask-human":
      needCapability("ask-human");
      return { reply: (id) => ({ ok: true, id }) };
    case "status": {
      const team: Record<string, unknown>[] = [];
      for (const name of caller.talkTo) {
        const m = memberNamed(cfg, name);
        const busy = await busyState(ctx, name);
        const session = await sessionState(ctx, name);
        team.push({
          name, role: m.role, busy: busy !== null,
          task: busy === null || busy.task === NO_BRANCH ? null : busy.task,
          session, waitingOn: session === "working" ? null : waitingOn(d.journal.entries(), name),
        });
      }
      return { reply: () => ({ ok: true, team }) };
    }
  }
}
