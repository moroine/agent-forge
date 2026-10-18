import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { AGENT } from "../cli/lib/agent.ts";
import {
  attachTask, claudeSlug, ensureRunning, hasConversation, transcriptDir,
} from "../cli/lib/session.ts";

const P = ["incus", "--project", "agent-forge"];
const list = (status: string) => JSON.stringify([{ name: "agent-x", status }]);

test("AGENT.command adds --continue only when resuming", () => {
  assert.deepEqual(AGENT.command("agent-x", "cli", false), [
    "bash", "-lc", "exec claude --permission-mode auto --remote-control agent-x-cli",
  ]);
  const resumed = AGENT.command("agent-x", "cli", true);
  assert.equal(resumed[2], "exec claude --permission-mode auto --remote-control agent-x-cli --continue");
});

test("AGENT.marker is the remote-control flag", () => {
  assert.equal(AGENT.marker("agent-x", "cli"), "--remote-control agent-x-cli");
  assert.equal(AGENT.herdrLabel, "claude");
});

test("claudeSlug replaces every non-alphanumeric character with a dash", () => {
  assert.equal(claudeSlug("/workspace"), "-workspace");
  assert.equal(claudeSlug("/workspace/.trees/fix.v2"), "-workspace--trees-fix-v2");
  assert.equal(transcriptDir("cli"), "/home/aiuser/.claude/projects/-workspace--trees-cli");
});

test("hasConversation probes for a .jsonl through execAsAgentArgv", async () => {
  const yes = fakeContext({ rules: [{ match: "ls", code: 0 }] });
  assert.equal(await hasConversation(yes, "agent-x", "cli"), true);
  assert.deepEqual(yes.calls[0], [
    ...P, "exec", "agent-x", "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--",
    "sh", "-c", 'ls "$1"/*.jsonl >/dev/null 2>&1', "sh",
    "/home/aiuser/.claude/projects/-workspace--trees-cli",
  ]);
  const no = fakeContext({ rules: [{ match: "ls", code: 2 }] });
  assert.equal(await hasConversation(no, "agent-x", "cli"), false);
});

test("ensureRunning starts a stopped container", async () => {
  const c = fakeContext({ rules: [{ match: "list", stdout: list("Stopped") }] });
  await ensureRunning(c, "agent-x");
  assert.ok(c.calls.some((call) => call.join(" ") === `${P.join(" ")} start agent-x`));
});

test("ensureRunning does nothing for a running container", async () => {
  const c = fakeContext({ rules: [{ match: "list", stdout: list("Running") }] });
  await ensureRunning(c, "agent-x");
  assert.ok(!c.calls.some((call) => call.includes("start")));
});

// A concurrent `incus start` can fail while the container is in fact running.
function sequenceContext(answers: { code: number; stdout: string; stderr: string }[]) {
  let n = 0;
  return { ...fakeContext(), exec: async () => answers[Math.min(n++, answers.length - 1)] };
}

test("ensureRunning tolerates a failed start when the container ends up Running", async () => {
  const ctx = sequenceContext([
    { code: 0, stdout: list("Stopped"), stderr: "" },
    { code: 1, stdout: "", stderr: "already starting" },
    { code: 0, stdout: list("Running"), stderr: "" },
  ]);
  await ensureRunning(ctx, "agent-x");
});

test("ensureRunning throws when the start fails and the container stays stopped", async () => {
  const ctx = sequenceContext([
    { code: 0, stdout: list("Stopped"), stderr: "" },
    { code: 1, stdout: "", stderr: "boom" },
    { code: 0, stdout: list("Stopped"), stderr: "" },
  ]);
  await assert.rejects(ensureRunning(ctx, "agent-x"), /incus start failed: boom/);
});

test("attachTask passes HERDR_AGENT=claude to the incus process", async () => {
  const c = fakeContext({ rules: [{ match: "ls", code: 1 }], attachCode: 4 });
  assert.equal(await attachTask(c, "agent-x", "cli"), 4);
  assert.deepEqual(c.attachCalls[0].opts?.env, { HERDR_AGENT: "claude" });
});

test("attachTask adds --continue only when a conversation exists", async () => {
  const fresh = fakeContext({ rules: [{ match: "ls", code: 2 }] });
  await attachTask(fresh, "agent-x", "cli");
  assert.ok(!fresh.attachCalls[0].argv.at(-1)?.includes("--continue"));
  const again = fakeContext({ rules: [{ match: "ls", code: 0 }] });
  await attachTask(again, "agent-x", "cli");
  assert.ok(again.attachCalls[0].argv.at(-1)?.endsWith(" --continue"));
});
