import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { BLOCK_START, BLOCK_END, renderBlock, spliceBlock, conflictingKeys, ensureHerdrConfig } from "../cli/lib/herdr-config.ts";
import { ForgeError } from "../cli/lib/context.ts";

const FORGE = "/usr/local/bin/forge";
const BLOCK = [
  "# >>> agent-forge >>>",
  "# Managed by `forge setup`: edits inside this block are overwritten.",
  "# Keep your own settings above it.",
  "[[keys.command]]",
  'key = "prefix+f"',
  'type = "popup"',
  `command = "'/usr/local/bin/forge' start"`,
  'description = "forge: start or open a task"',
  'width = "90%"',
  'height = "90%"',
  "",
  "[[keys.command]]",
  'key = "prefix+shift+f"',
  'type = "popup"',
  `command = "'/usr/local/bin/forge' resume --all"`,
  'description = "forge: resume agents stopped by a herdr restart"',
  'width = "90%"',
  'height = "90%"',
  "# <<< agent-forge <<<",
  "",
].join("\n");

test("renderBlock renders the exact block", () => {
  assert.equal(renderBlock(FORGE), BLOCK);
  assert.equal(BLOCK_START, "# >>> agent-forge >>>");
  assert.equal(BLOCK_END, "# <<< agent-forge <<<");
});

test("renderBlock escapes a path as a TOML basic string", () => {
  const block = renderBlock('/opt/we"ird\\dir/forge');
  assert.ok(block.includes(`command = "'/opt/we\\"ird\\\\dir/forge' start"`), block);
});

test("spliceBlock on an empty text gives the block", () => {
  assert.deepEqual(spliceBlock("", BLOCK), { text: BLOCK, outcome: "created" });
});

test("spliceBlock appends after a blank line", () => {
  assert.deepEqual(spliceBlock("x = 1\n", BLOCK), { text: "x = 1\n\n" + BLOCK, outcome: "created" });
  assert.deepEqual(spliceBlock("x = 1", BLOCK), { text: "x = 1\n\n" + BLOCK, outcome: "created" });
});

test("spliceBlock leaves a text holding this block unchanged", () => {
  const text = "x = 1\n\n" + BLOCK;
  assert.deepEqual(spliceBlock(text, BLOCK), { text, outcome: "unchanged" });
});

test("spliceBlock replaces an old block, user lines byte-identical", () => {
  const old = renderBlock("/old/forge");
  const text = "a = 1\n\n" + old + "b = 2\n";
  const r = spliceBlock(text, BLOCK);
  assert.equal(r.outcome, "updated");
  assert.equal(r.text, "a = 1\n\n" + BLOCK + "b = 2\n");
});

test("spliceBlock keeps CRLF outside the block and finds markers followed by CR", () => {
  const crlf = BLOCK.replaceAll("\n", "\r\n");
  const same = "a = 1\r\n\r\n" + crlf;
  assert.deepEqual(spliceBlock(same, BLOCK), { text: same, outcome: "unchanged" });
  const old = renderBlock("/old/forge").replaceAll("\n", "\r\n");
  const r = spliceBlock("a = 1\r\n" + old + "b = 2\r\n", BLOCK);
  assert.equal(r.outcome, "updated");
  assert.ok(r.text.startsWith("a = 1\r\n"));
  assert.ok(r.text.endsWith("# <<< agent-forge <<<\nb = 2\r\n"), JSON.stringify(r.text));
});

test("spliceBlock refuses a broken block", () => {
  assert.throws(() => spliceBlock("# >>> agent-forge >>>\nx = 1\n", BLOCK), /agent-forge block/);
  assert.throws(() => spliceBlock("x = 1\n# <<< agent-forge <<<\n", BLOCK), /agent-forge block/);
  assert.throws(() => spliceBlock(BLOCK + BLOCK, BLOCK), /agent-forge block/);
});

test("conflictingKeys finds keys outside the block only", () => {
  const text = 'key = "prefix+f"\n  key="prefix+shift+f"  \nkey = "prefix+g"\n\n' + BLOCK;
  assert.deepEqual(conflictingKeys(text).sort(), ["prefix+f", "prefix+shift+f"]);
  assert.deepEqual(conflictingKeys(BLOCK), []);
});

let dir: string;
let path: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-hc-"));
  path = join(dir, "sub", "herdr", "config.toml");
  for (const k of ["HERDR_CONFIG_PATH", "FORGE_HOME", "FORGE_INVOKED_AS", "HERDR_BIN_PATH"]) saved[k] = process.env[k];
  process.env.HERDR_CONFIG_PATH = path;
  process.env.FORGE_HOME = join(dir, "home");
  process.env.FORGE_INVOKED_AS = FORGE;
  delete process.env.HERDR_BIN_PATH;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const noHerdr = { match: "herdr --version", code: 127 };
const withHerdr = { match: "herdr --version", code: 0, stdout: "herdr 0.9.5" };

