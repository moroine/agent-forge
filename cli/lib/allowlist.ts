// The egress allowlist (spec "The allowlist"): one domain per line, pushed by
// `forge setup` to the proxy as squid `dstdomain` entries. Validation is
// strict: a line squid would read differently from what the user meant (an
// uppercase name, a port, a wildcard) must stop forge, never be ignored.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ForgeError } from "./context.ts";

export const DEFAULT_ALLOWLIST = `# agent-forge egress allowlist: the only domains strict containers reach,
# through forge-proxy. One entry per line; "#" starts a comment.
#   example.com    that host only
#   .example.com   the domain and all its subdomains
# Lowercase letters, digits and hyphens; internationalized names in punycode
# (xn--...). No IP address, port, scheme, path or "*".
# The list applies to every strict container. Changes take effect at the next
# \`forge setup\`. An empty list is valid: strict containers then reach nothing.

# Anthropic: Claude Code needs these.
api.anthropic.com      # API, Remote Control, feature flags, WebFetch's domain check
platform.claude.com    # OAuth token exchange and refresh
claude.ai              # account authentication
downloads.claude.ai    # Claude Code's apt repository (refresh at provisioning)

# GitHub: the superpowers plugin needs it. Anyone can publish there (repos,
# gists, releases): a hijacked agent can fetch from all of it, and push to it
# with a token it is handed.
#github.com
#codeload.github.com
#objects.githubusercontent.com
#raw.githubusercontent.com

# npm. With a token, \`npm publish\` is an exfiltration channel.
#registry.npmjs.org

# PyPI. Same remark for uploads.
#pypi.org
#files.pythonhosted.org

# Docker Hub. Same remark for pushes.
#registry-1.docker.io
#auth.docker.io
#production.cloudflare.docker.com

# Claude Code telemetry and error reports. Optional: Claude Code works without them.
#http-intake.logs.us5.datadoghq.com
#browser-intake-us5-datadoghq.com
`;

const FORM = "expected example.com or .example.com, lowercase";

// Why `entry` (a trimmed, non-empty line) is not a valid domain entry, or null.
function problem(entry: string): string | null {
  if (entry.includes("://")) return `no scheme (${FORM})`;
  if (entry.includes("/")) return `no path (${FORM})`;
  if (entry.startsWith("[") || /^[0-9.]+$/.test(entry)) return `an IP address is not a domain (${FORM})`;
  if (entry.includes(":")) return `no port (${FORM})`;
  if (entry.includes("*")) return `no "*" wildcard, use a leading dot for subdomains (${FORM})`;
  if (/[^\x20-\x7e]/.test(entry)) return `non-ASCII characters, use punycode (xn--...) (${FORM})`;
  if (/[A-Z]/.test(entry)) return `must be lowercase (${FORM})`;
  if (entry.endsWith(".")) return `no trailing dot (${FORM})`;
  const labels = (entry.startsWith(".") ? entry.slice(1) : entry).split(".");
  for (const label of labels) {
    if (label === "") return `empty label (${FORM})`;
    if (label.startsWith("-") || label.endsWith("-")) return `a label cannot start or end with a hyphen (${FORM})`;
    if (!/^[a-z0-9-]+$/.test(label)) return `only lowercase letters, digits and hyphens (${FORM})`;
  }
  if (labels.length < 2) return `needs at least two labels (${FORM})`;
  return null;
}

// Entry `a` covers `b` when a is ".d" and b is "d" or ends with ".d".
const covers = (a: string, b: string) => a.startsWith(".") && (b === a.slice(1) || b.endsWith(a));

export function parseAllowlist(path: string, text: string): string[] {
  const entries: { value: string; line: number }[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const value = raw.split("#")[0].replace(/^[ \t]+|[ \t]+$/g, "");
    if (value === "") return;
    const fail = (message: string) => new ForgeError(`${path}:${line}: "${value}": ${message}`);
    const bad = problem(value);
    if (bad !== null) throw fail(bad);
    for (const earlier of entries) {
      if (earlier.value === value) throw fail(`duplicate of line ${earlier.line}`);
      if (covers(earlier.value, value) || covers(value, earlier.value)) {
        throw fail(`overlaps "${earlier.value}" at line ${earlier.line}; keep one of the two`);
      }
    }
    entries.push({ value, line });
  });
  return entries.map((e) => e.value);
}

// Reads and validates the allowlist without ever creating it: null when the
// file does not exist (display-only callers such as `forge egress`).
export function readAllowlist(path: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ForgeError(`${path}: cannot read it: ${(e as Error).message}`);
  }
  return parseAllowlist(path, text);
}

// Reads the allowlist, writing the default one first when the file does not
// exist. An existing file, even empty, is never rewritten.
export function loadAllowlist(path: string): { entries: string[]; created: boolean } {
  const entries = readAllowlist(path);
  if (entries !== null) return { entries, created: false };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_ALLOWLIST);
  } catch (w) {
    throw new ForgeError(`${path}: cannot create it: ${(w as Error).message}`);
  }
  return { entries: parseAllowlist(path, DEFAULT_ALLOWLIST), created: true };
}
