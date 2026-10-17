// Declarative convergence (spec "Convergence rules"): read an object with
// `list -f json`, compare it field by field with its desired state, and write
// the whole object only when it differs. A second run therefore makes no
// mutating call at all.
import type { Context } from "./context.ts";
import { ForgeError, mustSucceed } from "./context.ts";
import type { IncusObject, ObjectKind } from "./incus.ts";
import { createObject, editObject, listObjects } from "./incus.ts";

export type Outcome = "created" | "updated" | "unchanged";

export type DesiredObject = {
  description: string;
  config: Record<string, string>;
  devices?: Record<string, Record<string, string>>;
  ingress?: Record<string, string>[];
  egress?: Record<string, string>[];
};

// JSON with its keys sorted at every level: two objects that differ only by
// key order compare equal.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

// volatile.* keys belong to Incus: never compared, always carried over.
function splitVolatile(config: Record<string, string> = {}) {
  const own: Record<string, string> = {};
  const volatile: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) (k.startsWith("volatile.") ? volatile : own)[k] = v;
  return { own, volatile };
}

// Incus may list a rule with its empty fields as "", or leave them out: both
// are the same rule.
function rules(list: Record<string, string>[] = []): Record<string, string>[] {
  return list.map((rule) => Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== "")));
}

export function differs(desired: DesiredObject, current: IncusObject): boolean {
  if ((current.description ?? "") !== desired.description) return true;
  if (canonical(splitVolatile(current.config).own) !== canonical(desired.config)) return true;
  if (desired.devices && canonical(current.devices ?? {}) !== canonical(desired.devices)) return true;
  if (desired.ingress && canonical(rules(current.ingress)) !== canonical(rules(desired.ingress))) return true;
  if (desired.egress && canonical(rules(current.egress)) !== canonical(rules(desired.egress))) return true;
  return false;
}

export async function converge(
  ctx: Context, kind: ObjectKind, name: string, desired: DesiredObject,
): Promise<{ outcome: Outcome; previous: IncusObject | undefined }> {
  const previous = (await listObjects(ctx, kind)).find((o) => o.name === name);
  if (!previous) {
    await mustSucceed(`create ${kind} ${name}`, createObject(ctx, kind, name, desired));
    return { outcome: "created", previous };
  }
  if (!differs(desired, previous)) return { outcome: "unchanged", previous };
  const body = { ...desired, config: { ...desired.config, ...splitVolatile(previous.config).volatile } };
  await mustSucceed(`update ${kind} ${name}`, editObject(ctx, kind, name, body));
  return { outcome: "updated", previous };
}

// The project is created when missing and only checked when present: on a
// multi-user host (B) it belongs to an administrator, so forge never edits it.
export async function ensureProject(
  ctx: Context, name: string, desired: DesiredObject,
): Promise<{ outcome: "created" | "unchanged"; config: Record<string, string> }> {
  const current = (await listObjects(ctx, "project")).find((p) => p.name === name);
  if (!current) {
    await mustSucceed(`create project ${name}`, createObject(ctx, "project", name, desired));
    return { outcome: "created", config: desired.config };
  }
  const config = current.config ?? {};
  const wrong = Object.entries(desired.config).filter(([k, v]) => config[k] !== v);
  if (wrong.length > 0) {
    const list = wrong.map(([k, v]) => `${k}=${config[k] ?? "(unset)"} (forge needs ${v})`).join(", ");
    throw new ForgeError(
      `Incus project ${name} exists with ${list}. forge never edits an existing project, which may belong to an ` +
      `administrator. If it is yours, fix it with 'incus project set ${name} <key> <value>' ` +
      "(Incus only changes the features of an empty project).");
  }
  return { outcome: "unchanged", config };
}
