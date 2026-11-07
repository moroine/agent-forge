// Bout-en-bout : le VRAI binaire, avec un faux incus sur le PATH. Prouve le
// câblage que les tests unitaires ne voient pas — parsing d'argv, dispatch,
// codes de sortie, et la séparation stdout/stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let bin: string;
let herdr: string;
let herdrNoteOnly: string;
let herdrToastsOff: string;
let noteFile: string;
// Same fake incus, except that the agent itself (the attach argv) exits 3.
let failingAgentBin: string;
const ENTRY = resolve("cli/forge.ts");

// Canned herdr 0.9.5 answers: workspace alice/project holds a tab cli
// whose pane runs the task's attach. Not named `herdr`, so it is never on PATH.
const FAKE_HERDR = `#!/bin/sh
case "$1 $2" in
  "workspace list") echo '{"id":"1","result":{"workspaces":[{"workspace_id":"w1","label":"alice/project"}]}}' ;;
  "tab list") echo '{"id":"1","result":{"tabs":[{"tab_id":"w1:t1","label":"cli","workspace_id":"w1"}]}}' ;;
  "pane list") echo '{"id":"1","result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}' ;;
  "pane process-info") echo '{"id":"1","result":{"process_info":{"foreground_processes":[{"argv":["forge","attach","agent-alice-project","cli"]}]}}}' ;;
  "tab focus") ;;
  "notification show") printf '%s\n' "$@" > "$FAKE_HERDR_NOTE"; echo '{"id":"1","result":{"shown":true}}' ;;
  *) echo "fake herdr: unexpected $*" >&2; exit 1 ;;
esac
`;

// Shows notifications and refuses every other command.
const FAKE_HERDR_NOTE_ONLY = `#!/bin/sh
case "$1 $2" in
  "notification show") printf '%s\n' "$@" > "$FAKE_HERDR_NOTE"; echo '{"id":"1","result":{"shown":true}}' ;;
  *) exit 1 ;;
esac
`;

// Answers like herdr 0.9.5 with no client attached: shown:false.
const FAKE_HERDR_TOASTS_OFF = `#!/bin/sh
case "$1 $2" in
  "notification show") echo '{"id":"1","result":{"shown":false,"reason":"disabled"}}' ;;
  *) exit 1 ;;
esac
`;

before(() => {
  bin = mkdtempSync(join(tmpdir(), "forge-e2e-bin-"));
  const stub = resolve("tests/lib/fake-incus-bin.ts");
  writeFileSync(join(bin, "incus"), `#!/bin/sh\nexec node ${stub} "$@"\n`);
  chmodSync(join(bin, "incus"), 0o755);
  herdr = join(bin, "fake-herdr");
  writeFileSync(herdr, FAKE_HERDR);
  chmodSync(herdr, 0o755);
  herdrNoteOnly = join(bin, "fake-herdr-note-only");
  writeFileSync(herdrNoteOnly, FAKE_HERDR_NOTE_ONLY);
  chmodSync(herdrNoteOnly, 0o755);
  herdrToastsOff = join(bin, "fake-herdr-toasts-off");
  writeFileSync(herdrToastsOff, FAKE_HERDR_TOASTS_OFF);
  chmodSync(herdrToastsOff, 0o755);
  noteFile = join(bin, "note");
  failingAgentBin = mkdtempSync(join(tmpdir(), "forge-e2e-failbin-"));
  writeFileSync(join(failingAgentBin, "incus"),
    `#!/bin/sh\ncase " $* " in *" --cwd /workspace/.trees/"*) exit 3 ;; esac\nexec node ${stub} "$@"\n`);
  chmodSync(join(failingAgentBin, "incus"), 0o755);
});

after(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(failingAgentBin, { recursive: true, force: true });
});

