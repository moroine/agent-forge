// Forge's own SSH block on the laptop, kept in <sshDir>/config.d/agent-forge.config
// so that ~/.ssh/config itself gains at most one `Include` line, and none when
// an Include of the developer's (`config.d/*.config`, say) already reads it.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ForgeError, type Context } from "../context.ts";
import { forgeHome, sshDir } from "../paths.ts";
import type { LaptopHost } from "./state.ts";

const HEADER = "# Managed by forge install: edits are overwritten.";
const FILE = "agent-forge.config";
// The name earlier versions of forge install wrote.
const OLD_FILE = "agent-forge";
// The line `install` offers to add at the top of ~/.ssh/config.
export const INCLUDE_LINE = `Include config.d/${FILE}`;

export function forgeSshConfigPath(): string {
  return join(sshDir(), "config.d", FILE);
}

// ssh splits a config line, and a `-o` value, on whitespace, honouring its own
// quotes: a value with a space or a quote is double-quoted, `"` and `\`
// escaped inside; plain values stay bare.
function value(v: string): string {
  return /[\s"'\\]/.test(v) ? `"${v.replace(/["\\]/g, "\\$&")}"` : v;
}

// One `-o` option for ssh's argv. Where a shell (or Ansible's shlex) splits it
// first, it is shell-quoted on top.
export function sshOption(name: string, v: string): string {
  return `${name}=${value(v)}`;
}

type SshPaths = { knownHosts: string; keyPath: (name: string) => string };

// A host's block, setting by setting, unquoted: what the file says and what
// `ssh -G` must resolve.
function settings(h: LaptopHost, o: SshPaths): [string, string][] {
  const s: [string, string][] = [["HostName", h.address], ["Port", String(h.port)], ["User", h.user]];
  // Lima's port and host key change when the VM is recreated: pin the key
  // under a stable alias and accept the first one.
  if (h.kind === "lima") s.push(["HostKeyAlias", h.name], ["StrictHostKeyChecking", "accept-new"]);
  s.push(["UserKnownHostsFile", o.knownHosts], ["IdentityFile", o.keyPath(h.name)], ["IdentitiesOnly", "yes"]);
  if (h.identityAgent) s.push(["IdentityAgent", h.identityAgent]);
  // The dev VM is an agent's machine with full rights: it never receives the
  // maintainer's SSH agent (spec 5.3).
  s.push(["ForwardAgent", h.kind === "cloud" ? "no" : "yes"]);
  return s;
}

export function renderForgeSshConfig(hosts: LaptopHost[], o: SshPaths): string {
  const blocks = hosts.map((h) => [`Host ${h.name}`, ...settings(h, o).map(([k, v]) => `  ${k} ${value(v)}`)].join("\n"));
  return [HEADER, ...blocks].join("\n\n") + "\n";
}

// Atomic write: temp file next to the target, then rename; 0600 file in 0700
// directories. The temp file is a dotfile, which `Include config.d/*` skips.
export function writeForgeSshConfig(text: string): void {
  const path = forgeSshConfigPath();
  for (const dir of [sshDir(), join(sshDir(), "config.d")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = join(sshDir(), "config.d", ".agent-forge.forge-tmp");
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

// config.d/agent-forge, the name earlier versions wrote, when forge wrote it
// (its first line is forge's header): any other file, link or directory of
// that name is the developer's. Null otherwise.
function oldForgeFile(): { path: string; text: string } | null {
  const path = join(sshDir(), "config.d", OLD_FILE);
  try {
    if (!lstatSync(path).isFile()) return null;
    const text = readFileSync(path, "utf8");
    return text.split("\n", 1)[0].trimEnd() === HEADER ? { path, text } : null;
  } catch {
    return null;
  }
}

// Removed by install once ssh is known to read the new file (an Include that
// covers it, checked, or the one install adds): until then the old file keeps
// an alias that used to work.
export function removeOldForgeSshConfig(): void {
  const old = oldForgeFile();
  if (old) unlinkSync(old.path);
}

// True when forge's own file, or the old one forge wrote, defines `Host <name>`.
export function forgeSshConfigDefines(name: string): boolean {
  const texts: string[] = [];
  try { texts.push(readFileSync(forgeSshConfigPath(), "utf8")); } catch { /* not written yet */ }
  const old = oldForgeFile();
  if (old) texts.push(old.text);
  return texts.some((text) => text.split("\n").some((l) => {
    const m = /^\s*host(?:\s*=\s*|\s+)(.*)$/i.exec(l);
    return m !== null && m[1].split(/\s+/).includes(name);
  }));
}

// ssh keeps the first value it reads for a setting, and offers identity files
// in the order read: an Include that reads forge's file after settings of the
// developer's (under `Match all`, say) lets theirs win. `ssh -G <alias>` shows
// what is in effect; each setting of forge's block that is not gives a line.
export async function overriddenSettings(ctx: Context, host: LaptopHost, o: SshPaths): Promise<string[]> {
  const r = await ctx.exec(["ssh", "-G", host.name]);
  if (r.code !== 0) {
    throw new ForgeError(`ssh -G ${host.name} failed (exit code ${r.code}): ${r.stderr.trim()}`);
  }
  // `ssh -G` prints one `key value` per line, keys in lowercase, values
  // unquoted; identityfile once per file, userknownhostsfile as a list.
  const resolved = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(\S+)[ \t]+(.*?)\s*$/.exec(line);
    if (m) resolved.set(m[1].toLowerCase(), [...(resolved.get(m[1].toLowerCase()) ?? []), m[2]]);
  }
  const lines: string[] = [];
  for (const [key, ours] of settings(host, o)) {
    const theirs = resolved.get(key.toLowerCase())?.[0];
    if (theirs === undefined) {
      lines.push(`forge's \`${key} ${ours}\` is not in effect`);
      continue;
    }
    const same = key === "HostName" ? theirs.toLowerCase() === ours.toLowerCase()
      : key === "UserKnownHostsFile" ? theirs === ours || theirs.startsWith(`${ours} `)
      : theirs === ours;
    if (same) continue;
    const wins = key === "IdentityFile" ? "is offered before" : "wins over";
    lines.push(`\`${key} ${theirs}\` from your ~/.ssh/config ${wins} forge's \`${key} ${ours}\``);
  }
  return lines;
}

// The words of a config line's arguments, as ssh splits them (argv_split in
// OpenSSH's misc.c): blanks separate; single or double quotes group; a
// backslash escapes a quote, a backslash or, outside quotes, a blank (any
// other backslash stays, for glob to read); an unquoted # starting a word
// ends the line.
function sshWords(s: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " " || s[i] === "\t") { i++; continue; }
    if (s[i] === "#") break;
    let word = "";
    let quote = "";
    for (; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];
      if (c === "\\" && (n === "'" || n === '"' || n === "\\" || (quote === "" && n === " "))) word += s[++i];
      else if (quote === "" && (c === " " || c === "\t")) break;
      else if (quote === "" && (c === '"' || c === "'")) quote = c;
      else if (quote !== "" && c === quote) quote = "";
      else word += c;
    }
    words.push(word);
  }
  return words;
}

