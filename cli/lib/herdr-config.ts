// The herdr key bindings forge installs (spec "forge setup: the herdr config
// block"). herdr has no include mechanism, so `forge setup` owns a delimited,
// idempotent block in the forge user's herdr config. The block is always kept
// LAST in the file: a bare TOML key written after it would land in its last
// [[keys.command]] table (herdr 0.9.5: "unknown config key keys.command.0.bogus").
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError, type Context } from "./context.ts";
import { forgeCommand, forgeHome, herdrConfigPath } from "./paths.ts";
import { shellQuote } from "./shell.ts";

export const BLOCK_START = "# >>> agent-forge >>>";
export const BLOCK_END = "# <<< agent-forge <<<";

// The two keys forge binds.
const KEYS = ["prefix+f", "prefix+shift+f"];

// A TOML basic string: only backslash and double quote need escaping for a
// path we accept; a control character cannot be represented, so it is refused.
function tomlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ForgeError(`${value}: a control character cannot go in the herdr config`);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function binding(key: string, command: string, description: string): string[] {
  return [
    "[[keys.command]]",
    `key = "${key}"`,
    'type = "popup"',
    `command = ${tomlString(command)}`,
    `description = "${description}"`,
    'width = "90%"',
    'height = "90%"',
  ];
}

// The block, with \n line endings, ending with a newline.
export function renderBlock(forge: string): string {
  const q = shellQuote(forge);
  return [
    BLOCK_START,
    "# Managed by `forge setup`: edits inside this block are overwritten.",
    "# Keep your own settings above it.",
    ...binding("prefix+f", `${q} start`, "forge: start or open a task"),
    "",
    ...binding("prefix+shift+f", `${q} resume --all`, "forge: resume agents stopped by a herdr restart"),
    BLOCK_END,
    "",
  ].join("\n");
}

type Line = { start: number; end: number; text: string };

// Lines with their byte offsets; `end` includes the line terminator, `text`
// excludes \n and a trailing \r (so CRLF markers are still found).
function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ start, end, text: text.slice(start, nl === -1 ? end : nl).replace(/\r$/, "") });
    start = end;
  }
  return out;
}

// Locates the block: [from, to) covers the start-marker line through the
// end-marker line, terminator included. Null when there is none.
function findBlock(text: string): { from: number; to: number } | null {
  const ls = lines(text);
  const starts = ls.filter((l) => l.text === BLOCK_START);
  const ends = ls.filter((l) => l.text === BLOCK_END);
  if (starts.length > 1) throw new Error("more than one agent-forge block: remove the extra ones by hand");
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length === 0) throw new Error(`found "${BLOCK_END}" without a start marker in the agent-forge block`);
  if (ends.length === 0 || ends[ends.length - 1].start < starts[0].start) {
    throw new Error(`found "${BLOCK_START}" without an end marker in the agent-forge block`);
  }
  const end = ends.find((l) => l.start > starts[0].start)!;
  return { from: starts[0].start, to: end.end };
}

export function spliceBlock(
  text: string, block: string,
): { text: string; outcome: "created" | "updated" | "unchanged" } {
  const found = findBlock(text);
  if (!found) {
    if (text === "") return { text: block, outcome: "created" };
    const sep = (text.endsWith("\n") ? "" : "\n") + "\n";
    return { text: text + sep + block, outcome: "created" };
  }
  const existing = text.slice(found.from, found.to);
  // The block may have lost its final newline (end marker at end of file).
  const normalised = existing.replaceAll("\r\n", "\n");
  if (normalised === block || normalised + "\n" === block) return { text, outcome: "unchanged" };
  return { text: text.slice(0, found.from) + block + text.slice(found.to), outcome: "updated" };
}

// Keys forge binds that the user also binds outside the block.
export function conflictingKeys(text: string): string[] {
  const found = findBlock(text);
  const outside = found ? text.slice(0, found.from) + text.slice(found.to) : text;
  const keys = new Set<string>();
  for (const l of lines(outside)) {
    const m = /^\s*key\s*=\s*"([^"]*)"\s*$/.exec(l.text);
    if (m && KEYS.includes(m[1])) keys.add(m[1]);
  }
  return [...keys];
}

function readConfig(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

// Atomic write: temp file next to the target, then rename. The mode of an
// existing file is kept; a new file is 0644 and its directory 0700. A
// symlinked config (stow, chezmoi) stays a link: the file it points to is
// the one replaced.
function writeConfig(configPath: string, text: string): void {
  const path = existsSync(configPath) ? realpathSync(configPath) : configPath;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.forge-tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

// HERDR_BIN_PATH, then forge's own install location, then the PATH.
async function findHerdr(ctx: Context): Promise<string | null> {
  const fromEnv = process.env.HERDR_BIN_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(forgeHome(), ".local", "bin", "herdr");
  if (existsSync(local)) return local;
  return (await ctx.exec(["herdr", "--version"])).code === 0 ? "herdr" : null;
}

export async function ensureHerdrConfig(ctx: Context): Promise<void> {
  const path = herdrConfigPath();
  const text = readConfig(path);
  let spliced;
  try {
    spliced = spliceBlock(text, renderBlock(forgeCommand()));
  } catch (e) {
    throw new ForgeError(`${path}: ${(e as Error).message}`);
  }
  if (spliced.outcome !== "unchanged") writeConfig(path, spliced.text);
  ctx.out(`herdr config ${path}: ${spliced.outcome}`);
  for (const key of conflictingKeys(spliced.text)) {
    ctx.err(`WARNING: ${path} also binds ${key} outside forge's block; herdr may run either.`);
  }

  const bin = await findHerdr(ctx);
  if (!bin) {
    ctx.err("NOTICE: herdr is not installed on this host yet: the bindings apply once `herdr --remote` installs it.");
    return;
  }

  // `config check` reports problems with the whole file, not only our block.
  const check = await ctx.exec([bin, "config", "check"], { env: { HERDR_CONFIG_PATH: path } });
  for (const line of `${check.stdout}\n${check.stderr}`.split("\n").map((l) => l.trim())) {
    if (line && line !== "config: ok" && line !== "config: issues found") {
      ctx.err(`WARNING: herdr config check: ${line}`);
    }
  }

  // Make a running server pick the bindings up.
  const reload = await ctx.exec([bin, "server", "reload-config"], { env: { HERDR_CONFIG_PATH: path } });
  let parsed: { result?: { status?: string }; error?: { code?: string } } | null = null;
  try { parsed = JSON.parse(reload.stdout); } catch { /* reported below */ }
  if (parsed?.result?.status === "applied") return;
  if (parsed?.error?.code === "server_not_running") {
    ctx.err("NOTICE: no herdr server is running: the bindings apply when it starts.");
    return;
  }
  ctx.err(`WARNING: herdr server reload-config: ${(reload.stdout + reload.stderr).trim()}`);
}
