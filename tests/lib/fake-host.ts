// /proc files for the host contract checks, in a throwaway directory. A value
// of null leaves the file out, as on a kernel without that knob. The
// directories are removed when the test process exits.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcPaths } from "../../cli/lib/host.ts";

export type ProcValues = { restrictUserns?: string | null; usernsClone?: string | null; ipForward?: string | null };

const dirs: string[] = [];
process.once("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function fakeProc(values: ProcValues = {}): ProcPaths {
  const dir = mkdtempSync(join(tmpdir(), "forge-proc-"));
  dirs.push(dir);
  const all: ProcValues = { restrictUserns: "0\n", usernsClone: "1\n", ipForward: "1\n", ...values };
  const paths: ProcPaths = {
    restrictUserns: join(dir, "apparmor_restrict_unprivileged_userns"),
    usernsClone: join(dir, "unprivileged_userns_clone"),
    ipForward: join(dir, "ip_forward"),
  };
  for (const key of Object.keys(paths) as (keyof ProcPaths)[]) {
    const value = all[key];
    if (value !== null && value !== undefined) writeFileSync(paths[key], value);
  }
  return paths;
}
