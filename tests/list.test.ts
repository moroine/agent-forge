import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { cmdList } from "../cli/lib/commands/list.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-super-long-repository-name", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "image get-property", stdout: "bbbb2222" },
      { match: "agent-moroine-agent-forge user.forge.image_commit", stdout: "aaaa1111" },
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "agent-moroine-agent-forge user.forge.mode", stdout: "autonomous" },
      { match: "agent-acme-super-long-repository-name user.forge.image_commit", stdout: "bbbb2222" },
      { match: "agent-acme-super-long-repository-name user.forge.repo", stdout: "acme/super-long-repository-name" },
      { match: "agent-acme-super-long-repository-name user.forge.mode", stdout: "supervised" },
      { match: "incus --project agent-forge list", stdout: LIST },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\nworktree /workspace/.trees/api\n" },
      { match: "ps -u 1001 -o args=", stdout: "claude --permission-mode auto --remote-control agent-moroine-agent-forge-cli\n" },
    ],
  });
}

test("the header names the four columns, repo first", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[0], /^REPO\s+MODE\s+STATE\s+BUILD$/);
});

test("a behind container is reported without the two sha", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[1], /^moroine\/agent-forge\s+autonomous\s+Running\s+behind$/);
});

test("the two task states are distinguished", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[2], /^ {2}cli\s+running$/);
  assert.match(c.out_lines[3], /^ {2}docs\s+stopped$/);
  assert.match(c.out_lines[4], /^ {2}api\s+stopped$/);
});

test("a stopped container yields no task rows and is not inspected", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[5], /^acme\/super-long-repository-name\s+supervised\s+Stopped\s+ok$/);
  assert.equal(c.out_lines.length, 6);
});

test("a long repo name widens its column instead of shifting the others", async () => {
  const c = ctx();
  await cmdList(c);
  // Les cellules attendues, et les largeurs recalculées à la main : le test ne
  // doit rien emprunter à table.ts, sinon il valide l'implémentation par
  // elle-même. `assert.notEqual(line[modeAt], " ")` — ce qu'il y avait ici —
  // ne prouvait rien : un formatRow complétant un caractère de trop court le
  // passe (démontré sur table.test.ts, d'où la même approche par tranches).
  const rows = [
    ["REPO", "MODE", "STATE", "BUILD"],
    ["moroine/agent-forge", "autonomous", "Running", "behind"],
    ["acme/super-long-repository-name", "supervised", "Stopped", "ok"],
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  const lines = c.out_lines.filter((l) => !l.startsWith(" "));
  assert.equal(lines.length, rows.length);

  for (let col = 0; col < widths.length; col++) {
    const offset = widths.slice(0, col).reduce((a, b) => a + b + 2, 0);
    for (let i = 0; i < lines.length; i++) {
      const sliced = lines[i].slice(offset, offset + widths[col]).trim();
      assert.equal(sliced, rows[i][col],
        `column ${col} misaligned on row ${i}: expected "${rows[i][col]}", got "${sliced}" in "${lines[i]}"`);
    }
  }
});

test("forge list runs a single incus list for the whole command", async () => {
  const c = ctx();
  await cmdList(c);
  const listings = c.calls.filter((call) => call.join(" ") === "incus --project agent-forge list -f json");
  assert.equal(listings.length, 1, `${listings.length} full listings instead of 1`);
});

test("no line wraps an 80-column terminal", async () => {
  const c = ctx();
  await cmdList(c);
  for (const line of c.out_lines) assert.ok(line.length <= 80, `too long: ${line}`);
});

test("a container with no repo metadata falls back to its name", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-orphan", status: "Stopped" }]) },
      { match: "image get-property", stdout: "" },
    ],
  });
  await cmdList(c);
  assert.match(c.out_lines[1], /^agent-orphan\s+-\s+Stopped\s+unknown$/);
});

test("every container is compared against agent-base, read once", async () => {
  const c = ctx();
  await cmdList(c);
  const reads = c.calls.filter((call) => call.join(" ").includes("image get-property"));
  assert.deepEqual(reads.map((call) => call.slice(-2)), [["agent-base", "user.forge.commit"]]);
});

test("forge list runs no host git", async () => {
  const c = ctx();
  await cmdList(c);
  assertNoHostGitIn(c.calls, "/workspace");
  assert.ok(!c.calls.some((call) => call[0] === "git"));
});
