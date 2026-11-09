// The relay's state, <stateDir>/state.json: the head it last published on the
// fork for each task, and the times of its recent writes to GitHub. Two
// requests can run at once (two terminals, a multiplexed ssh connection), so
// each one reads and writes the state under one lock.
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RelayError } from "./config.ts";

export type RelayState = { published: Record<string, string>; writes: number[] };

const RETRY_MS = 100;
const WAIT_MS = 30_000;
// Longer than any request: a lock this old belongs to a process that died.
const STALE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

// `published` has no prototype: a task named `constructor` or `toString` is
// not already published.
function emptyState(): RelayState {
  return { published: Object.create(null) as Record<string, string>, writes: [] };
}

async function readState(file: string): Promise<RelayState> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return emptyState();
    throw e;
  }
  const bad = () => new Error(`relay state: ${file} is malformed`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw bad();
  }
  const o = json as { published?: unknown; writes?: unknown };
  if (typeof o !== "object" || o === null || typeof o.published !== "object" || o.published === null || Array.isArray(o.published)) throw bad();
  if (!Array.isArray(o.writes) || o.writes.some((w) => typeof w !== "number" || !Number.isFinite(w))) throw bad();
  const s = emptyState();
  for (const [task, head] of Object.entries(o.published)) {
    if (typeof head !== "string" || !SHA.test(head)) throw bad();
    s.published[task] = head;
  }
  s.writes = o.writes as number[];
  return s;
}

// Written to a temporary file, flushed, then renamed: a crash leaves the old
// state or the new one, never half of it.
async function writeState(dir: string, s: RelayState): Promise<void> {
  const tmp = path.join(dir, `state.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await fsp.open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify({ published: { ...s.published }, writes: s.writes })}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path.join(dir, "state.json"));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

// mkdir is atomic: the request that creates <dir>/lock holds it. The holder
// writes a random owner inside, so that releasing a lock that was meanwhile
// taken as stale never removes the next holder's.
async function lock(dir: string): Promise<{ lockDir: string; owner: string }> {
  const lockDir = path.join(dir, "lock");
  const owner = randomBytes(12).toString("hex");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    let created = false;
    try {
      await fsp.mkdir(lockDir);
      created = true;
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
    }
    if (created) {
      try {
        await fsp.writeFile(path.join(lockDir, "owner"), owner);
      } catch (e) {
        // A lock without its owner would block every request for 15 minutes.
        await fsp.rm(lockDir, { recursive: true, force: true });
        throw e;
      }
      return { lockDir, owner };
    }
    try {
      const { mtimeMs } = await fsp.stat(lockDir);
      if (Date.now() - mtimeMs > STALE_MS) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (e) {
      // Released between our mkdir and stat: try again at once.
      if (errno(e) === "ENOENT") continue;
      throw e;
    }
    if (Date.now() >= deadline) throw new RelayError("the relay is busy with another request: try again in a minute");
    await sleep(RETRY_MS);
  }
}

async function unlock({ lockDir, owner }: { lockDir: string; owner: string }): Promise<void> {
  const current = await fsp.readFile(path.join(lockDir, "owner"), "utf8").catch(() => null);
  if (current === owner) await fsp.rm(lockDir, { recursive: true, force: true });
}

// Runs `fn` on the state under the lock. The state is written back only when
// `fn` succeeds: a request that fails records nothing.
export async function withState<T>(dir: string, fn: (s: RelayState) => Promise<T>): Promise<T> {
  const held = await lock(dir);
  try {
    const s = await readState(path.join(dir, "state.json"));
    const result = await fn(s);
    await writeState(dir, s);
    return result;
  } finally {
    await unlock(held);
  }
}

// Counts one write to GitHub (publish, open-pr, comment, reply) against the
// hourly cap, which bounds what a tricked agent can post. `now` is in ms.
export function takeWrite(s: RelayState, now: number, perHour: number): void {
  s.writes = s.writes.filter((t) => t > now - HOUR_MS);
  if (s.writes.length >= perHour) {
    const wait = Math.max(1, Math.ceil((Math.min(...s.writes) + HOUR_MS - now) / 60_000));
    throw new RelayError(`write cap reached: ${perHour} writes to GitHub in the last hour; try again in ${wait} minute${wait === 1 ? "" : "s"}`);
  }
  s.writes.push(now);
}
