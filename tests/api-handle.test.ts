import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type FakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { handleRequest, type ApiDeps } from "../cli/lib/api/handle.ts";
import { Journal } from "../cli/lib/api/journal.ts";
import { memberNamed } from "../cli/lib/team.ts";

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        lead: { capabilities: ["repo", "assign", "read-team", "ask-human"], talkTo: ["pilot", "team"] },
        dev: { count: 2, capabilities: ["repo", "publish"], talkTo: ["lead"] },
        reviewer: { capabilities: ["repo", "read-team"], talkTo: ["lead"] },
      },
    },
  },
  pilot: { capabilities: ["assign"], talkTo: ["web"] },
});
const PILOT = "agent-pilot";
const LEAD = "agent-web-lead";
const DEV1 = "agent-web-dev-1";
const DEV2 = "agent-web-dev-2";
const REV = "agent-web-reviewer";

let home: string;
let fake: FakeIncus;
let ctx: FakeContext;
let d: ApiDeps;
// L'état de session que `hc get agent` rend, par container, et les envois reçus.
let sessions: Record<string, string>;
let sends: { container: string; notice: string }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-api-handle-"));
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  fake = FakeIncus.withRuntime();
  for (const name of [PILOT, LEAD, DEV1, DEV2, REV]) {
    fake.addInstance("agent-forge", name, { status: "Running", config: name === DEV1 ? { "user.forge.base.fix-login": "origin/main" } : {} });
  }
  sessions = Object.fromEntries([PILOT, LEAD, DEV1, DEV2, REV].map((n) => [n, "idle"]));
  sends = [];
  ctx = fakeContext({ incus: fake });
  const inner = ctx.exec;
  ctx.exec = async (argv, opts) => {
    const hc = argv.indexOf("hc");
    if (hc > 0 && argv[0] === "incus") {
      const container = argv[argv.indexOf("exec") + 1];
      if (argv[hc + 1] === "get") {
        ctx.calls.push(argv);
        const state = sessions[container];
        if (state === "none") return { code: 1, stdout: "", stderr: "no such terminal" };
        // hc garde un terminal sorti, sans statut.
        return { code: 0, stdout: JSON.stringify(state === "exited" ? { state: "finished", exit_code: 0, status: null } : { status: { state } }), stderr: "" };
      }
      if (argv[hc + 1] === "send") {
        ctx.calls.push(argv);
        sends.push({ container, notice: argv.at(-1)! });
        return { code: 0, stdout: '{"turn":1,"status":"working","started":true}', stderr: "" };
      }
    }
    return inner(argv, opts);
  };
  d = { ctx, cfg, journal: Journal.open(join(home, "api", "journal.jsonl")), secrets: ["tok-123"], now: () => new Date("2026-11-14T10:00:00Z") };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_MIRRORS;
});

const call = (caller: string, req: Record<string, unknown>) => handleRequest(d, memberNamed(cfg, caller), JSON.stringify(req));
const keys = (name: string) => fake.instances.get("agent-forge")!.get(name)!.config;
const file = (container: string, id: number) => fake.files.get(`agent-forge/${container}/home/aiuser/.forge/messages/${id}.md`);
const joined = () => ctx.calls.map((c) => c.join(" "));

test("a developer's message: its branch is refreshed in the team mirror first, then the file, then the notice", async () => {
  const reply = await call(DEV1, { op: "message", to: LEAD, summary: "Fini, branche agent/fix-login", body: "Détail\n\u001b[201~" });
  assert.deepEqual(reply, { ok: true, id: 1 });
  const calls = joined();
  const fetch = calls.findIndex((c) => c.includes("fetch --no-tags src +refs/heads/agent/fix-login"));
  const push = calls.findIndex((c) => c.includes("file push") && c.includes(`${LEAD}/home/aiuser/.forge/messages/1.md`));
  const send = calls.findIndex((c) => c.includes("hc send"));
  assert.ok(fetch >= 0 && push > fetch && send > push, calls.join("\n"));
  assert.equal(file(LEAD, 1)!.content, "Détail\n\u001b[201~");
  assert.deepEqual(sends, [{ container: LEAD, notice: `[forge] message 1 from ${DEV1}: Fini, branche agent/fix-login (detail: /home/aiuser/.forge/messages/1.md)` }]);
  const [e] = d.journal.entries();
  assert.deepEqual([e.id, e.caller, e.op, e.to, e.outcome, e.summary, e.text],
    [1, DEV1, "message", LEAD, "ok", "Fini, branche agent/fix-login", "Détail\n\u001b[201~"]);
});

