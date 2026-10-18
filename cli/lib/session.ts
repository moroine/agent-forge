// Attach core shared by `forge attach`, `forge start` and `forge resume`:
// make sure the container runs, then run the task's agent in this terminal.
import type { Context } from "./context.ts";
import { mustSucceed } from "./context.ts";
import { AGENT } from "./agent.ts";
import { isRunning } from "./containers.ts";
import { attachArgv, execAsAgentArgv, instanceStatus, startInstance } from "./incus.ts";
import { worktreeAbsPath } from "./worktrees.ts";

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

export async function attachTask(ctx: Context, container: string, task: string): Promise<number> {
  const resume = await hasConversation(ctx, container, task);
  return ctx.attach(
    attachArgv(container, task, process.env.TERM ?? "xterm-256color", AGENT.command(container, task, resume)),
    { env: { HERDR_AGENT: AGENT.herdrLabel } },
  );
}