// Where ssh looks for an Include argument of the user's config: `~/` is the
// home (`~/.ssh/`, forge's SSH directory), and a relative path is relative to
// ~/.ssh.
function includePath(arg: string): string {
  if (arg.startsWith("~/.ssh/")) return join(sshDir(), arg.slice("~/.ssh/".length));
  if (arg.startsWith("~/")) return join(forgeHome(), arg.slice(2));
  return arg.startsWith("/") ? arg : join(sshDir(), arg);
}

const regexChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&");

// One path component of a glob(3) pattern as a regular expression: `*`, `?`,
// `[...]` (`[!...]` negated, ranges; `^` is a plain character there, as in
// macOS's glob), a backslash escaping the next character. An unclosed `[` is
// a plain character. Null when it cannot match anything.
function componentRegex(p: string): RegExp | null {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) re += regexChar(p[++i]);
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      const negate = p[j] === "!";
      if (negate) j++;
      let set = "";
      for (let first = true; j < p.length && (p[j] !== "]" || first); first = false) {
        let a = p[j];
        if (a === "\\" && j + 1 < p.length) a = p[++j];
        if (p[j + 1] === "-" && j + 2 < p.length && p[j + 2] !== "]") {
          let b = p[j + 2];
          j += 2;
          if (b === "\\" && j + 1 < p.length) b = p[++j];
          set += `${regexChar(a)}-${regexChar(b)}`;
        } else {
          set += regexChar(a);
        }
        j++;
      }
      if (j >= p.length) { re += "\\["; continue; }
      re += `[${negate ? "^" : ""}${set}]`;
      i = j;
    } else re += regexChar(c);
  }
  try {
    return new RegExp(`^${re}$`, "s");
  } catch {
    return null; // a range out of order
  }
}

// Does glob(3) return `path` for `pattern`? Component by component, a
// wildcard never crossing a `/` nor matching a leading dot.
function globMatches(pattern: string, path: string): boolean {
  const ps = pattern.split("/");
  const names = path.split("/");
  if (ps.length !== names.length) return false;
  return ps.every((p, i) => {
    if (names[i].startsWith(".") && !p.startsWith(".")) return false;
    return componentRegex(p)?.test(names[i]) ?? false;
  });
}

// Does ~/.ssh/config already read forge's file for every host? An Include
// whose pattern matches it, at the top level (before any Host or Match line),
// under `Match all`, or under a `Host *` with no negated pattern: an Include
// under any other Host or Match line applies to those hosts only.
export function includeState(configText: string): "covered" | "missing" {
  const file = forgeSshConfigPath();
  let everyHost = true;
  for (const raw of configText.split("\n")) {
    // A keyword, then blanks or `=`; a blank line or a comment has no match.
    const m = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(raw.trimEnd());
    if (!m) continue;
    const keyword = m[1].toLowerCase();
    const words = sshWords(m[2]);
    if (keyword === "host") everyHost = words.includes("*") && !words.some((w) => w.startsWith("!"));
    else if (keyword === "match") everyHost = words.length === 1 && words[0].toLowerCase() === "all";
    else if (keyword === "include" && everyHost && words.some((w) => globMatches(includePath(w), file))) {
      return "covered";
    }
  }
  return "missing";
}

// The Include goes at the very top (below a Host line it would only apply to
// that host); every byte of the input follows unchanged.
export function addInclude(configText: string): string {
  return configText === "" ? `${INCLUDE_LINE}\n` : `${INCLUDE_LINE}\n\n${configText}`;
}

// Before forge's block exists for `name`: does `ssh -G` already resolve it to
// another HostName? Then someone else's config defines that name.
export async function hostDefinedElsewhere(ctx: Context, name: string): Promise<boolean> {
  const r = await ctx.exec(["ssh", "-G", name]);
  if (r.code !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*hostname\s+(\S+)/i.exec(line);
    if (m) return m[1].toLowerCase() !== name.toLowerCase();
  }
  return false;
}
