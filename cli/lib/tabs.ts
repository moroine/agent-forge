// Runs a task's agent where the user is. Outside herdr this is the plain
// foreground attach; the herdr branch comes with sub-project 4's last tasks.
// This module imports session.ts, never the reverse.
import type { Context } from "./context.ts";
import { attachTask } from "./session.ts";

export type TaskRef = {
  container: string;
  // The container's stored `user.forge.repo`, not the argument as typed.
  ownerRepo: string;
  task: string;
};

export async function runTask(ctx: Context, t: TaskRef): Promise<number> {
  ctx.err("outside herdr: the agent stops when this terminal closes");
  return attachTask(ctx, t.container, t.task);
}