test("two messages sent together get two ids and two files", async () => {
  const [a, b] = await Promise.all([
    call(DEV1, { op: "message", to: LEAD, summary: "Un", body: "premier" }),
    call(DEV2, { op: "message", to: LEAD, summary: "Deux", body: "second" }),
  ]);
  assert.deepEqual([a, b].map((r) => r.ok && r.id).sort(), [1, 2]);
  assert.deepEqual([file(LEAD, 1)!.content, file(LEAD, 2)!.content].sort(), ["premier", "second"]);
});

test("a developer may not message another developer: refused, no hc call, one refused entry", async () => {
  const reply = await call(DEV1, { op: "message", to: DEV2, summary: "Salut" });
  assert.deepEqual(reply, { ok: false, error: `${DEV1} may not talk to ${DEV2}` });
  assert.equal(sends.length, 0);
  assert.deepEqual(d.journal.entries().map((e) => [e.outcome, e.error]), [["refused", `${DEV1} may not talk to ${DEV2}`]]);
});

test("a message to a session that does not exist or has exited is refused, never queued", async () => {
  for (const state of ["exited", "none"]) {
    sessions[LEAD] = state;
    assert.deepEqual(await call(DEV1, { op: "message", to: LEAD, summary: "Salut" }), { ok: false, error: `${LEAD} has no live session` });
  }
  assert.equal(sends.length, 0);
});

test("assign needs the capability; the lead's assign records the task and who gave it", async () => {
  assert.deepEqual(await call(REV, { op: "assign", to: LEAD, text: "x" }), { ok: false, error: `${REV} has no assign capability` });
  const reply = await call(LEAD, { op: "assign", to: DEV2, task: "fix-login-2", text: "Corrige" });
  assert.deepEqual(reply, { ok: true, id: 2 });
  assert.equal(keys(DEV2)["user.forge.task"], "fix-login-2");
  assert.equal(keys(DEV2)["user.forge.assigned_by"], LEAD);
});

test("release is only for who assigned the task", async () => {
  keys(DEV1)["user.forge.task"] = "fix-login";
  keys(DEV1)["user.forge.assigned_by"] = "human";
  const reply = await call(LEAD, { op: "release", to: DEV1 });
  assert.equal(reply.ok, false);
  assert.match((reply as { error: string }).error, /was assigned by human: only that member or the human can release it/);
  assert.equal(keys(DEV1)["user.forge.task"], "fix-login");
});

test("ask-human needs its capability; the entry keeps summary and body", async () => {
  assert.deepEqual(await call(DEV1, { op: "ask-human", summary: "Q" }), { ok: false, error: `${DEV1} has no ask-human capability` });
  assert.deepEqual(await call(LEAD, { op: "ask-human", summary: "Quel séparateur ?", body: "Détail" }), { ok: true, id: 2 });
  const e = d.journal.entries()[1];
  assert.deepEqual([e.op, e.summary, e.text, e.outcome], ["ask-human", "Quel séparateur ?", "Détail", "ok"]);
});

test("status lists the lead's talk-to, with who each one waits on until its session works", async () => {
  keys(DEV1)["user.forge.task"] = "fix-login";
  await call(DEV1, { op: "message", to: LEAD, summary: "Fini" });
  const rows = async () => {
    const r = await call(LEAD, { op: "status" });
    assert.ok(r.ok);
    return (r as unknown as { team: { name: string; role: string; busy: boolean; task: string | null; session: string; waitingOn: string | null }[] }).team;
  };
  assert.deepEqual((await rows()).map((r) => r.name), [PILOT, DEV1, DEV2, REV]);
  const dev1 = (await rows()).find((r) => r.name === DEV1)!;
  assert.deepEqual([dev1.role, dev1.busy, dev1.task, dev1.session, dev1.waitingOn], ["dev", true, "fix-login", "idle", LEAD]);
  sessions[DEV1] = "working";
  assert.equal((await rows()).find((r) => r.name === DEV1)!.waitingOn, null);
});

test("two leads' assigns of the same free developer at once: one wins, the other is told it is busy", async () => {
  const replies = await Promise.all([
    call(LEAD, { op: "assign", to: DEV2, task: "a", text: "Un" }),
    call(LEAD, { op: "assign", to: DEV2, task: "b", text: "Deux" }),
  ]);
  assert.equal(replies.filter((r) => r.ok).length, 1);
  assert.match((replies.find((r) => !r.ok) as { error: string }).error, /busy with/);
  assert.equal(joined().filter((c) => c.includes("hc run") && c.includes(DEV2)).length, 1);
});

test("an unreadable line is refused and journaled without a verb or a text", async () => {
  const reply = await handleRequest(d, memberNamed(cfg, DEV1), "not json");
  assert.equal(reply.ok, false);
  const [e] = d.journal.entries();
  assert.deepEqual([e.caller, e.op, e.outcome, e.text], [DEV1, null, "refused", null]);
});
