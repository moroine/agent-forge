// Attach core shared by `forge attach`, `forge start` and `forge resume`:
// make sure the container runs, then run the task's agent in this terminal.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { AGENT } from "./agent.ts";
import { isRunning } from "./containers.ts";
import { attachArgv, execAsAgentArgv, instanceStatus, startInstance } from "./incus.ts";
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
// no value is interpolated into the shell script.
export async function hasConversation(ctx: Context, container: string, task: string): Promise<boolean> {
  const r = await execAsAgentArgv(ctx, container, [
    "sh", "-c", 'ls "$1"/*.jsonl >/dev/null 2>&1', "sh", transcriptDir(task),
  ]);
  return r.code === 0;
}

export async function ensureRunning(ctx: Context, container: string): Promise<void> {
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
export async function attachTask(ctx: Context, container: string, task: string, ownerRepo?: string): Promise<number> {
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

// Stops the task's agent. `pkill -f` matches the full command line; the marker
// is anchored so task "a" never matches "a-b". Exit 1 means nothing was running.
export async function stopAgent(ctx: Context, container: string, task: string): Promise<void> {
  await execAsAgentArgv(ctx, container, ["pkill", "-f", "--", `${AGENT.marker(container, task)}( |$)`]);
}

// UTC YYYYMMDDTHHMMSSZ.
export function finishedStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// A reused task name must start a fresh conversation: move the transcripts
// aside instead of deleting them. Best effort, only warns.
export async function setTranscriptsAside(
  ctx: Context, container: string, task: string, now: Date = new Date(),
): Promise<void> {
  const r = await execAsAgentArgv(ctx, container, [
    "sh", "-c", '[ ! -d "$1" ] || mv "$1" "$1.finished-$2"', "sh", transcriptDir(task), finishedStamp(now),
  ]);
  if (r.code !== 0) {
    ctx.err(`WARNING: moving the transcripts of ${task} aside failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}
