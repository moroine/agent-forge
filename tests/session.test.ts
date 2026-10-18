import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { AGENT } from "../cli/lib/agent.ts";
import {
  attachTask, claudeSlug, ensureRunning, finishedStamp, hasConversation, setTranscriptsAside, stopAgent, transcriptDir,
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
  const yes = fakeContext({ rules: [{ match: ".jsonl", code: 0 }] });
  assert.equal(await hasConversation(yes, "agent-x", "cli"), true);
  const call = yes.calls[0];
  assert.deepEqual(call.slice(0, call.indexOf("--") + 2), [
    ...P, "exec", "agent-x", "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", "sh",
  ]);
  assert.deepEqual(call.slice(-2), ["sh", "/home/aiuser/.claude/projects/-workspace--trees-cli"]);
  const no = fakeContext({ rules: [{ match: ".jsonl", code: 1 }] });
  assert.equal(await hasConversation(no, "agent-x", "cli"), false);
});

// Runs here, with a real sh, the script a call runs in the container; its $1
// (the transcripts folder) becomes a local directory.
function runLocally(call: string[], dir: string): number | null {
  const argv = call.slice(call.indexOf("--") + 1);
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  argv[4] = dir;
  return spawnSync(argv[0], argv.slice(1)).status;
}

// An empty transcript gives Claude nothing to continue: `--continue` would
// end the agent at once.
test("hasConversation's script wants a non-empty .jsonl", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-conv-"));
  try {
    const c = fakeContext();
    await hasConversation(c, "agent-x", "cli");
    const dir = join(root, "proj");
    assert.notEqual(runLocally(c.calls[0], dir), 0, "absent folder");
    mkdirSync(dir);
    assert.notEqual(runLocally(c.calls[0], dir), 0, "empty folder");
    writeFileSync(join(dir, "a.jsonl"), "");
    assert.notEqual(runLocally(c.calls[0], dir), 0, "zero-byte transcript");
    writeFileSync(join(dir, "b.jsonl"), "{}\n");
    assert.equal(runLocally(c.calls[0], dir), 0, "a transcript");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setTranscriptsAside's script never nests into an existing aside folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-aside-"));
  try {
    const now = new Date("2026-10-18T09:05:03Z");
    const c = fakeContext();
    await setTranscriptsAside(c, "agent-x", "cli", now);
    const dir = join(root, "proj");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.jsonl"), "{}\n");
    assert.equal(runLocally(c.calls[0], dir), 0);
    assert.deepEqual(readdirSync(join(root, "proj.finished-20261018T090503Z")), ["a.jsonl"]);
    // A second finish in the same second: the folder stays where it is.
    mkdirSync(dir);
    writeFileSync(join(dir, "b.jsonl"), "{}\n");
    assert.notEqual(runLocally(c.calls[0], dir), 0);
    assert.deepEqual(readdirSync(join(root, "proj.finished-20261018T090503Z")), ["a.jsonl"]);
    assert.deepEqual(readdirSync(dir), ["b.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const c = fakeContext({ rules: [{ match: ".jsonl", code: 1 }], attachCode: 4 });
  assert.equal(await attachTask(c, "agent-x", "cli"), 4);
  assert.deepEqual(c.attachCalls[0].opts?.env, { HERDR_AGENT: "claude" });
});

test("attachTask adds --continue only when a conversation exists", async () => {
  const fresh = fakeContext({ rules: [{ match: ".jsonl", code: 2 }] });
  await attachTask(fresh, "agent-x", "cli");
  assert.ok(!fresh.attachCalls[0].argv.at(-1)?.includes("--continue"));
  const again = fakeContext({ rules: [{ match: ".jsonl", code: 0 }] });
  await attachTask(again, "agent-x", "cli");
  assert.ok(again.attachCalls[0].argv.at(-1)?.endsWith(" --continue"));
});

// One agent per worktree: the guard sits in attachTask, under every caller.
const PS_CLI = { match: "ps -u 1001 -o args=", stdout: "claude --permission-mode auto --remote-control agent-x-cli\n" };

test("attachTask refuses when the task's agent already runs, before attaching", async () => {
  const c = fakeContext({ rules: [PS_CLI] });
  await assert.rejects(attachTask(c, "agent-x", "cli", "o/r"), (e: Error) => e.message ===
    "the agent for cli already runs in agent-x (in a herdr tab, or another terminal): " +
    "attach to it there, or stop it first with 'forge stop o/r'.");
  assert.equal(c.attachCalls.length, 0);
});

test("attachTask without the repo words the way out without it", async () => {
  const c = fakeContext({ rules: [PS_CLI] });
  await assert.rejects(attachTask(c, "agent-x", "cli"), (e: Error) => e.message ===
    "the agent for cli already runs in agent-x (in a herdr tab, or another terminal): " +
    "attach to it there, or stop the container first with 'forge stop'.");
  assert.equal(c.attachCalls.length, 0);
});

test("attachTask ignores another task's agent", async () => {
  const c = fakeContext({ rules: [{ match: "ps -u 1001 -o args=", stdout: "claude --remote-control agent-x-cli-2\n" }] });
  assert.equal(await attachTask(c, "agent-x", "cli", "o/r"), 0);
  assert.equal(c.attachCalls.length, 1);
});

test("attachTask fails closed when the probe fails", async () => {
  const c = fakeContext({ rules: [{ match: "ps -u 1001", code: 1, stderr: "boom" }] });
  await assert.rejects(attachTask(c, "agent-x", "cli", "o/r"), (e: Error) =>
    e.message === "cannot check whether the agent for cli already runs in agent-x: ps failed: boom");
  assert.equal(c.attachCalls.length, 0);
});

// pkill -f takes an extended regex: task v1.2 must not also stop v1x2.
test("stopAgent escapes the regex metacharacters of the task name", async () => {
  const c = fakeContext();
  await stopAgent(c, "agent-x", "v1.2");
  assert.deepEqual(c.calls[0].slice(-4), ["pkill", "-f", "--", "--remote-control agent-x-v1\\.2( |$)"]);
  const pattern = new RegExp(c.calls[0].at(-1) as string);
  assert.ok(pattern.test("claude --remote-control agent-x-v1.2 --continue"));
  assert.ok(!pattern.test("claude --remote-control agent-x-v1x2"));
});

// The agent's cwd is the worktree finish removes next: stopAgent returns once
// the agent is gone, never right after SIGTERM.
const AGENT_PS = "claude --permission-mode auto --remote-control agent-x-cli\n";
function psSequence(running: number) {
  const c = fakeContext();
  const base = c.exec;
  let probes = 0;
  c.exec = async (argv, o) => {
    if (argv.includes("ps")) {
      probes++;
      c.calls.push(argv);
      return { code: 0, stdout: probes <= running ? AGENT_PS : "", stderr: "" };
    }
    return base(argv, o);
  };
  return { c, probes: () => probes };
}

test("stopAgent waits until the agent has exited", async () => {
  const { c, probes } = psSequence(2);
  await stopAgent(c, "agent-x", "cli", { attempts: 5, delayMs: 0 });
  assert.equal(probes(), 3);
});

test("stopAgent fails when the agent outlives SIGTERM", async () => {
  const { c, probes } = psSequence(99);
  await assert.rejects(stopAgent(c, "agent-x", "cli", { attempts: 3, delayMs: 0 }),
    /the agent for cli still runs in agent-x after SIGTERM/);
  assert.equal(probes(), 3);
});

test("stopAgent does not wait when nothing was running (pkill exit 1)", async () => {
  const c = fakeContext({ rules: [{ match: "pkill", code: 1 }] });
  await stopAgent(c, "agent-x", "cli");
  assert.equal(c.calls.length, 1);
});

test("stopAgent fails on any other pkill exit code", async () => {
  const c = fakeContext({ rules: [{ match: "pkill", code: 3, stderr: "pkill: fatal error\n" }] });
  await assert.rejects(stopAgent(c, "agent-x", "cli"), /stopping the agent for cli failed: pkill: fatal error/);
});

test("finishedStamp is the UTC time without separators or milliseconds", () => {
  assert.equal(finishedStamp(new Date("2026-10-18T09:05:03.456Z")), "20261018T090503Z");
});
