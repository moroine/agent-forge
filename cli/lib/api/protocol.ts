// Les requêtes de l'API entre containers (DX 5, §5.4). Tout ce qui arrive ici
// vient d'un agent : une requête est validée à la main, champ par champ, avant
// tout autre travail, comme celles du relais (relay/serve.ts). Un refus dit sa
// règle et ne répète jamais un secret.
import { ForgeError } from "../context.ts";
import { validateContainerName, validateTaskName } from "../validate.ts";

export const OPS = ["message", "assign", "release", "ask-human", "status"] as const;
export type Op = (typeof OPS)[number];

export type ApiRequest =
  | { op: "message"; to: string; summary: string; body: string | null }
  | { op: "assign"; to: string; task: string | null; text: string }
  | { op: "release"; to: string }
  | { op: "ask-human"; summary: string; body: string | null }
  | { op: "status" };

// Des plafonds contre un client emballé, pas une règle sur le contenu : le
// JSON peut multiplier un texte par six en l'échappant.
export const REQUEST_MAX = 2097152;
export const SUMMARY_MAX = 200; // des caractères (points de code)
export const BODY_MAX = 262144; // des octets UTF-8
export const INSTRUCTION_MAX = 65536; // des octets UTF-8

// Le résumé est tapé dans le terminal du destinataire, derrière le préfixe de
// forge : cette liste n'a ni `[` `]` `@`, ni accent grave, `$`, `\`, `<` `>`,
// ni caractère de contrôle. Il ne peut donc ni imiter le préfixe, ni joindre un
// fichier, ni appuyer sur une touche.
const SUMMARY_CHARS = String.raw`[\p{L}\p{M}\p{N} .,;:!?'"()\-_/#+=%&*’«»]`;
export const SUMMARY_ALLOWED = new RegExp(`^${SUMMARY_CHARS}+$`, "u");
// Le même jeu, pour un seul caractère : de quoi nommer le fautif.
const SUMMARY_CHAR = new RegExp(`^${SUMMARY_CHARS}$`, "u");

const PUT_IN_A_FILE = "put it in a file of your branch and send its path";

type Kind = "string" | "optional-string";
// Les champs exacts de chaque verbe ; `op` est lu à part.
const FIELDS: Record<Op, Record<string, Kind>> = {
  message: { to: "string", summary: "string", body: "optional-string" },
  assign: { to: "string", task: "optional-string", text: "string" },
  release: { to: "string" },
  "ask-human": { summary: "string", body: "optional-string" },
  status: {},
};

const hasSecret = (text: string, secrets: readonly string[]) => secrets.some((s) => s !== "" && text.includes(s));

// Le caractère fautif se nomme par son point de code : un caractère de
// contrôle ne s'affiche pas, et le reste du texte n'est pas répété.
function describeChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? hex : `${JSON.stringify(ch)} (${hex})`;
}

export function checkSummary(summary: string, secrets: readonly string[]): void {
  if (hasSecret(summary, secrets)) throw new ForgeError("the summary holds a secret forge handed out: remove it");
  if (summary.trim() === "") throw new ForgeError("the summary is empty");
  // Un point de code tient en deux unités UTF-16 au plus : au-delà, trop long
  // sans compter.
  if (summary.length > SUMMARY_MAX * 2 || [...summary].length > SUMMARY_MAX) {
    throw new ForgeError(`the summary is longer than ${SUMMARY_MAX} characters: shorten it, and put the rest in the body`);
  }
  for (const ch of summary) {
    if (!SUMMARY_CHAR.test(ch)) {
      throw new ForgeError(`the summary holds ${describeChar(ch)}, which is not allowed in a summary ` +
        "(letters, digits, spaces and . , ; : ! ? ' \" ( ) - _ / # + = % & * only): put it in the body");
    }
  }
}

// Un corps ou une consigne : tout contenu, caractères de contrôle compris,
// sauf le vide et un secret.
export function checkText(text: string, maxBytes: number, what: string, secrets: readonly string[]): void {
  if (text.trim() === "") throw new ForgeError(`the ${what} is empty`);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ForgeError(`the ${what} is longer than ${maxBytes} bytes: ${PUT_IN_A_FILE}`);
  }
  if (hasSecret(text, secrets)) throw new ForgeError(`the ${what} holds a secret forge handed out: remove it`);
}

export function parseRequest(line: string, secrets: readonly string[]): ApiRequest {
  if (Buffer.byteLength(line, "utf8") > REQUEST_MAX) {
    throw new ForgeError(`the request is longer than ${REQUEST_MAX} bytes: ${PUT_IN_A_FILE}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new ForgeError("the request is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new ForgeError("the request must be a JSON object");
  const o = json as Record<string, unknown>;
  const op = o.op;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    throw new ForgeError(`op must be one of ${OPS.join(", ")}`);
  }
  const fields = FIELDS[op as Op];
  const extra = Object.keys(o).filter((k) => k !== "op" && !Object.hasOwn(fields, k));
  if (extra.length > 0) {
    throw new ForgeError(`${op}: unknown field${extra.length > 1 ? "s" : ""}: ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}`);
  }
  const str = (name: string): string => {
    const v = o[name];
    if (typeof v !== "string") throw new ForgeError(`${op}: ${name} must be a string`);
    return v;
  };
  // Un champ facultatif est absent, jamais vide : `null` pour l'absent.
  const optional = (name: string): string | null => {
    if (!Object.hasOwn(o, name)) return null;
    const v = str(name);
    if (v === "") throw new ForgeError(`${op}: ${name} is empty: leave it out`);
    return v;
  };
  const container = (name: string): string => {
    const v = str(name);
    validateContainerName(v);
    return v;
  };
  const body = (): string | null => {
    const b = optional("body");
    if (b !== null) checkText(b, BODY_MAX, "body", secrets);
    return b;
  };

  switch (op as Op) {
    case "message": {
      const to = container("to");
      const summary = str("summary");
      checkSummary(summary, secrets);
      return { op: "message", to, summary, body: body() };
    }
    case "assign": {
      const to = container("to");
      const task = optional("task");
      if (task !== null) validateTaskName(task);
      const text = str("text");
      checkText(text, INSTRUCTION_MAX, "instruction", secrets);
      return { op: "assign", to, task, text };
    }
    case "release":
      return { op: "release", to: container("to") };
    case "ask-human": {
      const summary = str("summary");
      checkSummary(summary, secrets);
      return { op: "ask-human", summary, body: body() };
    }
    default:
      return { op: "status" };
  }
}
