import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configPath, forgeHome, mirrorPath, repoRoot, workspacesDir } from "../cli/lib/paths.ts";

const KEYS = ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
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

test("FORGE_MIRRORS overrides the mirrors directory", () => {
  process.env.FORGE_MIRRORS = "/m";
  assert.equal(mirrorPath("agent-x"), "/m/agent-x.git");
});

test("mirrors default to the home's local share", () => {
  delete process.env.FORGE_MIRRORS;
  delete process.env.XDG_DATA_HOME;
  process.env.FORGE_HOME = "/h";
  assert.equal(mirrorPath("agent-x"), "/h/.local/share/agent-forge/mirrors/agent-x.git");
});

test("mirrors honour XDG_DATA_HOME", () => {
  delete process.env.FORGE_MIRRORS;
  process.env.XDG_DATA_HOME = "/d";
  assert.equal(mirrorPath("agent-x"), "/d/agent-forge/mirrors/agent-x.git");
});

test("an empty XDG_DATA_HOME means unset", () => {
  delete process.env.FORGE_MIRRORS;
  process.env.XDG_DATA_HOME = "";
  process.env.FORGE_HOME = "/h";
  assert.equal(mirrorPath("agent-x"), "/h/.local/share/agent-forge/mirrors/agent-x.git");
});
