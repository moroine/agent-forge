import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelayConfig } from "../cli/lib/relay/config.ts";
import { checkPublicText, codeSpans, crossReferences, neutralizeMentions } from "../cli/lib/relay/text.ts";
import { printableText } from "../cli/lib/printable.ts";

const raw = {
  upstream: "acme/widgets",
  fork: "bot/widgets",
  botLogin: "bot",
  botName: "Bot",
  botEmail: "1+bot@users.noreply.github.com",
  trustedLogins: ["Maint"],
  coAuthorEmails: ["noreply@anthropic.com"],
  writesPerHour: 20,
};
const cfg = parseRelayConfig(raw);

test("parseRelayConfig refuses a fork the bot does not own", () =>
  assert.throws(() => parseRelayConfig({ ...raw, fork: "other/widgets" }), /fork/));

test("a stranger's mention is put in a code span", () =>
  assert.equal(neutralizeMentions("thanks @stranger and @org/team", ["maint", "bot"]), "thanks `@stranger` and `@org/team`"));

test("trusted mentions, emails and code stay", () => {
  for (const t of ["@MAINT see", "@bot", "a@b.com", "`@x`", "```\n@x\n```"]) assert.equal(neutralizeMentions(t, ["maint", "bot"]), t);
});

test("references to other repositories are found", () => assert.deepEqual(
  crossReferences("other/repo#3 https://github.com/o/r/pull/4/files o/r@abc1234", "acme/widgets"),
  ["other/repo#3", "https://github.com/o/r/pull/4", "o/r@abc1234"]));

test("upstream references stay", () => assert.deepEqual(
  crossReferences("#12 Fixes #12 ACME/Widgets#1 https://github.com/acme/widgets/issues/9", "acme/widgets"), []));

test("checkPublicText refuses a cross-reference and an over-long text", () => {
  assert.throws(() => checkPublicText("see o/r#1", cfg, 100, "the comment"), /another repository/);
  assert.throws(() => checkPublicText("x".repeat(101), cfg, 100, "the comment"), /longer than 100/);
});

test("printableText keeps lines and drops escapes", () => assert.equal(printableText("a\n\tb\x1b[2Jc\x07"), "a\n\tb[2Jc"));

const allowed = ["maint", "bot"];

test("a mention after an unpaired backtick is still neutralized, and its wrapper cannot pair with the stray one", () =>
  assert.equal(neutralizeMentions("`@evil", allowed), "` ``@evil``"));

test("a mention touching a code span does not merge with it", () =>
  assert.equal(neutralizeMentions("@evil`c`", allowed), "``@evil`` `c`"));

test("code spans follow CommonMark: matching runs, newlines, unclosed runs are text", () => {
  for (const t of ["``x`@evil``", "`a\n@evil`"]) assert.equal(neutralizeMentions(t, allowed), t);
});

test("an escaped backtick opens no span, an escaped backslash does not escape", () => {
  assert.equal(neutralizeMentions("\\`@evil`", allowed), "\\` ``@evil`` `");
  assert.equal(neutralizeMentions("\\\\`@x`", allowed), "\\\\`@x`");
  assert.equal(neutralizeMentions("`a\\`@x", allowed), "`a\\` ``@x``");
});

test("adjacent mentions are wrapped together, a lone trusted one stays", () => {
  assert.equal(neutralizeMentions("@evil@x", allowed), "`@evil@x`");
  assert.equal(neutralizeMentions("@maint@evil", allowed), "`@maint@evil`");
  assert.equal(neutralizeMentions("@maint", allowed), "@maint");
  assert.equal(neutralizeMentions("a@b.com", allowed), "a@b.com");
});

test("no mention is left outside code for tricky inputs", () => {
  const inputs = ["@a@b", "`@a@b", "\\`@a@b`", "``x`@a@b``", "`a\n@b`@c", "@a`@b`@c", "x`@a\n@b", "\\@a@b", "`\\`@a@b", "@a/t@b@c`", "```\n@a\n```@b"];
  for (const t of inputs) {
    const out = neutralizeMentions(t, allowed);
    const spans = codeSpans(out);
    for (const m of out.matchAll(/@(?=[A-Za-z0-9])/g)) {
      const inCode = spans.some(([s, e]) => m.index >= s && m.index < e);
      const afterWord = m.index > 0 && /\w/.test(out[m.index - 1]);
      assert.ok(inCode || afterWord, `${JSON.stringify(t)} -> ${JSON.stringify(out)}: bare @ at ${m.index}`);
    }
  }
});

test("references through any spelling of a github.com URL are found, upstream ones are not", () => {
  for (const u of ["http://github.com/o/r/pull/1", "HTTPS://GITHUB.COM/o/r/pull/1", "https://www.github.com/o/r/issues/1",
    "github.com/o/r/issues/1", "www.github.com/o/r/issues/1", "[x](http://github.com/o/r/pull/1)"]) {
    const found = crossReferences(u, "acme/widgets");
    assert.equal(found.length, 1, u);
    assert.match(found[0], /o\/r\/(pull|issues)\/1$/i, u);
  }
  for (const u of ["http://github.com/acme/widgets/pull/1", "www.GitHub.com/ACME/widgets/issues/1", "[x](https://github.com/acme/widgets/pull/1)"]) {
    assert.deepEqual(crossReferences(u, "acme/widgets"), [], u);
  }
});

test("a reference glued to a dot or a dash is found", () => {
  assert.deepEqual(crossReferences("see.o/r#1", "acme/widgets"), ["o/r#1"]);
  assert.equal(crossReferences("see-o/r#1", "acme/widgets").length, 1);
});

test("checkPublicText measures the text it returns", () =>
  assert.throws(() => checkPublicText("@evil", cfg, 6, "the comment"), /longer than 6/));
