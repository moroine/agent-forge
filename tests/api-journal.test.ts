import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, waitingOn, type Entry } from "../cli/lib/api/journal.ts";

const NOW = new Date("2026-11-14T10:00:00Z");
const base = { to: null, task: null, outcome: "ok", error: null, summary: null, text: null } as const;

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-journal-"));
  return { dir, path: join(dir, "api", "journal.jsonl") };
}

test("open creates a private file; ids continue after a reopen; a reserved id is kept", () => {
  const { dir, path } = tmp();
  try {
    const j = Journal.open(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "api")).mode & 0o777, 0o700);
    assert.equal(j.append({ ...base, caller: "a", op: "status" }, NOW).id, 1);
    assert.equal(j.append({ ...base, caller: "a", op: "status" }, NOW).id, 2);
    const again = Journal.open(path);
    assert.equal(again.entries().length, 2);
    const [three, four] = [again.reserve(), again.reserve()];
    assert.deepEqual([three, four], [3, 4]);
    again.append({ ...base, caller: "a", op: "status" }, NOW, four);
    again.append({ ...base, caller: "a", op: "status" }, NOW, three);
    assert.deepEqual(again.entries().map((e) => e.id), [1, 2, 4, 3]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a corrupt line stops open, with its number, and the file is untouched", () => {
  const { dir, path } = tmp();
  try {
    Journal.open(path).append({ ...base, caller: "a", op: "status" }, NOW);
    appendFileSync(path, "{oops\n");
    const before = statSync(path).size;
    assert.throws(() => Journal.open(path), /line 2/);
    assert.equal(statSync(path).size, before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const entry = (id: number, caller: string, op: Entry["op"], to: string | null, outcome: Entry["outcome"] = "ok"): Entry =>
  ({ ...base, id, time: NOW.toISOString(), caller, op, to, outcome });

test("waitingOn: a message waits on its addressee until it answers; a question waits on the human", () => {
  const dev = "agent-web-dev-1";
  const lead = "agent-web-lead";
  const log: Entry[] = [entry(1, dev, "message", lead)];
  assert.equal(waitingOn(log, dev), lead);
  assert.equal(waitingOn(log, lead), null);
  log.push(entry(2, lead, "message", dev, "refused"));
  assert.equal(waitingOn(log, dev), lead, "a refused message changes nothing");
  log.push(entry(3, lead, "message", dev));
  assert.equal(waitingOn(log, dev), null);
  log.push(entry(4, lead, "ask-human", null));
  assert.equal(waitingOn(log, lead), "human");
});
