// Bout-en-bout : le VRAI binaire, avec un faux incus sur le PATH. Prouve le
// câblage que les tests unitaires ne voient pas — parsing d'argv, dispatch,
// codes de sortie, et la séparation stdout/stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let bin: string;
const ENTRY = resolve("cli/forge.ts");

before(() => {
  bin = mkdtempSync(join(tmpdir(), "forge-e2e-bin-"));
  const stub = resolve("tests/lib/fake-incus-bin.ts");
  writeFileSync(join(bin, "incus"), `#!/bin/sh\nexec node ${stub} "$@"\n`);
  chmodSync(join(bin, "incus"), 0o755);
});

after(() => rmSync(bin, { recursive: true, force: true }));

function forge(args: string[], input = "") {
  return spawnSync("node", [ENTRY, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("no argument prints the usage and exits 0", () => {
  const r = forge([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: forge <command>/);
});

test("an unknown command exits 1 with Error: on stderr", () => {
  const r = forge(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: unknown command 'frobnicate'/m);
  assert.equal(r.stdout, "");
});

test("list renders the table on stdout", () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
  assert.match(r.stdout, /moroine\/agent-forge/);
});

test("completion repos is machine-readable, one per line", () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n"), ["moroine/agent-forge", "acme/widgets"]);
});

test("--force is accepted in any position", () => {
  const first = forge(["stop", "--force", "moroine/agent-forge"]);
  const last = forge(["stop", "moroine/agent-forge", "--force"]);
  assert.equal(first.status, 0);
  assert.equal(last.status, 0);
});

test("a missing argument with no TTY prints the usage instead of hanging", () => {
  const r = forge(["resume"], "1\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge resume/);
});

test("an unknown option fails cleanly rather than crashing", () => {
  const r = forge(["list", "--nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /m);
});

test("image without a subcommand fails with its usage", () => {
  const r = forge(["image"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge image build\|update/);
});

test("the bash shim runs the TypeScript entry", () => {
  const r = spawnSync(resolve("cli/forge"), ["list"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
});

test("setup appears in the usage", () => {
  assert.match(forge([]).stdout, /^\s+setup\s/m);
});
