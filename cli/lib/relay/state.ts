// The relay's state, <stateDir>/state.json: the head it last published on the
// fork for each task, the head it is about to push (pending), and the times
// of its recent writes to GitHub and of its recent publish attempts. Two
// requests can run at once (two terminals, a multiplexed ssh connection), so
// each one reads and writes the state under one lock.
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RelayError } from "./config.ts";

// `pending[t]` is written before a push and cleared once the push is recorded
// in `published[t]` (or refused): if the relay dies in between, the next
// publish still recognizes the fork's head as its own.
export type RelayState = { published: Record<string, string>; pending: Record<string, string>; writes: number[]; attempts: number[] };

const RETRY_MS = 100;
const WAIT_MS = 30_000;
// Longer than any request: a lock this old belongs to a process that died.
const STALE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const token = (): string => randomBytes(12).toString("hex");

// The maps have no prototype: a task named `constructor` or `toString` is
// neither published nor pending.
const heads = (): Record<string, string> => Object.create(null) as Record<string, string>;

function emptyState(): RelayState {
  return { published: heads(), pending: heads(), writes: [], attempts: [] };
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
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw bad();
  const o = json as { published?: unknown; pending?: unknown; writes?: unknown; attempts?: unknown };
  const map = (v: unknown): Record<string, string> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad();
    const m = heads();
    for (const [task, head] of Object.entries(v)) {
      if (typeof head !== "string" || !SHA.test(head)) throw bad();
      m[task] = head;
    }
    return m;
  };
  const times = (v: unknown): number[] => {
    if (!Array.isArray(v) || v.some((w) => typeof w !== "number" || !Number.isFinite(w))) throw bad();
    return v as number[];
  };
  // A state file written before the attempt cap existed has no `attempts`.
  return { published: map(o.published), pending: map(o.pending ?? {}), writes: times(o.writes), attempts: times(o.attempts ?? []) };
}

type Held = { dir: string; lockDir: string; owner: string };

const ownerOf = (lockDir: string): Promise<string | null> => fsp.readFile(path.join(lockDir, "owner"), "utf8").catch(() => null);

// Written to a temporary file, flushed, then renamed: a crash leaves the old
// state or the new one, never half of it. Only while this request still holds
// the lock: one that lost it (taken as stale) writes nothing.
async function writeState(held: Held, s: RelayState): Promise<void> {
  if ((await ownerOf(held.lockDir)) !== held.owner) throw new Error("relay state: this request lost the lock; nothing was written");
  const tmp = path.join(held.dir, `state.json.${process.pid}.${token()}.tmp`);
  try {
    const fh = await fsp.open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify({ published: { ...s.published }, pending: { ...s.pending }, writes: s.writes, attempts: s.attempts })}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path.join(held.dir, "state.json"));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

// A lock older than STALE_MS is moved aside under a name of its own, then
// removed if it is still the lock found stale. Another request may have
// broken it and taken a fresh lock in the meantime: that one is put back,
// or, if a third request already holds the name, its holder finds out at
// its next write.
async function breakStale(lockDir: string): Promise<void> {
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await fsp.stat(lockDir));
  } catch (e) {
    if (errno(e) === "ENOENT") return;
    throw e;
  }
  if (Date.now() - mtimeMs <= STALE_MS) return;
  const stale = await ownerOf(lockDir);
  const aside = `${lockDir}.stale.${token()}`;
  try {
    await fsp.rename(lockDir, aside);
  } catch (e) {
    if (errno(e) === "ENOENT") return;
    throw e;
  }
  if ((await ownerOf(aside)) !== stale) await fsp.rename(aside, lockDir).catch(() => {});
  await fsp.rm(aside, { recursive: true, force: true });
}

// The lock is the directory <dir>/lock, holding a random owner: a write or a
// release checks it, so that a request whose lock was taken as stale never
// acts on the next holder's. It is made aside, owner included, then renamed
// into place: rename is atomic and refuses to replace a directory that is not
// empty, so the request whose rename succeeds holds the lock, and a lock never
// exists without its owner.
async function lock(dir: string): Promise<Held> {
  const lockDir = path.join(dir, "lock");
  const owner = token();
  const staging = path.join(dir, `lock.new.${owner}`);
  await fsp.mkdir(staging);
  try {
    await fsp.writeFile(path.join(staging, "owner"), owner);
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        await fsp.rename(staging, lockDir);
        return { dir, lockDir, owner };
      } catch (e) {
        if (errno(e) !== "EEXIST" && errno(e) !== "ENOTEMPTY") throw e;
      }
      await breakStale(lockDir);
      if (Date.now() >= deadline) throw new RelayError("the relay is busy with another request: try again in a minute");
      await sleep(RETRY_MS);
    }
  } finally {
    // Gone already when the rename succeeded.
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function unlock(held: Held): Promise<void> {
  if ((await ownerOf(held.lockDir)) === held.owner) await fsp.rm(held.lockDir, { recursive: true, force: true });
}

// Runs `fn` on the state under the lock. The state is written back when `fn`
// succeeds; a request that fails records nothing, except what it wrote itself
// with `save`, which makes the state durable at once (before a push, for one).
export async function withState<T>(dir: string, fn: (s: RelayState, save: () => Promise<void>) => Promise<T>): Promise<T> {
  const held = await lock(dir);
  try {
    const s = await readState(path.join(dir, "state.json"));
    const result = await fn(s, () => writeState(held, s));
    await writeState(held, s);
    return result;
  } finally {
    await unlock(held);
  }
}

const minutesUntil = (times: number[], now: number): string => {
  const wait = Math.max(1, Math.ceil((Math.min(...times) + HOUR_MS - now) / 60_000));
  return `${wait} minute${wait === 1 ? "" : "s"}`;
};

// Counts one write to GitHub (publish, open-pr, comment, reply) against the
// hourly cap, which bounds what a tricked agent can post. `now` is in ms.
export function takeWrite(s: RelayState, now: number, perHour: number): void {
  s.writes = s.writes.filter((t) => t > now - HOUR_MS);
  if (s.writes.length >= perHour) {
    throw new RelayError(`write cap reached: ${perHour} writes to GitHub in the last hour; try again in ${minutesUntil(s.writes, now)}`);
  }
  s.writes.push(now);
}

// Publish attempts an hour, refused or not. The write cap counts only what
// reaches GitHub, but every attempt makes the relay store and check a bundle
// of up to 64 MiB: this bounds the disk and the work the dev VM can cost it.
export const PUBLISH_ATTEMPTS_PER_HOUR = 60;

// Counts one publish attempt, before its bundle is read. `now` is in ms.
export function takeAttempt(s: RelayState, now: number): void {
  s.attempts = s.attempts.filter((t) => t > now - HOUR_MS);
  if (s.attempts.length >= PUBLISH_ATTEMPTS_PER_HOUR) {
    throw new RelayError(`publish attempt cap reached: ${PUBLISH_ATTEMPTS_PER_HOUR} in the last hour; try again in ${minutesUntil(s.attempts, now)}`);
  }
  s.attempts.push(now);
}
