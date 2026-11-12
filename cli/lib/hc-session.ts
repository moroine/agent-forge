// Les sessions d'un membre d'équipe tournent dans le core hc de son container
// (DX 5, §5.8) : forge les pilote par `incus exec` avec un argv, jamais par un
// shell. Le texte d'une consigne arrive comme fichier, jamais dans un argv.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import { incus, pushText } from "./incus.ts";
import { egressAfterStart, egressBeforeStart } from "./strict.ts";
import type { Member } from "./team.ts";

// Le nom du terminal hc de l'agent, le même dans chaque container.
export const SESSION = "agent";
export const INSTRUCTION_PATH = "/home/aiuser/.forge/instruction.md";
// Les étiquettes par lesquelles Herdr App range un terminal (guide de l'app,
// `~/.config/herdr-app/AGENTS.md`, « The model »).
const HERDR_SPACE_LABEL = "herdr.space";
const HERDR_TAB_LABEL = "herdr.tab";

// `hc` en tant qu'aiuser, dans /workspace, avec ce qu'il faut pour joindre son
// core (le bus de session de l'utilisateur) sans passer par un shell de login.
export function hcArgv(container: string, args: string[]): string[] {
  return incus("exec", container,
    "--user", "1001", "--group", "1001", "--cwd", "/workspace",
    "--env", "HOME=/home/aiuser",
    "--env", "XDG_RUNTIME_DIR=/run/user/1001",
    "--env", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus",
    "--", "hc", ...args);
}

export type SessionState = "none" | "idle" | "working" | "done" | "exited" | "unknown";

// `hc get agent` : un code non nul veut dire qu'il n'y a pas de terminal. Un
// terminal dont le programme est sorti reste listé par hc (`"state":"finished"`,
// sans statut) : c'est une session morte, `exited`, pas un état inconnu.
export async function sessionState(ctx: Context, container: string): Promise<SessionState> {
  return (await sessionInfo(ctx, container)).state;
}

async function sessionInfo(ctx: Context, container: string): Promise<{ state: SessionState; exitCode: unknown }> {
  const r = await ctx.exec(hcArgv(container, ["get", SESSION]));
  if (r.code !== 0) return { state: "none", exitCode: null };
  try {
    const t = JSON.parse(r.stdout) as { state?: unknown; exit_code?: unknown; status?: { state?: unknown } | null };
    if (t.state === "finished") return { state: "exited", exitCode: t.exit_code };
    const state = t.status?.state;
    return { state: state === "idle" || state === "working" || state === "done" ? state : "unknown", exitCode: null };
  } catch {
    return { state: "unknown", exitCode: null };
  }
}

// Un agent qui meurt au démarrage (une option refusée, un token absent) se dit
// tout de suite, plutôt qu'un « Assigned » trompeur : quelques regards pendant
// environ 3 s. Un statut (OSC 7501) montre que l'agent a démarré ; sans statut
// ni sortie au bout du délai, rien ne prouve un échec.
const STARTUP_LOOKS = 6;
const STARTUP_STEP_MS = 500;

async function requireStarted(ctx: Context, container: string): Promise<void> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < STARTUP_LOOKS; i++) {
    await sleep(STARTUP_STEP_MS);
    const s = await sessionInfo(ctx, container);
    if (s.state === "exited") {
      const code = typeof s.exitCode === "number" ? String(s.exitCode) : "unknown";
      throw new ForgeError(`${container}'s agent stopped as soon as it started (exit code ${code}). ` +
        "Read its screen in the forge space of its Herdr App machine, or with hc read <machine>/agent from your machine.");
    }
    if (s.state === "idle" || s.state === "working" || s.state === "done") return;
  }
}

// Une session neuve : l'ancienne (s'il y en a une) est tuée et retirée, la
// consigne est poussée comme fichier, puis `hc run` lance forge-agent, qui la
// lit et la donne à claude comme premier message. `task` est le nom de la
// branche, ou `-` pour une tâche sans branche ; le marqueur `--forge-task` suit
// la forme `<container>-<tâche>` que `forge list` et `forge stop` lisent.
export async function startSession(ctx: Context, m: Member, task: string, instruction: string): Promise<void> {
  const mode = await egressBeforeStart(ctx, m.name);
  await egressAfterStart(ctx, m.name, mode);
  // Leur échec est sans importance : il n'y avait peut-être pas de session.
  await ctx.exec(hcArgv(m.name, ["kill", SESSION]));
  await ctx.exec(hcArgv(m.name, ["rm", SESSION]));
  await mustSucceed("push the instruction",
    pushText(ctx, m.name, INSTRUCTION_PATH, instruction, { uid: 1001, gid: 1001, mode: "600" }));
  const marker = `${m.name}-${task === "-" ? "session" : task}`;
  await mustSucceed("hc run", ctx.exec(hcArgv(m.name, [
    "run", "--bg", "--name", SESSION, "--cwd", "/workspace",
    // Herdr App ne montre que les terminaux étiquetés par un espace et un
    // onglet ; des ids qu'il ne connaît pas deviennent un espace et un onglet
    // neufs. Les mêmes ids à chaque tâche : la session suivante retombe au
    // même endroit.
    "--label", `${HERDR_SPACE_LABEL}=forge`, "--label", `${HERDR_TAB_LABEL}=agent`,
    // L'ordre que forge-agent lit : --forge-task, puis --instruction-file, puis
    // les arguments de claude.
    "forge-agent", "--forge-task", marker, "--instruction-file", INSTRUCTION_PATH, "--permission-mode", "auto",
  ])));
  await requireStarted(ctx, m.name);
}
