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
// them out. The tests point each one at a temporary directory, and githubBase
// at local bare repositories laid out as <owner>/<repo>.git.
export type RelayPaths = {
  config: string;
  token: string;
  signingKey: string;
  mirror: string;
  stateDir: string;
  audit: string;
  githubBase: string;
};

export const RELAY_PATHS: RelayPaths = {
  config: "/etc/forge-relay/config.json",
  token: "/etc/forge-relay/github-token",
  signingKey: "/var/lib/forge-relay/signing-key",
  mirror: "/var/lib/forge-relay/mirror.git",
  stateDir: "/var/lib/forge-relay",
  audit: "/var/log/forge-relay/audit.log",
  githubBase: "https://github.com",
};
