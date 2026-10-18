import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALLOWLIST, loadAllowlist, parseAllowlist } from "../cli/lib/allowlist.ts";
import { ForgeError } from "../cli/lib/context.ts";

test("comments, inline comments and blank lines are ignored", () =>
  assert.deepEqual(parseAllowlist("f", "# head\n\napi.anthropic.com   # why\n.example.com\n"), ["api.anthropic.com", ".example.com"]));

test("CRLF, a BOM, tabs and trailing spaces read like plain LF", () =>
  assert.deepEqual(parseAllowlist("f", "﻿a.example.com\t \r\n\t.b.example.org  # x\r\n"), ["a.example.com", ".b.example.org"]));

for (const [line, why] of [
  ["Example.com", /lowercase/], ["example", /two labels/], ["10.0.0.1", /IP/], ["[::1]", /IP/],
  ["example.com:443", /port/], ["https://example.com", /scheme/], ["example.com/path", /path/],
  ["*.example.com", /\*/], ["example.com.", /trailing dot/], ["-a.example.com", /hyphen/], ["exämple.com", /punycode/],
] as const) {
  test(`"${line}" is refused with its line number`, () =>
    assert.throws(() => parseAllowlist("/x/egress-allowlist", `# c\n${line}\n`), (e: Error) =>
      e instanceof ForgeError && e.message.startsWith("/x/egress-allowlist:2: ") && why.test(e.message)));
}

test("duplicates and overlaps are refused", () => {
  assert.throws(() => parseAllowlist("f", "a.com\na.com\n"), /f:2: .*duplicate/);
  assert.throws(() => parseAllowlist("f", "example.com\n.example.com\n"), /f:2: .*overlaps .*line 1/);
  assert.throws(() => parseAllowlist("f", ".example.com\na.example.com\n"), /f:2: .*overlaps/);
});

test("an empty list is valid", () => assert.deepEqual(parseAllowlist("f", "# nothing\n\n"), []));

test("the default list holds Anthropic's four domains, active, and the rest commented", () =>
  assert.deepEqual(parseAllowlist("f", DEFAULT_ALLOWLIST), ["api.anthropic.com", "platform.claude.com", "claude.ai", "downloads.claude.ai"]));

test("a missing file is created with the default list; an existing one, even empty, is never rewritten", () => {
  const p = join(mkdtempSync(join(tmpdir(), "allow-")), "sub", "egress-allowlist");
  const first = loadAllowlist(p);
  assert.equal(first.created, true);
  assert.equal(first.entries.length, 4);
  assert.equal(readFileSync(p, "utf8"), DEFAULT_ALLOWLIST);
  writeFileSync(p, "");
  assert.deepEqual(loadAllowlist(p), { created: false, entries: [] });
  assert.equal(readFileSync(p, "utf8"), "");
});

test("an unreadable path is a ForgeError naming the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "allow-"));
  assert.throws(() => loadAllowlist(dir), (e: Error) => e instanceof ForgeError && e.message.startsWith(`${dir}: `));
});
