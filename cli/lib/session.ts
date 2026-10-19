// Attach core shared by `forge attach`, `forge start` and `forge resume`:
// make sure the container runs, then run the task's agent in this terminal.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { AGENT } from "./agent.ts";
import { isRunning } from "./containers.ts";
import { attachArgv, execAsAgentArgv, instanceStatus, startInstance } from "./incus.ts";
import { egressAfterStart, egressBeforeStart, egressMode } from "./strict.ts";
import { probeRunningTasks, worktreeAbsPath } from "./worktrees.ts";

// Claude Code names a project's transcript folder after its path, every
// character outside [A-Za-z0-9] replaced by "-".
export function claudeSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptDir(task: string): string {
  return `/home/aiuser/.claude/projects/${claudeSlug(worktreeAbsPath(task))}`;
}

// A probe: the exit code is the answer, never an error. Path passed as $1 so
// no value is interpolated into the shell script. Only a non-empty .jsonl
// counts: an empty one gives `--continue` nothing to continue.
export async function hasConversation(ctx: Context, container: string, task: string): Promise<boolean> {
  const r = await execAsAgentArgv(ctx, container, [
    "sh", "-c", 'for f in "$1"/*.jsonl; do [ -s "$f" ] && exit 0; done; exit 1', "sh", transcriptDir(task),
  ]);
  return r.code === 0;
}

// Every path that starts a container goes through here (forge attach, start,
// resume, resume --all, finish). The egress check comes first, even on a
// running container (sub-project 3's contract): a too-old Incus or a
// marker/NIC disagreement is refused before any `incus start`, and a strict
// container gets its proxy started.
export async function ensureRunning(ctx: Context, container: string): Promise<void> {
  await egressBeforeStart(ctx, container);
  if (await isRunning(ctx, container)) return;
  const started = await startInstance(ctx, container);
  if (started.code === 0) return;
  // Another forge may have started it between our check and our start: only a
  // container that is still not Running makes this a failure.
  if ((await instanceStatus(ctx, container)) === "Running") return;
  await mustSucceed("incus start", Promise.resolve(started));
}

// Never two agents in one worktree (spec anti-goal). Every attach path ends
// here (forge attach, start and resume outside herdr), so the guard sits here,
// and fails closed: a probe that cannot answer refuses too. `ownerRepo` is the
// stored `user.forge.repo`, when the caller has it.
//
// First, the strict settings follow the container's mode (sub-project 3's
// contract): applied for strict, removed for open. The mode is read, never
// changed, and the same idempotent step runs on every path to the agent —
// herdr tabs and resume --all included, which never go through start/resume.
export async function attachTask(ctx: Context, container: string, task: string, ownerRepo?: string): Promise<number> {
  await egressAfterStart(ctx, container, await egressMode(ctx, container));
  const probe = await probeRunningTasks(ctx, container);
  if (!probe.ok) {
    throw new ForgeError(`cannot check whether the agent for ${task} already runs in ${container}: ${probe.error}`);
  }
  if (probe.tasks.has(task)) {
    const way = ownerRepo
      ? `stop it first with 'forge stop ${ownerRepo}'`
      : "stop the container first with 'forge stop'";
    throw new ForgeError(
      `the agent for ${task} already runs in ${container} (in a herdr tab, or another terminal): attach to it there, or ${way}.`,
    );
  }
  const resume = await hasConversation(ctx, container, task);
  return ctx.attach(
    attachArgv(container, task, process.env.TERM ?? "xterm-256color", AGENT.command(container, task, resume)),
    { env: { HERDR_AGENT: AGENT.herdrLabel } },
  );
}

// Every ERE metacharacter, escaped: task names allow ".", so "v1.2" must not
// also match "v1x2".
function ereEscape(s: string): string {
  return s.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
}

// Stops the task's agent, and returns once it is gone: the caller removes the
// worktree that is the agent's cwd. `pkill -f` matches the full command line
// against an extended regex; the marker is escaped, and anchored so task "a"
// never matches "a-b". Exit 1 means nothing was running; 2 and above are a
// failure. A probe that cannot answer counts as still running.
export async function stopAgent(
  ctx: Context, container: string, task: string, opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const r = await execAsAgentArgv(ctx, container, ["pkill", "-f", "--", `${ereEscape(AGENT.marker(container, task))}( |$)`]);
  if (r.code === 1) return;
  if (r.code !== 0) {
    throw new ForgeError(`stopping the agent for ${task} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 250;
  for (let i = 1; ; i++) {
    const probe = await probeRunningTasks(ctx, container);
    if (probe.ok && !probe.tasks.has(task)) return;
    if (i >= attempts) break;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new ForgeError(
    `the agent for ${task} still runs in ${container} after SIGTERM: its worktree stays. ` +
    "Stop the container ('forge stop --force'), then run this again.");
}

// UTC YYYYMMDDTHHMMSSZ.
export function finishedStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// A reused task name must start a fresh conversation: move the transcripts
// aside instead of deleting them. Best effort, only warns. An aside folder of
// the same second already there is never moved into.
const ASIDE = '[ ! -d "$1" ] || { [ ! -e "$1.finished-$2" ] || { echo "$1.finished-$2 already exists" >&2; exit 1; }; ' +
  'mv "$1" "$1.finished-$2"; }';

export async function setTranscriptsAside(
  ctx: Context, container: string, task: string, now: Date = new Date(),
): Promise<void> {
  const r = await execAsAgentArgv(ctx, container, ["sh", "-c", ASIDE, "sh", transcriptDir(task), finishedStamp(now)]);
  if (r.code !== 0) {
    ctx.err(`WARNING: moving the transcripts of ${task} aside failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}
