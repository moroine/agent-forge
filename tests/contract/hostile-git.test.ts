// Real git against a workspace the agent controls. Host-side git must never
// run a command planted in a workspace's config or hooks (container escape).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import { ensureMirror, refreshMirror } from "../../cli/lib/mirror.ts";
import { mirrorPath } from "../../cli/lib/paths.ts";
import { makeHostileRepo } from "../lib/hostile-repo.ts";

const ENV_KEYS = ["FORGE_WORKSPACES", "FORGE_MIRRORS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let root: string;

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), "forge-hostile-"));
  process.env.FORGE_WORKSPACES = join(root, "workspaces");
  process.env.FORGE_MIRRORS = join(root, "mirrors");
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

test("positive control: git run inside the hostile repository runs the agent's commands", () => {
  const dir = join(root, "control");
  const marker = join(root, "control.marker");
  const canary = join(root, "control.canary");
  writeFileSync(canary, "canary");
  makeHostileRepo(dir, marker, canary);
  try {
    git(["-C", dir, "fetch", "origin"]);
  } catch {
    // The fetch itself may fail; only the planted command matters here.
  }
  assert.ok(existsSync(marker), "the fixture must be hostile, or the next test proves nothing");
});

test("forge's mirror create and refresh run nothing from a hostile workspace", async () => {
  const workspaces = join(root, "workspaces");
  mkdirSync(workspaces, { recursive: true });
  const marker = join(root, "forge.marker");
  const canary = join(root, "forge.canary");
  writeFileSync(canary, "canary");
  makeHostileRepo(join(workspaces, "agent-x"), marker, canary);

  // A local bare repository standing in for GitHub, with a commit on main.
  const seed = join(root, "seed");
  const github = join(root, "github.git");
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "ignore" });
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", "seed"], seed);
  execFileSync("git", ["clone", "-q", "--bare", seed, github], { stdio: "ignore" });

  const remote = {
    url: () => github,
    protocol: ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"],
  };
  const ctx = createContext();
  const mirror = mirrorPath("agent-x");
  assert.equal(await ensureMirror(ctx, mirror, "o/r", remote), "created");
  const refreshed = await refreshMirror(ctx, mirror, "o/r", remote);
  assert.equal(refreshed.code, 0, refreshed.stderr);

  assert.ok(!existsSync(marker), "a planted command ran");
  assert.equal(readFileSync(canary, "utf8"), "canary");
  assert.equal(git([`--git-dir=${mirror}`, "rev-parse", "refs/heads/main"]), git(["rev-parse", "refs/heads/main"], github));
});
