// Couche transport : parle à LXD, ne sait rien de forge. Tout ce qui est
// spécifique au domaine vit dans containers.ts / worktrees.ts.
import type { Context, ExecResult } from "./context.ts";

export type Instance = { name: string; status: string };

// `lxc list -f json` est analysé par JSON.parse : le CLI n'a plus besoin de jq
// sur l'hôte.
export async function listInstances(ctx: Context): Promise<Instance[]> {
  const r = await ctx.exec(["lxc", "list", "-f", "json"]);
  if (r.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i): i is Instance =>
        typeof i === "object" && i !== null &&
        typeof (i as Instance).name === "string" &&
        typeof (i as Instance).status === "string")
      .map((i) => ({ name: i.name, status: i.status }));
  } catch {
    return [];
  }
}

export async function instanceStatus(ctx: Context, name: string): Promise<string | null> {
  const found = (await listInstances(ctx)).find((i) => i.name === name);
  return found ? found.status : null;
}

export async function instanceExists(ctx: Context, name: string): Promise<boolean> {
  return (await ctx.exec(["lxc", "info", name])).code === 0;
}

export async function configGet(ctx: Context, name: string, key: string): Promise<string> {
  const r = await ctx.exec(["lxc", "config", "get", name, key]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Les quatre mutateurs ci-dessous rendent leur ExecResult au lieu de le jeter :
// c'est l'appelant qui décide (via mustSucceed) d'échouer bruyamment. Renvoyer
// void revenait à avaler le code de sortie ET le stderr capturé.
export function configSet(ctx: Context, name: string, key: string, value: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "config", "set", name, key, value]);
}

export async function imageProperty(ctx: Context, alias: string, key: string): Promise<string> {
  const r = await ctx.exec(["lxc", "image", "get-property", alias, key]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Le script est un seul élément d'argv : aucun shell hôte ne le réinterprète
// avant `su`. C'est plus sûr que l'original bash, mais la validation des noms
// interpolés dedans reste indispensable (validate.ts).
export function execAsAgent(ctx: Context, name: string, script: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "exec", name, "--", "su", "-", "aiuser", "-c", script]);
}

export function startInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "start", name]);
}

export function stopInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "stop", name]);
}

export function deleteInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "delete", name, "--force"]);
}

// Copie d'instance : la source DOIT être stoppée (voir §1 de la spec — un
// rootfs copié en cours d'écriture emporte un containerd/dqlite incohérent).
// Le device `workspace` fait partie de la config d'instance, donc la copie
// pointe sur le même répertoire hôte : c'est exactement ce qu'on veut.
export function copyInstance(ctx: Context, source: string, target: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "copy", source, target]);
}

export function addDiskDevice(
  ctx: Context, name: string, device: string, source: string, path: string, readonly = false,
): Promise<ExecResult> {
  const argv = ["lxc", "config", "device", "add", name, device, "disk",
    `source=${source}`, `path=${path}`];
  if (readonly) argv.push("readonly=true");
  return ctx.exec(argv);
}

// tmux DOIT rester la cible directe de `lxc exec` : avec un `su - aiuser -c`
// intermédiaire, SIGWINCH n'atteint jamais le client tmux quand le terminal
// hôte est redimensionné (diagnostiqué le 2026-08-31, commit c34a145).
// --user/--group/--cwd remplacent `su - aiuser` + `cd`. HOME vient du profil
// LXD, mais pas TERM : plus aucun shell de login ne le pose, on le transmet.
// `exec bash -lc` sous tmux restaure DOCKER_HOST, exporté depuis .bashrc.
// Le nom du container porte déjà la tâche : plus de suffixe.
export function attachArgv(container: string, task: string, term: string): string[] {
  return [
    "lxc", "exec", container,
    "--user", "1001", "--group", "1001",
    "--cwd", `/workspace/.trees/${task}`,
    "--env", `TERM=${term}`,
    "--", "tmux", "new-session", "-A", "-s", task,
    `exec bash -lc 'claude --permission-mode auto --remote-control ${container}'`,
  ];
}