test("ensureHerdrConfig creates the file and its directory, then reports unchanged", async () => {
  const c = fakeContext({ rules: [noHerdr] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.out_lines, [`herdr config ${path}: created`]);
  assert.equal(readFileSync(path, "utf8"), BLOCK);
  assert.equal(statSync(path).mode & 0o777, 0o644);
  assert.equal(statSync(join(dir, "sub", "herdr")).mode & 0o777, 0o700);
  const before = statSync(path);
  const c2 = fakeContext({ rules: [noHerdr] });
  await ensureHerdrConfig(c2);
  assert.deepEqual(c2.out_lines, [`herdr config ${path}: unchanged`]);
  const after = statSync(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

test("ensureHerdrConfig keeps an existing file's mode on update", async () => {
  mkdirSync(join(dir, "sub", "herdr"), { recursive: true });
  writeFileSync(path, "x = 1\n" + "\n" + renderBlock("/old/forge"));
  chmodSync(path, 0o600);
  const c = fakeContext({ rules: [noHerdr] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.out_lines, [`herdr config ${path}: updated`]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), "x = 1\n\n" + BLOCK);
});

test("ensureHerdrConfig says when herdr is not installed, and does not check", async () => {
  const c = fakeContext({ rules: [noHerdr] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.err_lines, ["NOTICE: herdr is not installed on this host yet: the bindings apply once `herdr --remote` installs it."]);
  assert.ok(!c.calls.some((a) => a.includes("check")));
});

test("ensureHerdrConfig runs config check with HERDR_CONFIG_PATH, silent when ok", async () => {
  const c = fakeContext({ rules: [
    withHerdr,
    { match: "config check", stdout: "config: ok\n" },
    { match: "reload-config", stdout: '{"result":{"status":"applied"}}' },
  ] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.err_lines, []);
  const i = c.calls.findIndex((a) => a.join(" ") === "herdr config check");
  assert.ok(i >= 0, JSON.stringify(c.calls));
  assert.equal(c.execOptions[i]?.env?.HERDR_CONFIG_PATH, path);
  assert.ok(c.calls.some((a) => a.join(" ") === "herdr server reload-config"));
});

test("ensureHerdrConfig warns about config check issues", async () => {
  const c = fakeContext({ rules: [
    withHerdr,
    { match: "config check", code: 1, stdout: "config: issues found\nunknown config key x; ignoring key\n" },
    { match: "reload-config", stdout: '{"result":{"status":"applied"}}' },
  ] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.err_lines, ["WARNING: herdr config check: unknown config key x; ignoring key"]);
});

test("ensureHerdrConfig notices when no server runs", async () => {
  const c = fakeContext({ rules: [
    withHerdr,
    { match: "config check", stdout: "config: ok\n" },
    { match: "reload-config", code: 1, stdout: '{"error":{"code":"server_not_running","message":"no herdr server"}}' },
  ] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.err_lines, ["NOTICE: no herdr server is running: the bindings apply when it starts."]);
});

test("ensureHerdrConfig warns quoting any other reload-config answer", async () => {
  for (const stdout of ['{"error":{"code":"boom","message":"x"}}', "not json"]) {
    const c = fakeContext({ rules: [
      withHerdr,
      { match: "config check", stdout: "config: ok\n" },
      { match: "reload-config", code: 1, stdout: stdout + "\n" },
    ] });
    await ensureHerdrConfig(c);
    assert.deepEqual(c.err_lines, [`WARNING: herdr server reload-config: ${stdout}`]);
  }
});

test("ensureHerdrConfig uses HERDR_BIN_PATH when the file exists", async () => {
  const bin = join(dir, "my-herdr");
  writeFileSync(bin, "");
  process.env.HERDR_BIN_PATH = bin;
  const c = fakeContext({ rules: [
    { match: "config check", stdout: "config: ok\n" },
    { match: "reload-config", stdout: '{"result":{"status":"applied"}}' },
  ] });
  await ensureHerdrConfig(c);
  assert.deepEqual(c.calls.map((a) => a[0]), [bin, bin]);
});

test("ensureHerdrConfig warns about a conflicting binding", async () => {
  mkdirSync(join(dir, "sub", "herdr"), { recursive: true });
  writeFileSync(path, '[[keys.command]]\nkey = "prefix+f"\ncommand = "ls"\n');
  const c = fakeContext({ rules: [noHerdr] });
  await ensureHerdrConfig(c);
  assert.ok(c.err_lines.includes(`WARNING: ${path} also binds prefix+f outside forge's block; herdr may run either.`), c.err_lines.join("\n"));
});

test("ensureHerdrConfig names the file when its block is broken", async () => {
  mkdirSync(join(dir, "sub", "herdr"), { recursive: true });
  writeFileSync(path, "# >>> agent-forge >>>\n");
  await assert.rejects(() => ensureHerdrConfig(fakeContext({ rules: [noHerdr] })),
    (e: unknown) => e instanceof ForgeError && e.message.startsWith(`${path}: `) && /agent-forge block/.test(e.message));
});
