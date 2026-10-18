// Runs a task's agent where the user is. Outside herdr this is the plain
// foreground attach; inside herdr the task gets a tab in its repo's workspace.
// This module imports session.ts, never the reverse.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { AGENT } from "./agent.ts";
import {
  classifyPane, createTab, createWorkspace, focusTab, herdrEnv, listPanes,
  listTabs, listWorkspaces, paneForeground, paneRun, renameTab,
  type HerdrEnv, type Pane, type PaneState, type Tab, type Workspace,
} from "./herdr.ts";
import { forgeCommand, forgeHome } from "./paths.ts";
import { attachTask } from "./session.ts";
import { runningTasks } from "./worktrees.ts";

export type TaskRef = {
  container: string;
  // The container's stored `user.forge.repo`, not the argument as typed.
  ownerRepo: string;
  task: string;
};

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

// What is typed into the tab's shell. `exec` makes the agent replace the shell,
// so closing the agent closes the pane's process. Container and task are
// validated names.
export function attachCommand(container: string, task: string): string {
  return `exec env HERDR_AGENT=${AGENT.herdrLabel} ${shellQuote(forgeCommand())} attach ${container} ${task}`;
}

// The workspace is matched case-insensitively (a repo typed in another case is
// the same repo), the tab label exactly. First match wins, with a note.
export async function findTaskTab(
  ctx: Context, h: HerdrEnv, ownerRepo: string, task: string,
): Promise<{ workspace: Workspace | null; tab: Tab | null; panes: Pane[] }> {
  const wanted = ownerRepo.toLowerCase();
  const workspaces = (await listWorkspaces(ctx, h)).filter((w) => w.label.toLowerCase() === wanted);
  if (workspaces.length > 1) ctx.err(`several herdr workspaces are labelled ${ownerRepo}; using the first`);
  const workspace = workspaces[0] ?? null;
  const allTabs = await listTabs(ctx, h);
  const allPanes = await listPanes(ctx, h);
  if (!workspace) return { workspace: null, tab: null, panes: [] };
  const matching = allTabs.filter((t) => t.workspaceId === workspace.id && t.label === task);
  if (matching.length > 1) ctx.err(`several herdr tabs are labelled ${task} in ${ownerRepo}; using the first`);
  const tab = matching[0] ?? null;
  return { workspace, tab, panes: tab ? allPanes.filter((p) => p.tabId === tab.id) : [] };
}

// Opens or focuses the task's tab in herdr (spec: "Starting or reopening a
// task inside herdr").
export async function openTask(ctx: Context, h: HerdrEnv, t: TaskRef): Promise<number> {
  const running = (await runningTasks(ctx, t.container)).has(t.task);
  const { workspace, tab, panes } = await findTaskTab(ctx, h, t.ownerRepo, t.task);

  // live if any pane runs the attach, otherwise the first pane's state.
  let state: PaneState = "busy";
  let busyArgv0 = "";
  const states: PaneState[] = [];
  const fgs: string[][][] = [];
  for (const p of panes) {
    const fg = await paneForeground(ctx, h, p.id);
    fgs.push(fg);
    states.push(classifyPane(fg, t.container, t.task));
  }
  if (states.includes("live")) state = "live";
  else if (states.length > 0) state = states[0];
  if (state === "busy") busyArgv0 = fgs[0]?.[0]?.[0] ?? "nothing";

  const label = `${t.ownerRepo} ${t.task}`;
  if (state === "live") {
    await focusTab(ctx, h, (tab as Tab).id);
    ctx.err(`Focused ${label} in herdr.`);
    return 0;
  }
  if (running) {
    throw new ForgeError(`the agent for ${t.task} already runs outside this herdr (another terminal?): stop it there first.`);
  }
  if (tab && state === "busy") {
    throw new ForgeError(
      `herdr tab ${t.task} in ${t.ownerRepo} is busy (it runs ${busyArgv0}): close it or free its shell, then run this again.`,
    );
  }

  const command = attachCommand(t.container, t.task);
  if (tab) {
    await paneRun(ctx, h, panes[0].id, command);
    await focusTab(ctx, h, tab.id);
  } else if (workspace) {
    const created = await createTab(ctx, h, workspace.id, t.task, forgeHome());
    await paneRun(ctx, h, created.paneId, command);
  } else {
    const created = await createWorkspace(ctx, h, t.ownerRepo, forgeHome());
    await renameTab(ctx, h, created.tabId, t.task);
    await paneRun(ctx, h, created.paneId, command);
  }
  ctx.err(`Opened ${label} in herdr.`);
  return 0;
}

export async function runTask(ctx: Context, t: TaskRef): Promise<number> {
  const h = herdrEnv();
  if (h) return openTask(ctx, h, t);
  ctx.err("outside herdr: the agent stops when this terminal closes");
  return attachTask(ctx, t.container, t.task);
}
