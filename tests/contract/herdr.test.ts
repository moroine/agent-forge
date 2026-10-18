// Contract test: the herdr layer against a REAL herdr server, isolated in a
// temporary HOME. Skipped when herdr is absent, except under CI where it fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { renderBlock } from "../../cli/lib/herdr-config.ts";
import { createContext } from "../../cli/lib/context.ts";
import {
  createWorkspace, listWorkspaces, createTab, listPanes, paneRun, paneForeground, classifyPane,
} from "../../cli/lib/herdr.ts";

const present = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;
const ci = process.env.CI === "true";
const skip = !present && !ci;

const h = { bin: "herdr", popup: false };
const ctx = createContext();
let home = "";
let env: NodeJS.ProcessEnv = process.env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  assert.ok(present, "herdr must be installed under CI");
  // Short paths: the socket path must fit in sun_path.
  home = mkdtempSync("/tmp/fh-");
  const sock = `${home}/s.sock`;
  process.env.HOME = home;
  process.env.HERDR_SOCKET_PATH = sock;
  env = process.env;
  const server = spawn("herdr", ["server"], { env, detached: true, stdio: "ignore" });
  server.unref();
  for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
  assert.ok(existsSync(sock), "herdr server socket did not appear");
});

after(() => {
  if (skip || !home) return;
  spawnSync("herdr", ["server", "stop"], { env, stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
});

test("herdr accepts the config block forge setup writes", { skip }, () => {
  const file = `${home}/block.toml`;
  writeFileSync(file, renderBlock("/usr/local/bin/forge"));
  const r = spawnSync("herdr", ["config", "check"], { env: { ...process.env, HERDR_CONFIG_PATH: file }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /config: ok/);
});

test("workspace, tab, pane and process classification against real herdr", { skip }, async () => {
  const ws = await createWorkspace(ctx, h, "o/r", home);
  assert.ok(ws.workspaceId && ws.tabId && ws.paneId);
  assert.ok((await listWorkspaces(ctx, h)).some((w) => w.label === "o/r"));

  const tab = await createTab(ctx, h, ws.workspaceId, "cli", home);
  const panes = await listPanes(ctx, h);
  assert.ok(panes.some((p) => p.id === tab.paneId && p.tabId === tab.tabId));

  // A fresh tab holds a bare shell (the shell may take a moment to start).
  let state = classifyPane(await paneForeground(ctx, h, tab.paneId), "c", "cli");
  for (let i = 0; i < 50 && state !== "shell"; i++) {
    await sleep(100);
    state = classifyPane(await paneForeground(ctx, h, tab.paneId), "c", "cli");
  }
  assert.equal(state, "shell");

  await paneRun(ctx, h, tab.paneId, "exec sleep 30");
  let fg: string[][] = [];
  for (let i = 0; i < 50; i++) {
    fg = await paneForeground(ctx, h, tab.paneId);
    if (fg[0]?.[0] === "sleep" && fg[0]?.[1] === "30") break;
    await sleep(100);
  }
  assert.deepEqual(fg, [["sleep", "30"]]);
  assert.equal(classifyPane(fg, "c", "cli"), "busy");
});
