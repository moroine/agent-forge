// Betterleaks on the relay: the signed commits a publish is about to push, and
// the texts the bot is about to post. The flags are CI's
// (.github/scripts/scan-secrets.sh). What tunes a scan comes from upstream
// main only, never from the branch, which the agent writes: its
// .betterleaksignore for commits (a false positive is cleared there, by the
// maintainer) and its .betterleaks.toml when it has one. Those are written to a
// fresh temporary directory, which is also the scan's working directory:
// Betterleaks reads an ignore file in its working directory too (stdin mode).
// In git mode it also reads one at the root of the scanned repository: the
// mirror never has one, and a scan refuses to run if it does.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { printable } from "../printable.ts";
import { RelayError } from "./config.ts";
import { gitIn } from "./replay.ts";

// upstream main as the mirror last fetched it.
export const UPSTREAM_MAIN = "refs/relay/upstream/main";

// What a finding shows, Betterleaks having redacted the secret. The fields are
// printable: a file name is the agent's text, on its way to a terminal.
export type Finding = { rule: string; file: string; line: number; commit: string; fingerprint: string };

// The content of `name` at the root of the commit `rev` in the mirror, or null
// when it has no such file.
export async function fileAt(ctx: Context, repo: string, rev: string, name: string): Promise<string | null> {
  const ls = await mustSucceed(`git ls-tree ${name}`, ctx.exec(gitIn(repo, "ls-tree", rev, "--", name)));
  const blob = /^\d+ blob ([0-9a-f]+)\t/.exec(ls.stdout)?.[1];
  if (blob === undefined) return null;
  return (await mustSucceed(`git cat-file ${name}`, ctx.exec(gitIn(repo, "cat-file", "blob", blob)))).stdout;
}

// upstream main's .betterleaks.toml as the mirror last fetched it, or null
// when it has none. Before the first publish, the mirror has no upstream main:
// no configuration either.
async function upstreamConfig(ctx: Context, repo: string): Promise<string | null> {
  const r = await ctx.exec(gitIn(repo, "rev-parse", "--verify", "-q", `${UPSTREAM_MAIN}^{commit}`));
  if (r.code === 1) return null;
  if (r.code !== 0) throw new ForgeError(`git rev-parse ${UPSTREAM_MAIN} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  return fileAt(ctx, repo, r.stdout.trim(), ".betterleaks.toml");
}

const field = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? printable(o[k] as string) : "");

// The report's findings; null when it is not a list of them.
function parseReport(text: string): Finding[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  return json.map((f) => {
    const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
    return {
      rule: field(o, "RuleID"),
      file: field(o, "File"),
      line: typeof o.StartLine === "number" ? o.StartLine : 0,
      commit: field(o, "Commit"),
      fingerprint: field(o, "Fingerprint"),
    };
  });
}

// `command` is the subcommand and its own flags, `target` what it scans.
async function scan(
  ctx: Context, command: string[], target: string[], o: { ignoreText: string | null; config: string | null; input?: string },
): Promise<Finding[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-relay-scan-"));
  try {
    // -i names a directory: Betterleaks reads the .betterleaksignore in it.
    const ignore = path.join(dir, "ignore");
    await mkdir(ignore);
    if (o.ignoreText !== null) await writeFile(path.join(ignore, ".betterleaksignore"), o.ignoreText);
    const report = path.join(dir, "report.json");
    const config: string[] = [];
    if (o.config !== null) {
      const file = path.join(dir, "betterleaks.toml");
      await writeFile(file, o.config);
      config.push("--config", file);
    }
    // BETTERLEAKS_VALIDATE and BETTERLEAKS_ANALYZE are removed: validation
    // would send a found token to its issuer's API. The working directory is
    // the temporary one, which holds no ignore file at its root.
    const r = await ctx.exec(
      ["env", "-u", "BETTERLEAKS_VALIDATE", "-u", "BETTERLEAKS_ANALYZE", "betterleaks", ...command,
        "--redact", "--no-banner", "--ignore-gitleaks-allow", "-i", ignore,
        "--report-format", "json", "--report-path", report, ...config, ...target],
      { cwd: dir, ...(o.input === undefined ? {} : { input: o.input }) },
    );
    if (r.code === 0) return [];
    // Exit 1 is also how Betterleaks reports its own errors: without a
    // finding in the report, it is a failure, not a clean scan.
    if (r.code === 1) {
      const found = parseReport(await readFile(report, "utf8").catch(() => ""));
      if (found !== null && found.length > 0) return found;
    }
    throw new RelayError(`Betterleaks failed (exit code ${r.code})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Scans the commits of `range` (`<sha>..<sha>`) in the mirror, as CI does,
// with `ignoreText` as the .betterleaksignore (none when null) and the
// .betterleaks.toml of `upstreamMain`, the commit ID of upstream main the
// publish read under its lock.
export async function scanCommits(
  ctx: Context, repo: string, range: string, ignoreText: string | null, upstreamMain: string,
): Promise<Finding[]> {
  // The range lands in --log-opts, which Betterleaks splits on spaces: only
  // two commit IDs, so that it cannot carry a git log option.
  if (!/^[0-9a-f]{40,64}\.\.[0-9a-f]{40,64}$/.test(range)) throw new Error(`scanCommits: not a <sha>..<sha> range: ${range}`);
  if (!/^[0-9a-f]{40,64}$/.test(upstreamMain)) throw new Error(`scanCommits: not a commit ID: ${upstreamMain}`);
  // Betterleaks would read these at the repository's root, on top of -i.
  for (const name of [".betterleaksignore", ".gitleaksignore"]) {
    if (existsSync(path.join(repo, name))) {
      throw new RelayError(`the relay's mirror holds a ${name}, which the scan would read: nothing was published; the relay's administrator removes it`);
    }
  }
  const config = await fileAt(ctx, repo, upstreamMain, ".betterleaks.toml");
  // --diff-merges=remerge: a plain `git log -p` shows no diff for a merge, so
  // a secret added while resolving a conflict would go unseen.
  return scan(ctx, ["git", `--log-opts=--diff-merges=remerge ${range}`], [repo], { ignoreText, config });
}

// Scans a text the bot is about to post. No ignore file applies: a finding in
// a text is reworded by the agent, never cleared. `repo` is the mirror, whose
// upstream main may carry a .betterleaks.toml.
export async function scanText(ctx: Context, text: string, repo: string): Promise<Finding[]> {
  const config = await upstreamConfig(ctx, repo);
  return scan(ctx, ["stdin"], [], { ignoreText: null, config, input: text });
}
