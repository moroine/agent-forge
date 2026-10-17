// Couche transport : parle à Incus, ne sait rien de forge. Tout ce qui est
// spécifique au domaine vit dans containers.ts / worktrees.ts.
import type { Context, ExecResult } from "./context.ts";

export type Instance = { name: string; status: string };

export const DEFAULT_PROJECT = "agent-forge";

// Instances, profils et images de forge vivent dans un projet Incus à part :
// forge ne voit ni ne touche rien d'autre sur l'Incus de l'hôte.
// FORGE_INCUS_PROJECT pointe le CLI vers un projet jetable : il sert aux
// tests et n'est délibérément pas documenté pour les utilisateurs.
export function forgeProject(): string {
  return process.env.FORGE_INCUS_PROJECT || DEFAULT_PROJECT;
}

// Préfixe de tout appel qui touche un objet du projet.
export function incus(...args: string[]): string[] {
  return ["incus", "--project", forgeProject(), ...args];
}

// `incus list -f json` est analysé par JSON.parse : le CLI n'a pas besoin de
// jq sur l'hôte.
export async function listInstances(ctx: Context): Promise<Instance[]> {
  const r = await ctx.exec(incus("list", "-f", "json"));
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
  return (await ctx.exec(incus("info", name))).code === 0;
}

export async function configGet(ctx: Context, name: string, key: string): Promise<string> {
  const r = await ctx.exec(incus("config", "get", name, key));
  return r.code === 0 ? r.stdout.trim() : "";
}

// Les mutateurs ci-dessous rendent leur ExecResult au lieu de le jeter :
// c'est l'appelant qui décide (via mustSucceed) d'échouer bruyamment. Renvoyer
// void revenait à avaler le code de sortie ET le stderr capturé.
export function configSet(ctx: Context, name: string, key: string, value: string): Promise<ExecResult> {
  return ctx.exec(incus("config", "set", name, key, value));
}

export async function imageProperty(ctx: Context, alias: string, key: string): Promise<string> {
  const r = await ctx.exec(incus("image", "get-property", alias, key));
  return r.code === 0 ? r.stdout.trim() : "";
}

// Le script est un seul élément d'argv : aucun shell hôte ne le réinterprète
// avant `su`. La validation des noms interpolés dedans reste indispensable
// (validate.ts).
export function execAsAgent(ctx: Context, name: string, script: string): Promise<ExecResult> {
  return ctx.exec(incus("exec", name, "--", "su", "-", "aiuser", "-c", script));
}

export function startInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(incus("start", name));
}

export function stopInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(incus("stop", name));
}

export function deleteInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(incus("delete", name, "--force"));
}

// tmux DOIT rester la cible directe de `incus exec` : avec un `su - aiuser -c`
// intermédiaire, SIGWINCH n'atteint jamais le client tmux quand le terminal
// hôte est redimensionné (diagnostiqué le 2026-08-31, commit c34a145).
// --user/--group/--cwd remplacent `su - aiuser` + `cd`. HOME vient du profil,
// mais pas TERM : plus aucun shell de login ne le pose, on le transmet.
// `exec bash -lc` sous tmux restaure DOCKER_HOST, exporté depuis .bashrc.
// Le sous-projet 4 remplace tmux par herdr.
export function attachArgv(container: string, task: string, term: string): string[] {
  return [
    ...incus("exec", container),
    "--user", "1001", "--group", "1001",
    "--cwd", `/workspace/.trees/${task}`,
    "--env", `TERM=${term}`,
    "--", "tmux", "new-session", "-A", "-s", task,
    `exec bash -lc 'claude --permission-mode auto --remote-control ${container}-${task}'`,
  ];
}
