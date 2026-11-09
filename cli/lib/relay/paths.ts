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
