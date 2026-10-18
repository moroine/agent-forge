// Couche transport : parle à Incus, ne sait rien de forge. Tout ce qui est
// spécifique au domaine vit dans containers.ts / worktrees.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError, type Context, type ExecResult } from "./context.ts";

export type Instance = {
  name: string;
  status: string;
  config: Record<string, string>;
  // Les devices locaux de l'instance, sans ceux de ses profils.
  devices: Record<string, Record<string, string>>;
  expandedDevices: Record<string, Record<string, string>>;
  ipv4: string[];
};

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
    type Raw = {
      name: string; status: string; config?: Record<string, string>;
      devices?: Record<string, Record<string, string>>;
      expanded_devices?: Record<string, Record<string, string>>;
      state?: { network?: { eth0?: { addresses?: { family?: string; address?: string }[] } } };
    };
    return parsed
      .filter((i): i is Raw =>
        typeof i === "object" && i !== null &&
        typeof (i as Raw).name === "string" &&
        typeof (i as Raw).status === "string")
      .map((i) => ({
        name: i.name,
        status: i.status,
        config: i.config ?? {},
        devices: i.devices ?? {},
        expandedDevices: i.expanded_devices ?? {},
        // Les JSON minimaux (tests) n'ont ni state ni adresses.
        ipv4: (i.state?.network?.eth0?.addresses ?? [])
          .filter((a) => a.family === "inet" && typeof a.address === "string")
          .map((a) => a.address as string),
      }));
  } catch {
    return [];
  }
}

export type Lease = { hostname: string; address: string };

// Sonde : les baux DHCP d'un réseau, ceux des instances arrêtées compris
// (`incus list` ne leur montre plus d'adresse). Le bridge vit dans `default`,
// atteint par --project comme les autres commandes réseau. Le hostname d'un
// bail dynamique est celui que le client a envoyé. Un échec vaut « aucun bail ».
export async function listLeases(ctx: Context, network: string): Promise<Lease[]> {
  const r = await ctx.exec(incus("network", "list-leases", network, "-f", "json"));
  if (r.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l): l is Lease =>
        typeof l === "object" && l !== null &&
        typeof (l as Lease).hostname === "string" && typeof (l as Lease).address === "string")
      .map((l) => ({ hostname: l.hostname, address: l.address }));
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

