// Une ligne par repo, suivie d'une ligne indentée par tâche.
//
// Deux colonnes ont disparu parce qu'elles étaient déductibles et faisaient
// wrapper la sortie : le nom du container (toujours agent-<repo assaini>) et
// la branche d'une tâche (toujours agent/<task>).
import type { Context } from "../context.ts";
import { columnWidths, formatRow } from "../table.ts";
import {
  ROLE_TASK, ROLE_TEMPLATE, baseImageFor, buildStatus, containerImageCommit,
  describeContainers, isLegacy, latestImageCommitFor,
} from "../containers.ts";
import { sessionStates } from "../worktrees.ts";

const HEADER = ["REPO", "MODE", "TEMPLATE"];

type Entry = { cells: string[]; tasks: string[][] };

function buildLabel(status: string): string {
  if (status === "up-to-date") return "ok";
  if (status === "behind") return "behind";
  return "unknown";
}

export async function cmdList(ctx: Context): Promise<number> {
  // Deux images de base seulement : agent-base (autonomous/supervised) et
  // agent-base-super (super). On lit chaque commit une fois, puis on choisit
  // par mode dans la boucle — pas de requête image par container.
  const latestByMode = new Map<string, string>([
    ["agent-base", await latestImageCommitFor(ctx, "autonomous")],
    ["agent-base-super", await latestImageCommitFor(ctx, "super")],
  ]);

  // Un seul `lxc list` pour toute la commande : instanceStatus le relançait en
  // entier par container, soit N+1 listings complets là où un index par nom
  // suffit. `forge list` est la commande la plus lancée.
  const all = await describeContainers(ctx);
  const repos: string[] = [];
  for (const c of all) if (c.repo && !repos.includes(c.repo)) repos.push(c.repo);

  const entries: Entry[] = [];
  const legacy: string[] = [];

  for (const repo of repos) {
    const mine = all.filter((c) => c.repo === repo);
    for (const c of mine.filter(isLegacy)) legacy.push(c.name);

    const template = mine.find((c) => c.role === ROLE_TEMPLATE);
    const mode = template?.mode || mine[0]?.mode || "-";
    let build = "missing";
    if (template) {
      const stamp = await containerImageCommit(ctx, template.name);
      const latest = latestByMode.get(baseImageFor(template.mode)) ?? "";
      build = buildLabel(buildStatus(stamp, latest));
    }

    const entry: Entry = { cells: [repo, mode, build], tasks: [] };
    for (const c of mine.filter((x) => x.role === ROLE_TASK)) {
      // Un container arrêté ne peut pas être inspecté.
      let session = "—";
      if (c.status === "Running") {
        const attached = (await sessionStates(ctx, c.name)).get(c.task);
        session = attached === undefined ? "no session" : attached ? "attached" : "detached";
      }
      entry.tasks.push([c.task, c.status, session]);
    }
    entries.push(entry);
  }

  const widths = columnWidths([HEADER, ...entries.map((e) => e.cells)]);
  const taskWidths = columnWidths(entries.flatMap((e) => e.tasks));
  ctx.out(formatRow(HEADER, widths));
  for (const entry of entries) {
    ctx.out(formatRow(entry.cells, widths));
    for (const t of entry.tasks) ctx.out(formatRow(t, taskWidths, "  "));
  }
  for (const name of legacy) {
    ctx.out(`${name}: old model (no user.forge.role) — recreate it: forge delete + forge start`);
  }
  return 0;
}
