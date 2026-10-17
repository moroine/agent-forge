import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configPath, forgeHome, repoRoot, workspacesDir } from "../cli/lib/paths.ts";

const KEYS = ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "XDG_CONFIG_HOME"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("the home is the caller's, never a fixed path", () => {
  delete process.env.FORGE_HOME;
  assert.equal(forgeHome(), homedir());
});

test("the repo root is the directory above cli/", () => {
  delete process.env.FORGE_REPO_DIR;
  assert.equal(repoRoot(), resolve(import.meta.dirname, ".."));
});

test("workspaces live in the home", () => {
  delete process.env.FORGE_WORKSPACES;
  process.env.FORGE_HOME = "/h";
  assert.equal(workspacesDir(), "/h/workspaces");
});

test("the config file honours XDG_CONFIG_HOME", () => {
  process.env.XDG_CONFIG_HOME = "/x";
  assert.equal(configPath(), join("/x", "agent-forge", "config.json"));
});

test("an empty XDG_CONFIG_HOME means unset", () => {
  process.env.XDG_CONFIG_HOME = "";
  process.env.FORGE_HOME = "/h";
  assert.equal(configPath(), "/h/.config/agent-forge/config.json");
});