function forge(args: string[], input = "", extraEnv: Record<string, string> = {}) {
  // Never inherit the herdr session of the shell running the tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_")));
  return spawnSync("node", [ENTRY, ...args], {
    encoding: "utf8",
    input,
    env: { ...env, FORGE_SIDE: "host", PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
}

test("no argument prints the usage and exits 0", () => {
  const r = forge([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: forge <command>/);
  // setup also creates the egress proxy and the allowlist (its entry, up to the next command).
  const setup = r.stdout.match(/^ {2}setup [\s\S]*?(?=^ {2}\S)/m)?.[0] ?? "";
  assert.match(setup, /proxy[\s\S]*allowlist/, r.stdout);
});

test("an unknown command exits 1 with Error: on stderr", () => {
  const r = forge(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: unknown command 'frobnicate'/m);
  assert.equal(r.stdout, "");
});

test("a failure in the herdr popup waits for Enter", () => {
  const r = forge(["frobnicate"], "\n", { HERDR_ENV: "1", HERDR_BIN_PATH: "/bin/false" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: unknown command[\s\S]*Press Enter to close/);
});

test("outside the popup there is no wait", () => {
  const r = forge(["frobnicate"], "\n", { HERDR_ENV: "1", HERDR_BIN_PATH: "/bin/false", HERDR_PANE_ID: "w1:p1" });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Press Enter/);
});

// The popup's acknowledgement policy: a success closes it at once; what the
// user must read goes to a herdr notification, and only if that fails does
// the popup wait.
const popup = (bin: string) => ({ HERDR_ENV: "1", HERDR_BIN_PATH: bin, FAKE_HERDR_NOTE: noteFile });
const pane = (bin: string) => ({ ...popup(bin), HERDR_PANE_ID: "w1:p1" });

test("resume --all in the popup sends its summary as a notification and closes", () => {
  rmSync(noteFile, { force: true });
  const r = forge(["resume", "--all"], "\n", popup(herdr));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Press Enter/);
  const note = readFileSync(noteFile, "utf8");
  assert.match(note, /forge resume/);
  assert.match(note, /no forge tab to resume\./);
});

test("a WARNING in the popup becomes a notification, and the popup closes", () => {
  rmSync(noteFile, { force: true });
  const r = forge(["finish", "alice/project", "cli"], "\n", popup(herdrNoteOnly));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: closing the herdr tab of cli failed/);
  assert.doesNotMatch(r.stderr, /Press Enter/);
  const note = readFileSync(noteFile, "utf8");
  assert.match(note, /forge finish/);
  assert.match(note, /WARNING: closing the herdr tab of cli failed/);
});

test("when the notification fails, the popup falls back to waiting for Enter", () => {
  // /bin/false as herdr: finish's tab cleanup fails, which only warns.
  const r = forge(["finish", "alice/project", "cli"], "\n", popup("/bin/false"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: closing the herdr tab of cli failed[\s\S]*Press Enter to close/);
  assert.match(r.stderr, /herdr notification failed: /);
});

test("when herdr does not show the notification, the popup waits for Enter", () => {
  const r = forge(["finish", "alice/project", "cli"], "\n", popup(herdrToastsOff));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: closing the herdr tab of cli failed[\s\S]*Press Enter to close/);
  assert.doesNotMatch(r.stderr, /herdr notification failed/);
});

test("a non-zero exit in the popup waits for Enter", () => {
  const r = forge(["attach", "agent-alice-project", "cli"], "\n",
    { ...popup(herdr), PATH: `${failingAgentBin}:${process.env.PATH}` });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /Press Enter to close\n?$/);
});

test("focusing a live tab from the popup closes it at once", () => {
  const r = forge(["resume", "alice/project", "cli"], "\n", popup(herdr));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Focused alice\/project cli in herdr\./);
  assert.doesNotMatch(r.stderr, /Press Enter/);
});

test("outside the popup a success never waits", () => {
  const all = forge(["resume", "--all"], "\n", pane(herdr));
  assert.equal(all.status, 0, all.stderr);
  assert.doesNotMatch(all.stderr, /Press Enter/);
  const warned = forge(["finish", "alice/project", "cli"], "\n", pane("/bin/false"));
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /WARNING/);
  assert.doesNotMatch(warned.stderr, /Press Enter/);
});

// A herdr tab runs `exec forge attach …`: the pane closes with forge.
test("an agent exiting non-zero in a herdr pane leaves its exit code to read", () => {
  const r = forge(["attach", "agent-alice-project", "cli"], "\n",
    { ...pane(herdr), PATH: `${failingAgentBin}:${process.env.PATH}` });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /the agent exited with code 3\nPress Enter to close/);
});

