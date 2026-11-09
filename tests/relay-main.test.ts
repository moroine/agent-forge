import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayError } from "../cli/lib/relay/config.ts";
import { RELAY_PATHS, readToken } from "../cli/lib/relay/paths.ts";
import { main, type MainIo } from "../cli/forge-relay.ts";

let root: string;
let out: string[];
let err: string[];
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-relay-main-")));
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// No configuration exists under `root`: a test that needs none passes.
const io = (o: Partial<MainIo>): MainIo => ({
  args: ["serve"],
  env: {},
  stdin: (async function* () {})(),
  stdout: async (t) => { out.push(t); },
  stderr: (l) => { err.push(l); },
  uid: 1000,
  paths: { ...RELAY_PATHS, config: path.join(root, "config.json"), token: path.join(root, "token"), audit: path.join(root, "audit.log") },
  ...o,
});
const audit = () => fs.readFileSync(path.join(root, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("root is refused", async () => {
  assert.equal(await main(io({ uid: 0 })), 1);
  assert.match(err.join(), /as root/);
  assert.deepEqual(out, []);
});

test("an unknown subcommand prints the usage, with no configuration present", async () => {
  assert.equal(await main(io({ args: ["frobnicate"] })), 1);
  assert.match(err.join(), /Usage: forge-relay serve \| setup/);
});

test("stdin over 64 MiB is refused without reading the rest, and audited", async () => {
  let chunks = 0;
  const forever = (async function* () {
    for (;;) {
      chunks++;
      yield Buffer.alloc(8 * 1024 * 1024);
    }
  })();
  assert.equal(await main(io({ stdin: forever })), 1);
  assert.ok(chunks <= 9, `read ${chunks} chunks`);
  const line = JSON.parse(out.join());
  assert.equal(line.ok, false);
  assert.match(line.error, /larger than 64 MiB/);
  assert.equal(audit().at(-1)?.outcome, "refused");
});

test("a configuration failure answers one line, audits the trimmed operation, and prints no stack", async () => {
  assert.equal(await main(io({ env: { SSH_ORIGINAL_COMMAND: " publish " } })), 1);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).ok, false);
  const last = audit().at(-1)!;
  assert.equal(last.op, "publish");
  assert.equal(last.outcome, "refused");
  assert.deepEqual(err, []);
});

test("a token file with a second line is refused without quoting the token", () => {
  const file = path.join(root, "token");
  fs.writeFileSync(file, "ghp_X\nnote\n");
  assert.throws(() => readToken(file), (e) => {
    assert.ok(e instanceof RelayError);
    assert.doesNotMatch(e.message, /ghp_X/);
    return true;
  });
  fs.writeFileSync(file, "ghp_X\n");
  assert.equal(readToken(file), "ghp_X");
});
