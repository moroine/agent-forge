// Ce que le bot écrit en public (corps de PR, commentaires, réponses). Le
// texte vient de la VM de dev, donc d'un agent : il ne doit ni notifier un
// inconnu, ni pointer vers un autre dépôt.
import type { RelayConfig } from "./config.ts";
import { RelayError } from "./config.ts";

// Les spans de code selon CommonMark : une suite de N guillemets inversés
// ouvre un span, qui se ferme à la prochaine suite d'exactement N (il peut
// couvrir des lignes). Une suite sans fermeture est du texte. Hors d'un span,
// un guillemet précédé d'un nombre impair d'antislashs est échappé : texte
// littéral, il n'ouvre rien (le reste de sa suite, si elle continue, ouvre
// normalement). Dans un span les antislashs sont littéraux : une fermeture
// n'est jamais échappée. Ce qu'un span
// contient ne notifie personne, on n'y touche pas. Rend les spans [début, fin[.
function codeSpans(text: string): [number, number][] {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const spans: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    let { at, len } = runs[i];
    let slashes = 0;
    while (at - slashes > 0 && text[at - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 1) {
      at++;
      len--;
      if (len === 0) continue;
    }
    const close = runs.findIndex((r, j) => j > i && r.len === len);
    if (close === -1) continue;
    spans.push([at, runs[close].at + runs[close].len]);
    i = close;
  }
  return spans;
}

// Un `@` qui n'est pas précédé d'un caractère de mot (une adresse e-mail),
// suivi d'un login ou de `org/team`. Un guillemet inversé avant lui ne le
// protège pas : seul un vrai span (codeSpans) le fait.
const MENTION = /(?<!\w)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?)/g;

// Les mentions hors code d'inconnus (et toute équipe) passent dans un span de
// code, qui ne notifie pas. `allowed` est en minuscules.
export function neutralizeMentions(text: string, allowed: readonly string[]): string {
  // Une suite de guillemets plus longue que toutes celles du texte ne peut se
  // fermer sur aucune autre : le span qu'on ajoute reste un span.
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  // Entre deux spans, `after` dit si un span suit : une mention collée à un
  // guillemet inversé ou à un antislash (qui échapperait notre ouverture) reçoit une espace, sinon sa clôture se fondrait dans la suite.
  const fix = (s: string, spanBefore: boolean, spanAfter: boolean) =>
    s.replace(MENTION, (m, name: string, at: number) => {
      if (!name.includes("/") && allowed.includes(name.toLowerCase())) return m;
      const prev = at > 0 ? s[at - 1] : spanBefore ? "`" : "";
      const next = at + m.length < s.length ? s[at + m.length] : spanAfter ? "`" : "";
      return `${prev === "`" || prev === "\\" ? " " : ""}${fence}${m}${fence}${next === "`" ? " " : ""}`;
    });
  let out = "";
  let last = 0;
  for (const [start, end] of codeSpans(text)) {
    out += fix(text.slice(last, start), last > 0, true) + text.slice(start, end);
    last = end;
  }
  return out + fix(text.slice(last), last > 0, false);
}

// owner/repo#N, owner/repo@sha, et les URL github.com vers un ticket, une PR,
// une discussion ou un commit, avec ou sans schéma ni `www.` (GitHub transforme
// aussi ces formes en liens), en toute casse. Un `.` ou un `-` avant une
// référence ne la cache pas : on refuse dans le doute, l'agent reformule.
const REFERENCE = new RegExp(
  [
    String.raw`(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/(?:issues|pull|discussions|commit)/\w+`,
    String.raw`(?<![\w/])([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)(?:#\d+|@[0-9a-f]{7,40}(?!\w))`,
  ].join("|"),
  "gi",
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
  const refs = crossReferences(text, cfg.upstream);
  if (refs.length > 0) throw new RelayError(`${what} refers to another repository (${refs.join(", ")}): only ${cfg.upstream} may be referenced`);
  // La longueur compte le texte publié, après neutralisation : elle l'allonge.
  const out = neutralizeMentions(text, [...cfg.trustedLogins, cfg.botLogin].map((l) => l.toLowerCase()));
  if (out.length > max) throw new RelayError(`${what} is longer than ${max} characters`);
  return out;
}
