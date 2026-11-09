// La configuration du relais, lue de /etc/forge-relay/config.json sur la VM
// relais. Elle porte tout ce qui est personnel (comptes, adresses) : rien de
// cela n'est dans le dépôt.
import { readFileSync } from "node:fs";

// Un refus dont le message revient à l'agent de la VM de dev.
export class RelayError extends Error {}

export type RelayConfig = {
  upstream: string; // owner/repo du dépôt de référence
  fork: string; // owner/repo du fork du bot
  botLogin: string;
  botName: string;
  botEmail: string;
  trustedLogins: string[]; // le mainteneur ; le bot est ajouté par checkPublicText
  coAuthorEmails: string[];
  writesPerHour: number;
};

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/;

function str(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || v.trim() === "") throw new RelayError(`relay config: ${field} must be a non-empty string`);
  return v;
}

function repo(o: Record<string, unknown>, field: string): string {
  const v = str(o, field);
  if (!REPO.test(v)) throw new RelayError(`relay config: ${field} must look like owner/repo`);
  return v;
}

function githubLogin(v: string, field: string): string {
  if (!LOGIN.test(v)) throw new RelayError(`relay config: ${field} is not a GitHub login`);
  return v;
}

function list(o: Record<string, unknown>, field: string): string[] {
  const v = o[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new RelayError(`relay config: ${field} must be a list of strings`);
  return v as string[];
}

export function parseRelayConfig(json: unknown): RelayConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new RelayError("relay config: expected an object");
  const o = json as Record<string, unknown>;
  const upstream = repo(o, "upstream");
  const fork = repo(o, "fork");
  const botLogin = githubLogin(str(o, "botLogin"), "botLogin");
  // Le bot ne travaille que sur son propre fork, jamais comme collaborateur.
  if (fork.split("/")[0].toLowerCase() !== botLogin.toLowerCase()) throw new RelayError("relay config: fork must belong to botLogin");
  const trusted = list(o, "trustedLogins");
  for (const t of trusted) githubLogin(t, "trustedLogins");
  if (trusted.length === 0) throw new RelayError("relay config: trustedLogins must not be empty");
  const emails = (field: string, v: string[]) => {
    for (const e of v) if (!e.includes("@")) throw new RelayError(`relay config: ${field} must hold email addresses`);
    return v;
  };
  const botEmail = str(o, "botEmail");
  emails("botEmail", [botEmail]);
  const coAuthorEmails = emails("coAuthorEmails", list(o, "coAuthorEmails"));
  const writesPerHour = o.writesPerHour;
  if (typeof writesPerHour !== "number" || !Number.isInteger(writesPerHour) || writesPerHour < 1) {
    throw new RelayError("relay config: writesPerHour must be an integer of at least 1");
  }
  return { upstream, fork, botLogin, botName: str(o, "botName"), botEmail, trustedLogins: trusted, coAuthorEmails, writesPerHour };
}

export function loadRelayConfig(path: string): RelayConfig {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RelayError(`relay config: cannot read ${path} as JSON`);
  }
  return parseRelayConfig(json);
}
