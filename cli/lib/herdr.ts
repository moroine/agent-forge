// Thin transport over herdr's CLI, the way incus.ts wraps Incus: every call is
// `ctx.exec([bin, ...])` and its JSON answer is parsed. Written against
// herdr 0.9.5; a differing answer surfaces as a ForgeError naming the command,
// never as a TypeError.
import { ForgeError, type Context } from "./context.ts";

export type HerdrEnv = { bin: string; popup: boolean };
export type Workspace = { id: string; label: string };
export type Tab = { id: string; label: string; workspaceId: string };
export type Pane = { id: string; tabId: string };
export type PaneState = "live" | "shell" | "busy";

// Inside a herdr pane or popup herdr sets HERDR_ENV=1 and HERDR_BIN_PATH;
// only panes also get HERDR_PANE_ID, so its absence means a popup.
export function herdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  if (env.HERDR_ENV !== "1" || !env.HERDR_BIN_PATH) return null;
  return { bin: env.HERDR_BIN_PATH, popup: !env.HERDR_PANE_ID };
}

// Marker thrown by `pick` callbacks for a missing field.
function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing field");
  return value;
}

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("not a string");
  return v;
};

// Runs one herdr command, checks the exit code, parses stdout, rejects an
// `error` object, and extracts the wanted fields with `pick`.
async function herdrJson<T>(
  ctx: Context,
  h: HerdrEnv,
  args: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: (result: any) => T,
  // Acks may answer with nothing at all (pane run does).
  allowEmpty = false,
): Promise<T> {
  const cmd = `herdr ${args.join(" ")}`;
  const r = await ctx.exec([h.bin, ...args]);
  if (r.code !== 0) {
    throw new ForgeError(`${cmd} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const unreadable = () => new ForgeError(`${cmd}: unreadable answer: ${r.stdout.trim()}`);
  if (allowEmpty && r.stdout.trim() === "") return pick(undefined);
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw unreadable();
  }
  if (parsed === null || typeof parsed !== "object") throw unreadable();
  if (parsed.error && typeof parsed.error === "object") {
    throw new ForgeError(`${cmd} failed: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  try {
    const value = pick(parsed.result);
    if (value === undefined) throw new Error("undefined");
    return value;
  } catch {
    throw unreadable();
  }
}

export function listWorkspaces(ctx: Context, h: HerdrEnv): Promise<Workspace[]> {
  return herdrJson(ctx, h, ["workspace", "list"], (r) =>
    need<any[]>(r.workspaces).map((w) => ({ id: str(w.workspace_id), label: str(w.label) })));
}

export function createWorkspace(
  ctx: Context, h: HerdrEnv, label: string, cwd: string,
): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
  return herdrJson(ctx, h, ["workspace", "create", "--label", label, "--cwd", cwd, "--focus"], (r) => ({
    workspaceId: str(r.workspace.workspace_id),
    tabId: str(r.tab.tab_id),
    paneId: str(r.root_pane.pane_id),
  }));
}

export function listTabs(ctx: Context, h: HerdrEnv): Promise<Tab[]> {
  return herdrJson(ctx, h, ["tab", "list"], (r) =>
    need<any[]>(r.tabs).map((t) => ({ id: str(t.tab_id), label: str(t.label), workspaceId: str(t.workspace_id) })));
}

export function listPanes(ctx: Context, h: HerdrEnv): Promise<Pane[]> {
  return herdrJson(ctx, h, ["pane", "list"], (r) =>
    need<any[]>(r.panes).map((p) => ({ id: str(p.pane_id), tabId: str(p.tab_id) })));
}

export function createTab(
  ctx: Context, h: HerdrEnv, workspaceId: string, label: string, cwd: string,
): Promise<{ tabId: string; paneId: string }> {
  return herdrJson(
    ctx, h,
    ["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", cwd, "--focus"],
    (r) => ({ tabId: str(r.tab.tab_id), paneId: str(r.root_pane.pane_id) }),
  );
}

// Acks: the answer is only checked for errors, then ignored.
const ack = () => true;

export async function renameTab(ctx: Context, h: HerdrEnv, tabId: string, label: string): Promise<void> {
  await herdrJson(ctx, h, ["tab", "rename", tabId, label], ack, true);
}

export async function focusTab(ctx: Context, h: HerdrEnv, tabId: string): Promise<void> {
  await herdrJson(ctx, h, ["tab", "focus", tabId], ack, true);
}

export async function closeTab(ctx: Context, h: HerdrEnv, tabId: string): Promise<void> {
  await herdrJson(ctx, h, ["tab", "close", tabId], ack, true);
}

// Types the command and Enter into the pane's shell.
export async function paneRun(ctx: Context, h: HerdrEnv, paneId: string, command: string): Promise<void> {
  await herdrJson(ctx, h, ["pane", "run", paneId, command], ack, true);
}

export function paneForeground(ctx: Context, h: HerdrEnv, paneId: string): Promise<string[][]> {
  return herdrJson(ctx, h, ["pane", "process-info", "--pane", paneId], (r) =>
    need<any[]>(r.process_info.foreground_processes).map((p) => {
      const argv = need<unknown[]>(p.argv);
      return argv.map(str);
    }));
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash"]);

// live: forge attach <container> <task> runs in the pane; shell: only bare
// shells run; busy: anything else (an empty list included).
export function classifyPane(foreground: string[][], container: string, task: string): PaneState {
  const isAttach = (argv: string[]) =>
    argv.some((a, i) => a === "attach" && argv[i + 1] === container && argv[i + 2] === task);
  if (foreground.some(isAttach)) return "live";
  const base = (argv: string[]) => (argv[0] ?? "").replace(/^.*\//, "").replace(/^-/, "");
  if (foreground.length > 0 && foreground.every((argv) => SHELLS.has(base(argv)))) return "shell";
  return "busy";
}
