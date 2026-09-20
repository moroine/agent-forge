// tests/hostpaths.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { home, repoDir, workspaces, configHome, claudeDist } from "../scripts/lib/hostpaths.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const CLEAR = {
  FORGE_HOME: undefined, FORGE_REPO_DIR: undefined, FORGE_WORKSPACES: undefined,
  FORGE_CONFIG_HOME: undefined, FORGE_CLAUDE_DIST: undefined,
};

test("defaults hang off /home/moroine", () => {
  withEnv(CLEAR, () => {
    assert.equal(home(), "/home/moroine");
    assert.equal(repoDir(), "/home/moroine/agent-forge");
    assert.equal(workspaces(), "/home/moroine/workspaces");
    assert.equal(configHome(), "/home/moroine/.config/agent-forge");
    assert.equal(claudeDist(), "/home/moroine/.local/share/agent-forge/claude");
  });
});

test("FORGE_HOME moves every derived path", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/h" }, () => {
    assert.equal(repoDir(), "/tmp/h/agent-forge");
    assert.equal(workspaces(), "/tmp/h/workspaces");
    assert.equal(configHome(), "/tmp/h/.config/agent-forge");
    assert.equal(claudeDist(), "/tmp/h/.local/share/agent-forge/claude");
  });
});

test("each path has its own override, which wins over FORGE_HOME", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/h", FORGE_CONFIG_HOME: "/tmp/cfg", FORGE_CLAUDE_DIST: "/tmp/cl" }, () => {
    assert.equal(configHome(), "/tmp/cfg");
    assert.equal(claudeDist(), "/tmp/cl");
    assert.equal(workspaces(), "/tmp/h/workspaces");
  });
});

test("the env is read per call, not captured at import time", () => {
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/a" }, () => assert.equal(home(), "/tmp/a"));
  withEnv({ ...CLEAR, FORGE_HOME: "/tmp/b" }, () => assert.equal(home(), "/tmp/b"));
});