// Sonde : les noms des devices de l'instance, [] en cas d'échec.
export async function deviceNames(ctx: Context, name: string): Promise<string[]> {
  const r = await ctx.exec(incus("config", "device", "list", name));
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
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

// La commande de l'agent doit rester l'enfant direct de `incus exec` : avec un
// `su - aiuser -c` intermédiaire, SIGWINCH n'atteint jamais l'agent quand le
// terminal hôte est redimensionné (diagnostiqué le 2026-08-31, commit c34a145).
// --user/--group/--cwd remplacent `su - aiuser` + `cd`. HOME vient du profil,
// mais pas TERM : plus aucun shell de login ne le pose, on le transmet.
export function attachArgv(container: string, task: string, term: string, command: string[]): string[] {
  return [
    ...incus("exec", container),
    "--user", "1001", "--group", "1001",
    "--cwd", `/workspace/.trees/${task}`,
    "--env", `TERM=${term}`,
    "--", ...command,
  ];
}

export type ServerInfo = { environment?: { firewall?: string; server_version?: string } };

// `incus query /1.0` rend les infos du serveur en JSON — les mêmes que
// `incus info`, sans parseur YAML. Niveau hôte : pas de --project.
export async function serverInfo(ctx: Context): Promise<{ ok: true; info: ServerInfo } | { ok: false; error: string }> {
  const r = await ctx.exec(["incus", "query", "/1.0"]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit code ${r.code}` };
  try {
    return { ok: true, info: JSON.parse(r.stdout) as ServerInfo };
  } catch {
    return { ok: false, error: "unreadable answer to incus query /1.0" };
  }
}

// Sonde : les pools sont globaux, pas de --project.
export async function storagePoolExists(ctx: Context, name: string): Promise<boolean> {
  const r = await ctx.exec(["incus", "storage", "list", "-f", "json"]);
  if (r.code !== 0) return false;
  try {
    const pools: unknown = JSON.parse(r.stdout);
    return Array.isArray(pools) && pools.some((p) => (p as { name?: unknown })?.name === name);
  } catch {
    return false;
  }
}

// Les objets que `forge setup` possède. Les réseaux et les ACL passent aussi
// par --project : avec features.networks=false, Incus les résout dans
// `default`, et un utilisateur restreint (B) ne peut pas forcément nommer ce
// projet-là. Les projets, eux, sont globaux.
export type ObjectKind = "project" | "network" | "network acl" | "profile";

export type IncusObject = {
  name: string;
  description?: string;
  config?: Record<string, string>;
  devices?: Record<string, Record<string, string>>;
  ingress?: Record<string, string>[];
  egress?: Record<string, string>[];
};

function objectArgv(kind: ObjectKind, ...args: string[]): string[] {
  const words = kind.split(" ");
  return kind === "project" ? ["incus", ...words, ...args] : incus(...words, ...args);
}

// Sonde : une liste en échec ou illisible vaut « aucun objet ». La création
// qui suit échoue alors avec le message d'Incus, remonté par mustSucceed.
export async function listObjects(ctx: Context, kind: ObjectKind): Promise<IncusObject[]> {
  const r = await ctx.exec(objectArgv(kind, "list", "-f", "json"));
  if (r.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is IncusObject =>
      typeof o === "object" && o !== null && typeof (o as IncusObject).name === "string");
  } catch {
    return [];
  }
}

// L'objet entier passe sur stdin, en JSON (YAML 1.2 en est un sur-ensemble).
// Jamais via ctx.attach : `create`/`edit` lisent stdin dès qu'il n'est pas un
// terminal, et un stdin vide remplacerait l'objet par un objet vide.
export function createObject(ctx: Context, kind: ObjectKind, name: string, body: object): Promise<ExecResult> {
  return ctx.exec(objectArgv(kind, "create", name), { input: JSON.stringify(body) });
}

export function editObject(ctx: Context, kind: ObjectKind, name: string, body: object): Promise<ExecResult> {
  return ctx.exec(objectArgv(kind, "edit", name), { input: JSON.stringify(body) });
}

// Attend que systemd ait fini de démarrer l'instance. `degraded` compte pour
// prêt : une unité en échec (souvent liée au matériel dans un container) ne
// doit pas bloquer forge. Partagé par le build d'image et le provisioning.
// Juste après `launch`, systemctl ne répond rien (le bus n'est pas encore là)
// ou répond `offline` (systemd n'est pas encore PID 1) avant de donner un vrai
// état : on réessaie tant que l'état est vide ou `offline`. Tout autre état
// (maintenance, stopping...) échoue aussitôt.
export async function waitReady(
  ctx: Context, name: string, opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 60;
  const delayMs = opts.delayMs ?? 1000;
  for (let i = 1; ; i++) {
    const r = await ctx.exec(incus("exec", name, "--", "systemctl", "is-system-running", "--wait"));
    const state = r.stdout.trim();
    if (state === "running" || state === "degraded") return;
    if ((state !== "" && state !== "offline") || i >= attempts) {
      throw new ForgeError(
        `${name} did not finish booting (systemd state: ${state || "unknown"}): ${r.stderr.trim() || `exit code ${r.code}`}`);
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
}

// Sonde : l'empreinte de l'image qui porte l'alias, ou null.
export async function imageFingerprint(ctx: Context, alias: string): Promise<string | null> {
  const r = await ctx.exec(incus("image", "list", "-f", "json"));
  if (r.code !== 0) return null;
  try {
    const images = JSON.parse(r.stdout) as { fingerprint?: string; aliases?: { name?: string }[] }[];
    return images.find((i) => i.aliases?.some((a) => a.name === alias))?.fingerprint ?? null;
  } catch {
    return null;
  }
}

// Comme execAsAgent, mais sans shell : chaque valeur est un élément d'argv.
// Pour les valeurs venues de l'hôte (l'identité git : apostrophes, espaces,
// accents), qui n'ont pas de jeu de caractères à valider.
export function execAsAgentArgv(ctx: Context, name: string, argv: string[]): Promise<ExecResult> {
  return ctx.exec(incus("exec", name, "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", ...argv));
}

export async function imageExists(ctx: Context, alias: string): Promise<boolean> {
  return (await ctx.exec(incus("image", "info", alias))).code === 0;
}

// Écrit le contenu dans un fichier temporaire (répertoire neuf, retiré dans
// tous les cas) puis le pousse avec son propriétaire et son mode.
export async function pushText(
  ctx: Context, instance: string, dest: string, content: string,
  owner: { uid: number; gid: number; mode: string },
): Promise<ExecResult> {
  const dir = mkdtempSync(join(tmpdir(), "forge-push-"));
  try {
    const src = join(dir, "content");
    writeFileSync(src, content);
    return await ctx.exec(incus(
      "file", "push", src, `${instance}${dest}`,
      "--uid", String(owner.uid), "--gid", String(owner.gid), "--mode", owner.mode, "--create-dirs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sonde : null si le fichier n'existe pas (ou n'est pas lisible).
export async function pullText(ctx: Context, instance: string, path: string): Promise<string | null> {
  const r = await ctx.exec(incus("file", "pull", `${instance}${path}`, "-"));
  return r.code === 0 ? r.stdout : null;
}

function kv(pairs: Record<string, string>): string[] {
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
}

export function configSetMany(ctx: Context, instance: string, pairs: Record<string, string>): Promise<ExecResult> {
  return ctx.exec(incus("config", "set", instance, ...kv(pairs)));
}

export function configUnset(ctx: Context, instance: string, key: string): Promise<ExecResult> {
  return ctx.exec(incus("config", "unset", instance, key));
}

// override : crée un device local qui masque celui du profil ; set : modifie
// un device local existant.
export function deviceOverride(ctx: Context, instance: string, device: string, pairs: Record<string, string>): Promise<ExecResult> {
  return ctx.exec(incus("config", "device", "override", instance, device, ...kv(pairs)));
}

export function deviceSet(ctx: Context, instance: string, device: string, pairs: Record<string, string>): Promise<ExecResult> {
  return ctx.exec(incus("config", "device", "set", instance, device, ...kv(pairs)));
}

export function deviceRemove(ctx: Context, instance: string, device: string): Promise<ExecResult> {
  return ctx.exec(incus("config", "device", "remove", instance, device));
}

export function restartInstance(ctx: Context, name: string): Promise<ExecResult> {
  return ctx.exec(incus("restart", name));
}

// Comme execAsAgentArgv mais en root, avec un environnement explicite.
export function execArgv(ctx: Context, name: string, argv: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  return ctx.exec(incus("exec", name, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", ...argv));
}

// Récupération du travail de l'agent : `git-upload-pack` tourne dans le
// container en tant qu'aiuser, pas sur l'hôte. --force-noninteractive (forme
// longue de -T) : pas de pty, stdout porte le protocole git. GIT_PROTOCOL
// n'est transmis que s'il a la forme `version=N`.
export function uploadPackArgv(container: string, gitProtocol: string | undefined): string[] {
  const protocol = gitProtocol !== undefined && /^version=[0-9]$/.test(gitProtocol)
    ? ["--env", `GIT_PROTOCOL=${gitProtocol}`]
    : [];
  return [
    ...incus("exec", container, "--force-noninteractive"),
    "--user", "1001", "--group", "1001",
    "--cwd", "/workspace",
    "--env", "HOME=/home/aiuser",
    ...protocol,
    "--", "git-upload-pack", "/workspace",
  ];
}
