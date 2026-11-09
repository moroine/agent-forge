// The relay's front door. The dev VM reaches the relay through an SSH forced
// command: the operation name comes from SSH_ORIGINAL_COMMAND, one JSON request
// from stdin, and one JSON line goes back. Everything that arrives here comes
// from an agent, so it is validated before any other work, and the order of a
// write is always: text checks, secret scan, write cap, then GitHub.
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RelayError } from "./config.ts";
import { ciLog, ciRuns, comment, openPull, readThread, reply } from "./github.ts";
import type { RelayPaths } from "./paths.ts";
import { validTask } from "./policy.ts";
import { publish, type RelayDeps } from "./publish.ts";
import { scanText } from "./scan.ts";
import { takeAttempt, takeWrite, withState } from "./state.ts";
import { checkPublicText } from "./text.ts";

export const OPS = ["publish", "open-pr", "comment", "reply", "read", "ci", "ci-log"] as const;
type Op = (typeof OPS)[number];

const TITLE_MAX = 256;
const PR_BODY_MAX = 20_000;
const COMMENT_MAX = 10_000;
// An issue or pull request number. GitHub's comment and job IDs are far
// larger (review comments near 2e9, Actions jobs past 1e10): they are `id`s,
// bounded only by what a JSON number holds exactly.
const MAX_NUMBER = 1e9;

// The exact fields of each request; the kind says how each is validated.
const FIELDS: Record<Op, Record<string, "string" | "int" | "id">> = {
  publish: { branch: "string", bundle: "string" },
  "open-pr": { branch: "string", title: "string", body: "string" },
  comment: { pr: "int", body: "string" },
  reply: { pr: "int", commentId: "id", body: "string" },
  read: { number: "int" },
  ci: { pr: "int" },
  "ci-log": { pr: "int", job: "id" },
};

type Request = Record<string, string | number>;

// One audit line per request. It holds validated identifiers, sizes and
// digests, never a text the agent wrote, a message derived from one, a token
// or a bundle's content (ruling R17).
type Audit = Record<string, unknown>;

const digest = (text: string) => ({ length: text.length, sha256: createHash("sha256").update(text).digest("hex") });

