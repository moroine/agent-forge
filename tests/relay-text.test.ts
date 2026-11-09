import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelayConfig } from "../cli/lib/relay/config.ts";
import { checkPublicText, crossReferences, neutralizeMentions } from "../cli/lib/relay/text.ts";
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
