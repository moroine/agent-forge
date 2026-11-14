// L'état occupé/libre d'un membre et l'assignation d'une tâche (DX 5, §5.3).
// L'état vit dans la config Incus du container (`user.forge.task` absent =
// libre) : il survit au redémarrage de forge et de l'hôte. Les règles sont
// refusées avant tout changement d'état : un refus ne laisse ni branche
// changée, ni clé posée, ni session lancée.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { baseKey } from "./containers.ts";
import { configGet, configSet, configUnset, execAsAgentArgv } from "./incus.ts";
import { clearMessages, startSession } from "./hc-session.ts";
import { ensureRunning } from "./session.ts";
import { members, memberNamed, type Member } from "./team.ts";
import { validateTaskName } from "./validate.ts";

export const TASK_KEY = "user.forge.task";
export const ASSIGNED_BY_KEY = "user.forge.assigned_by";
// Une tâche sans branche (un relecteur, le Pilote) : la valeur de TASK_KEY.
export const NO_BRANCH = "-";

export type Busy = { task: string; assignedBy: string } | null;

export async function busyState(ctx: Context, container: string): Promise<Busy> {
  const task = (await configGet(ctx, container, TASK_KEY)).trim();
  if (task === "") return null;
  const assignedBy = (await configGet(ctx, container, ASSIGNED_BY_KEY)).trim();
  return { task, assignedBy };
}

// Le membre de l'équipe qui possède la branche `agent/<task>` : celui dont la
// config porte la clé `base` de cette tâche. null si personne.
export async function owner(ctx: Context, cfg: ForgeConfig, team: string, task: string): Promise<string | null> {
  for (const m of members(cfg).filter((x) => x.team === team)) {
    if ((await configGet(ctx, m.name, baseKey(task))).trim() !== "") return m.name;
  }
  return null;
}

type AssignRequest = { to: string; task: string | null; text: string; by: string };

// Les règles d'abord (rien ne change tant qu'elles ne sont pas toutes passées),
// puis le container (démarré s'il était arrêté), puis le dépôt, puis l'état,
// puis une session neuve.
export async function assign(ctx: Context, cfg: ForgeConfig, req: AssignRequest): Promise<void> {
  const m = memberNamed(cfg, req.to);
  const publishes = m.capabilities.includes("publish");
  if (req.task !== null) validateTaskName(req.task);
  if (publishes && req.task === null) {
    throw new ForgeError(`${m.name} publishes branches: give it a task name (forge team assign ${m.name} <task>).`);
  }
  if (!publishes && req.task !== null) {
    throw new ForgeError(`${m.name} (role ${m.role}) has no publish capability: it takes a task without a branch.`);
  }
  const busy = await busyState(ctx, m.name);
  if (busy !== null) {
    throw new ForgeError(`${m.name} is busy with ${busy.task === NO_BRANCH ? "a task without a branch" : busy.task} ` +
      `(assigned by ${busy.assignedBy || "unknown"}): release it first.`);
  }
  let existing = false;
  if (req.task !== null && m.team !== null) {
    const holder = await owner(ctx, cfg, m.team, req.task);
    if (holder !== null && holder !== m.name) {
      throw new ForgeError(`task ${req.task} is already owned by ${holder}: one task name belongs to one developer.`);
    }
    existing = holder === m.name;
  }

  await ensureRunning(ctx, m.name);
  if (req.task !== null) await switchBranch(ctx, m, req.task, existing);

  await mustSucceed("record the task", configSet(ctx, m.name, TASK_KEY, req.task ?? NO_BRANCH));
  await mustSucceed("record who assigned it", configSet(ctx, m.name, ASSIGNED_BY_KEY, req.by));
  try {
    await startSession(ctx, m, req.task ?? NO_BRANCH, req.text);
  } catch (e) {
    // Une session qui ne démarre pas ne laisse pas le membre marqué occupé.
    await configUnset(ctx, m.name, TASK_KEY);
    await configUnset(ctx, m.name, ASSIGNED_BY_KEY);
    throw e;
  }
}

// Tout git passe par un argv, dans le container : l'hôte ne lance jamais git
// dans un dépôt d'agent.
async function switchBranch(ctx: Context, m: Member, task: string, existing: boolean): Promise<void> {
  const git = (...args: string[]) => execAsAgentArgv(ctx, m.name, ["git", "-C", "/workspace", ...args]);
  const status = await mustSucceed("git status", git("status", "--porcelain"));
  const dirty = status.stdout.split("\n").filter((l) => l.trim() !== "").length;
  if (dirty > 0) {
    throw new ForgeError(`${m.name}: /workspace has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}: ` +
      "commit or discard them before assigning a task.");
  }
  if (existing) {
    await mustSucceed(`switch to agent/${task}`, git("switch", `agent/${task}`));
    return;
  }
  await mustSucceed("git fetch origin", git("fetch", "origin"));
  await mustSucceed(`create agent/${task}`, git("switch", "-c", `agent/${task}`, "origin/main"));
  await mustSucceed("record the task's base", configSet(ctx, m.name, baseKey(task), "origin/main"));
}

// Libère un membre : par l'humain, ou par celui qui lui a confié la tâche.
export async function release(ctx: Context, cfg: ForgeConfig, req: { to: string; by: string }): Promise<void> {
  const m = memberNamed(cfg, req.to);
  const busy = await busyState(ctx, m.name);
  if (busy === null) throw new ForgeError(`${m.name} is already free.`);
  if (req.by !== "human" && req.by !== busy.assignedBy) {
    throw new ForgeError(`${m.name} was assigned by ${busy.assignedBy || "unknown"}: only that member or the human can release it.`);
  }
  await mustSucceed("clear the task", configUnset(ctx, m.name, TASK_KEY));
  await mustSucceed("clear who assigned it", configUnset(ctx, m.name, ASSIGNED_BY_KEY));
  await clearMessages(ctx, m.name);
}