test("a failing attach in a herdr pane leaves its error to read", () => {
  const r = forge(["attach", "agent-nope", "cli"], "\n", pane(herdr));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: agent-nope is not a forge container\nPress Enter to close/);
});

test("an agent exiting 0 in a herdr pane closes it at once", () => {
  const r = forge(["attach", "agent-alice-project", "cli"], "\n", pane(herdr));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Press Enter|exited with code/);
});

test("outside herdr a failing agent does not wait", () => {
  const r = forge(["attach", "agent-alice-project", "cli"], "\n", { PATH: `${failingAgentBin}:${process.env.PATH}` });
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stderr, /Press Enter/);
});

test("attach with no arguments exits 1 with its usage", () => {
  const r = forge(["attach"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge attach/);
  assert.equal(r.stdout, "");
});

test("list renders the table on stdout", () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^REPO\s+MODE\s+EGRESS\s+STATE\s+BUILD$/m);
  assert.match(r.stdout, /alice\/project/);
});

test("completion repos is machine-readable, one per line", () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n"), ["alice/project", "acme/widgets"]);
});

test("--force is accepted in any position", () => {
  const first = forge(["stop", "--force", "alice/project"]);
  const last = forge(["stop", "alice/project", "--force"]);
  assert.equal(first.status, 0);
  assert.equal(last.status, 0);
});

test("a missing argument with no TTY prints the usage instead of hanging", () => {
  const r = forge(["resume"], "1\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge resume/);
});

// --all n'a de sens que pour resume : ailleurs, il était ignoré en silence.
test("--all with another command than resume is refused", () => {
  for (const cmd of ["start", "finish", "list"]) {
    const r = forge([cmd, "--all"]);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /^Error: --all only goes with resume: forge resume --all$/m, cmd);
  }
});

// --remote ne vaut que pour install, --host pour install, open, fetch et ship.
test("--remote and --host are refused outside the laptop commands that take them", () => {
  for (const cmd of ["list", "start"]) {
    const remote = forge([cmd, "--remote", "203.0.113.10"]);
    assert.equal(remote.status, 1, `${cmd}: ${remote.stderr}`);
    assert.match(remote.stderr, /^Error: --remote only goes with install/m, cmd);
    const host = forge([cmd, "--host", "forge-acme"]);
    assert.equal(host.status, 1, `${cmd}: ${host.stderr}`);
    assert.match(host.stderr, /^Error: --host only goes with install, open, fetch, ship and cloud: .*forge ship <task> --host <name>, forge cloud start --host <name>$/m, cmd);
  }
  const open = forge(["open", "--remote", "203.0.113.10"], "", { FORGE_SIDE: "laptop" });
  assert.equal(open.status, 1);
  assert.match(open.stderr, /^Error: --remote only goes with install/m);
});

test("an unknown option fails cleanly rather than crashing", () => {
  const r = forge(["list", "--nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /m);
});

test("image without a subcommand fails with its usage", () => {
  const r = forge(["image"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge image build \| commit$/m);
});

test("the bash shim runs the TypeScript entry", () => {
  const r = spawnSync(resolve("cli/forge"), ["list"], {
    encoding: "utf8",
    env: { ...process.env, FORGE_SIDE: "host", PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REPO\s+MODE\s+EGRESS\s+STATE\s+BUILD$/m);
});

test("a host command on the laptop says where it runs", () => {
  const r = forge(["list"], "", { FORGE_SIDE: "laptop" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs on the forge host/);
});

test("setup appears in the usage", () => {
  assert.match(forge([]).stdout, /^\s+setup\s/m);
});

test("--strict is refused outside forge start", () => {
  const r = forge(["stop", "--strict", "o/r"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--strict only applies to 'forge start'/);
  assert.match(r.stderr, /Usage: forge/);
});

test("upload-pack refuses a hostile container name and keeps stdout empty", () => {
  const r = forge(["upload-pack", "agent-x;id"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^Error: container must be/m);
});
