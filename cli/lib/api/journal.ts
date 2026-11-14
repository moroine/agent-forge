// Le journal de l'API (DX 5, §5.4) : des lignes JSON ajoutées, jamais
// réécrites. C'est la piste d'audit et la source de l'état d'attente.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiDataDir } from "../paths.ts";
import type { Op } from "./protocol.ts";

// `op` est null pour une ligne que le protocole n'a pas pu lire : elle n'a pas de verbe.
export type Entry = {
  id: number; time: string; caller: string; op: Op | null; to: string | null; task: string | null;
  outcome: "ok" | "refused"; error: string | null;
  summary: string | null; // message, ask-human
  text: string | null; // le corps d'un message ou d'une question, la consigne d'un assign
};

export function journalPath(): string {
  return join(apiDataDir(), "journal.jsonl");
}

export class Journal {
  private next: number;
  private readonly path: string;
  private readonly list: Entry[];

  private constructor(path: string, list: Entry[]) {
    this.path = path;
    this.list = list;
    this.next = list.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  // Une ligne illisible arrête l'ouverture, avec son numéro : le journal est une
  // piste d'audit, on ne le répare pas en silence.
  static open(path: string): Journal {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
    const list: Entry[] = [];
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (line === "") return;
      try {
        list.push(JSON.parse(line) as Entry);
      } catch {
        throw new ForgeError(`${path} line ${i + 1} is not valid JSON: the journal is never rewritten, fix or move it`);
      }
    });
    return new Journal(path, list);
  }

  // L'identifiant se prend tout de suite : deux messages simultanés n'en
  // partagent jamais un.
  reserve(): number {
    return this.next++;
  }

  append(e: Omit<Entry, "id" | "time">, now: Date, id?: number): Entry {
    const entry: Entry = { id: id ?? this.reserve(), time: now.toISOString(), ...e };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.list.push(entry);
    return entry;
  }

  entries(): readonly Entry[] {
    return this.list;
  }
}

// Ce que `container` attend : `human` après une question, le nom d'un container
// après un message, tant que celui-ci n'a pas répondu par un message. La moitié
// « sa session ne travaille pas » de la règle est celle de l'appelant.
export function waitingOn(entries: readonly Entry[], container: string): string | null {
  const ok = entries.filter((e) => e.outcome === "ok");
  const lastIndex = ok.findLastIndex((e) => e.caller === container && (e.op === "message" || e.op === "ask-human"));
  if (lastIndex < 0) return null;
  const last = ok[lastIndex];
  if (last.op === "ask-human") return "human";
  const answered = ok.slice(lastIndex + 1).some((e) => e.op === "message" && e.caller === last.to && e.to === container);
  return answered ? null : last.to;
}