function parseRequest(op: Op, input: Buffer): Request {
  let json: unknown;
  try {
    json = JSON.parse(input.toString("utf8"));
  } catch {
    throw new RelayError("the request is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new RelayError("the request must be a JSON object");
  const fields = FIELDS[op];
  const o = json as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !Object.hasOwn(fields, k));
  if (extra.length > 0) throw new RelayError(`${op}: unknown field${extra.length > 1 ? "s" : ""}: ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}`);
  for (const [name, kind] of Object.entries(fields)) {
    const v = o[name];
    if (kind === "string" && typeof v !== "string") throw new RelayError(`${op}: ${name} must be a string`);
    if (kind === "int" && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_NUMBER)) {
      throw new RelayError(`${op}: ${name} must be an integer between 1 and ${MAX_NUMBER}`);
    }
    if (kind === "id" && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 1)) {
      throw new RelayError(`${op}: ${name} must be a positive integer of at most ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  return o as Request;
}

// A base64 field, strictly: the alphabet, padding only at the end, a length
// that is a multiple of four. Linear checks only: the field can be 64 MiB.
function decodeBundle(s: string): Buffer {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new RelayError("publish: bundle is not base64");
  const b = Buffer.from(s, "base64");
  if (b.length === 0) throw new RelayError("publish: the bundle is empty");
  return b;
}

// A text the bot will post: length and mention checks, then Betterleaks. A
// finding refuses it: the agent rewrites it, nothing is cleared.
async function publicText(d: RelayDeps, text: string, max: number, what: string): Promise<string> {
  // The cap comes first: the reference and mention checks are quadratic on
  // crafted input, and neutralizing only lengthens a text, so this refuses
  // nothing that would have passed.
  if (text.length > max) throw new RelayError(`${what}: longer than ${max} characters`);
  const out = checkPublicText(text, d.cfg, max, what);
  const findings = await scanText(d.ctx, out, d.paths.mirror);
  if (findings.length > 0) {
    throw new RelayError(`Betterleaks found a possible secret in the ${what} (rule ${findings[0].rule}): nothing was sent; rewrite it without the secret`);
  }
  return out;
}

// Counts one write under the state lock, after every check passed. The lock
// is released before the GitHub call: it is not held across the network.
async function takeWriteSlot(d: RelayDeps, branchTask?: string): Promise<void> {
  await withState(d.paths.stateDir, async (s) => {
    if (branchTask !== undefined && s.published[branchTask] === undefined) {
      throw new RelayError(`agent/${branchTask} has not been published by the relay: publish it first`);
    }
    takeWrite(s, d.now(), d.cfg.writesPerHour);
  });
}

async function handle(d: RelayDeps, op: Op, input: Buffer, audit: Audit): Promise<Record<string, unknown>> {
  const r = parseRequest(op, input);
  switch (op) {
    case "publish": {
      // The branch is logged once validTask accepted it: before, it is agent text.
      audit.branch = `agent/${validTask(r.branch as string)}`;
      // The attempt is counted first, under a short lock of its own, released
      // before publish takes its lock (the lock is not reentrant).
      await withState(d.paths.stateDir, async (s) => takeAttempt(s, d.now()));
      const bundle = decodeBundle(r.bundle as string);
      audit.bundleBytes = bundle.length;
      // publish takes the state lock and counts its own write.
      const out = await publish(d, { branch: r.branch as string, bundle });
      return { head: out.head, url: out.url, bundle: out.bundle.toString("base64") };
    }
    case "open-pr": {
      audit.title = digest(r.title as string);
      audit.body = digest(r.body as string);
      const task = validTask(r.branch as string);
      audit.branch = `agent/${task}`;
      const title = await publicText(d, r.title as string, TITLE_MAX, "pull request title");
      const body = await publicText(d, r.body as string, PR_BODY_MAX, "pull request body");
      await takeWriteSlot(d, task);
      return await openPull(d.github, d.cfg, task, title, body);
    }
    case "comment": {
      audit.pr = r.pr;
      audit.body = digest(r.body as string);
      const body = await publicText(d, r.body as string, COMMENT_MAX, "comment");
      await takeWriteSlot(d);
      return await comment(d.github, d.cfg, r.pr as number, body);
    }
    case "reply": {
      audit.pr = r.pr;
      audit.commentId = r.commentId;
      audit.body = digest(r.body as string);
      const body = await publicText(d, r.body as string, COMMENT_MAX, "reply");
      await takeWriteSlot(d);
      return await reply(d.github, d.cfg, r.pr as number, r.commentId as number, body);
    }
    case "read":
      audit.number = r.number;
      return { thread: await readThread(d.github, d.cfg, r.number as number) };
    case "ci":
      audit.pr = r.pr;
      return { runs: await ciRuns(d.github, d.cfg, r.pr as number) };
    case "ci-log":
      audit.pr = r.pr;
      audit.job = r.job;
      return { log: await ciLog(d.github, d.cfg, r.pr as number, r.job as number) };
  }
}

// The audit file is created private. A failure to append is reported on
// stderr and never hides the operation's answer.
type Sink = { paths: RelayPaths; err: (line: string) => void; now: () => number };

async function writeAudit(io: Sink, line: Audit): Promise<void> {
  try {
    await mkdir(path.dirname(io.paths.audit), { recursive: true, mode: 0o700 });
    await appendFile(io.paths.audit, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (e) {
    // The code only: an errno message names a path.
    io.err(`forge-relay: cannot write the audit log (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

// The answer to a failure, and its audit line. A refusal's message goes back
// to the agent; the audit keeps only that it was a refusal and the message's
// length and digest. Any other error answers generically, and its stack goes
// to the audit log only.
export async function fail(io: Sink, audit: Audit, e: unknown): Promise<string> {
  let message: string;
  if (e instanceof RelayError) {
    audit.outcome = "refused";
    audit.detail = "refused";
    message = e.message;
  } else {
    audit.outcome = "error";
    audit.detail = "error";
    audit.stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    message = "internal error (logged on the relay)";
  }
  audit.message = digest(message);
  await writeAudit(io, audit);
  return `${JSON.stringify({ ok: false, error: message })}\n`;
}

// An audit line for a request that failed before `serve` ran (too large, no
// configuration): the operation as given only when it is one of OPS.
export function auditFor(io: Sink, op: string | undefined): Audit {
  return { time: new Date(io.now()).toISOString(), op: op !== undefined && (OPS as readonly string[]).includes(op) ? op : "unknown" };
}

export async function serve(d: RelayDeps, op: string | undefined, input: Buffer): Promise<string> {
  const io: Sink = { paths: d.paths, err: d.ctx.err, now: d.now };
  const audit = auditFor(io, op);
  try {
    if (op === undefined || !(OPS as readonly string[]).includes(op)) throw new RelayError(`unknown operation; the operations are ${OPS.join(", ")}`);
    const answer = { ok: true, ...(await handle(d, op as Op, input, audit)) };
    audit.outcome = "ok";
    await writeAudit(io, audit);
    return `${JSON.stringify(answer)}\n`;
  } catch (e) {
    return fail(io, audit, e);
  }
}
