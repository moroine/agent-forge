// Une ligne par container, suivie d'une ligne indentée par worktree.
//
// Deux colonnes ont disparu parce qu'elles étaient déductibles et faisaient
// wrapper la sortie : le nom du container (toujours agent-<repo assaini>) et
// la branche d'une tâche (toujours agent/<task>).
import type { Context } from "../context.ts";
import { columnWidths, formatRow } from "../table.ts";
import { forgeProject, listInstances } from "../incus.ts";
import { effectiveEgress, egressNames } from "../objects.ts";
import {
  buildStatus, containerImageCommit, containerMode, containerRepo,
  latestImageCommit, forgeContainerNames,
} from "../containers.ts";
import { sessionStates, taskNames } from "../worktrees.ts";

const HEADER = ["REPO", "MODE", "EGRESS", "STATE", "BUILD"];

type Entry = { cells: string[]; tasks: string[][] };

function buildLabel(status: string): string {
  if (status === "up-to-date") return "ok";
  if (status === "behind") return "behind";
  return "unknown";
}

export async function cmdList(ctx: Context): Promise<number> {
  // Une seule image de base : son commit est lu une fois pour toute la commande.
  const latest = await latestImageCommit(ctx);
  const entries: Entry[] = [];

  // Un seul `incus list` pour toute la commande : instanceStatus le relançait
  // en entier par container, soit N+1 listings complets là où un index par
  // nom suffit. `forge list` est la commande la plus lancée.
  const instances = await listInstances(ctx);
  const statuses = new Map(instances.map((i) => [i.name, i.status]));
  const byName = new Map(instances.map((i) => [i.name, i]));
  const names = egressNames(forgeProject());

  for (const name of forgeContainerNames(instances)) {
    const repo = await containerRepo(ctx, name);
    const mode = await containerMode(ctx, name);
    const status = statuses.get(name) ?? "Unknown";
    // Dérivé de la NIC effective, pas du marqueur : une modification manuelle
    // doit se voir (« ? »).
    const egress = effectiveEgress(byName.get(name)?.expandedDevices ?? {}, names);
    const stamp = await containerImageCommit(ctx, name);

    const entry: Entry = {
      // Un container sans métadonnée repo n'a que son nom comme identifiant.
      cells: [repo || name, mode || "-", egress, status, buildLabel(buildStatus(stamp, latest))],
      tasks: [],
    };

    // Un container arrêté ne peut pas être inspecté.
    if (status === "Running") {
      const sessions = await sessionStates(ctx, name);
      for (const task of await taskNames(ctx, name)) {
        const attached = sessions.get(task);
        const state = attached === undefined ? "no session" : attached ? "attached" : "detached";
        entry.tasks.push([task, state]);
      }
    }
    entries.push(entry);
  }

  const widths = columnWidths([HEADER, ...entries.map((e) => e.cells)]);
  const taskWidths = columnWidths(entries.flatMap((e) => e.tasks));

  ctx.out(formatRow(HEADER, widths));
  for (const entry of entries) {
    ctx.out(formatRow(entry.cells, widths));
    for (const task of entry.tasks) ctx.out(formatRow(task, taskWidths, "  "));
  }
  return 0;
}
