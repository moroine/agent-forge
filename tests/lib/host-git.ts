// Helper for the host-side git rule: the agent writes the workspace, so no host
// git command may ever mention a path under it.
import assert from "node:assert/strict";

// Fails when any recorded call that runs git has an argv element containing dir.
export function assertNoHostGitIn(calls: string[][], dir: string): void {
  const offenders = calls.filter((argv) => argv[0] === "git" && argv.some((a) => a.includes(dir)));
  assert.deepEqual(offenders, [], `host git touched ${dir}`);
}
