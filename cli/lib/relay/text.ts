// Ce que le bot écrit en public (corps de PR, commentaires, réponses). Le
// texte vient de la VM de dev, donc d'un agent : il ne doit ni notifier un
// inconnu, ni pointer vers un autre dépôt.
import type { RelayConfig } from "./config.ts";
import { RelayError } from "./config.ts";

// Les blocs de code et les spans de code : ce qu'ils contiennent ne notifie
// personne, on n'y touche pas.
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

// Un `@` ni précédé d'un caractère de mot (une adresse e-mail) ni d'un
// guillemet inversé, suivi d'un login ou de `org/team`.
const MENTION = /(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?)/g;

// Les mentions hors code d'inconnus (et toute équipe) passent dans un span de
// code, qui ne notifie pas. `allowed` est en minuscules.
export function neutralizeMentions(text: string, allowed: readonly string[]): string {
  const fix = (s: string) =>
    s.replace(MENTION, (m, name: string) => (!name.includes("/") && allowed.includes(name.toLowerCase()) ? m : `\`${m}\``));
  let out = "";
  let last = 0;
  for (const code of text.matchAll(CODE)) {
    out += fix(text.slice(last, code.index)) + code[0];
    last = code.index + code[0].length;
  }
  return out + fix(text.slice(last));
}

// owner/repo#N, owner/repo@sha, et les URL github.com vers un ticket, une PR,
// une discussion ou un commit. Le lookbehind évite de relire l'intérieur d'une
// URL ou d'un chemin.
const REFERENCE = new RegExp(
  [
    String.raw`https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/(?:issues|pull|discussions|commit)/\w+`,
    String.raw`(?<![\w/.-])([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(?:#\d+|@[0-9a-f]{7,40}(?!\w))`,
  ].join("|"),
  "g",
);

// Les références à un dépôt autre que `upstream` (insensible à la casse), dans
// l'ordre du texte. Une URL est rapportée sans la fin de son chemin.
export function crossReferences(text: string, upstream: string): string[] {
  const own = upstream.toLowerCase();
  const found: string[] = [];
  for (const m of text.matchAll(REFERENCE)) {
    const owner = m[1] ?? m[3];
    const name = m[2] ?? m[4];
    if (`${owner}/${name}`.toLowerCase() === own) continue;
    found.push(m[0]);
  }
  return found;
}

// Refuse un texte trop long ou qui pointe vers un autre dépôt ; rend le texte
// avec les mentions neutralisées (autorisés : les logins de confiance et le bot).
export function checkPublicText(text: string, cfg: RelayConfig, max: number, what: string): string {
  if (text.length > max) throw new RelayError(`${what} is longer than ${max} characters`);
  const refs = crossReferences(text, cfg.upstream);
  if (refs.length > 0) throw new RelayError(`${what} refers to another repository (${refs.join(", ")}): only ${cfg.upstream} may be referenced`);
  return neutralizeMentions(text, [...cfg.trustedLogins, cfg.botLogin].map((l) => l.toLowerCase()));
}
