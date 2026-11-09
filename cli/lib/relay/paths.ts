import { readFileSync } from "node:fs";
import { RelayError } from "./config.ts";

// The bot's token, read from its file. Whitespace or a control character
// inside it (a second line, a note) would end up in an HTTP header or an error
// that quotes it, so such a file is refused, and no message quotes the token
// or the file's content.
export function readToken(file: string): string {
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    throw new RelayError("the relay cannot read the bot's token file");
  }
  if (token === "" || /[\s\p{Cc}]/u.test(token)) throw new RelayError("the bot's token file is empty or malformed: it must hold the token alone, on one line");
  return token;
}

// Where the relay keeps its files on the relay VM, as the role forge_relay lays
// them out. Fetches are anonymous, over HTTPS (githubBase); pushes go over
// SSH with the push key (pushBase). The tests point each file at a temporary
// directory, githubBase at local bare repositories laid out as
// <owner>/<repo>.git, and pushBase at the same directory: a push URL is
// `${pushBase}${fork}.git` either way.
export type RelayPaths = {
  config: string;
  token: string;
  signingKey: string;
  pushKey: string;
  githubKnownHosts: string;
  mirror: string;
  stateDir: string;
  audit: string;
  githubBase: string;
  pushBase: string;
};

export const RELAY_PATHS: RelayPaths = {
  config: "/etc/forge-relay/config.json",
  token: "/etc/forge-relay/github-token",
  signingKey: "/var/lib/forge-relay/signing-key",
  pushKey: "/var/lib/forge-relay/push-key",
  githubKnownHosts: "/var/lib/forge-relay/github-known-hosts",
  mirror: "/var/lib/forge-relay/mirror.git",
  stateDir: "/var/lib/forge-relay",
  audit: "/var/log/forge-relay/audit.log",
  githubBase: "https://github.com",
  pushBase: "git@github.com:",
};

// How the relay reaches github.com over SSH as the bot, for its pushes and its
// setup check: with the push key alone (no agent, no other identity), no user
// or system configuration, never a prompt, and only the GitHub host keys the
// role pinned (no system-wide known_hosts either): a key not in that file is
// refused, never learned. A connection that does not open within 30 s, or
// that stops answering for a minute (4 keepalives 15 s apart), is dropped:
// the mirror's HTTP stall limits do not apply to SSH.
export function githubSsh(paths: Pick<RelayPaths, "pushKey" | "githubKnownHosts">): string[] {
  return [
    "ssh", "-F", "/dev/null", "-i", paths.pushKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", `UserKnownHostsFile=${paths.githubKnownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
  ];
}
