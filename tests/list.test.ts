import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
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
      { match: "lxc list", stdout: LIST },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\nworktree /workspace/.trees/api\n" },
      { match: "list-sessions", stdout: "cli 1\ndocs 0\n" },
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

test("the three session states are distinguished", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[2], /^ {2}cli\s+attached$/);
  assert.match(c.out_lines[3], /^ {2}docs\s+detached$/);
  assert.match(c.out_lines[4], /^ {2}api\s+no session$/);
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

test("forge list runs a single lxc list for the whole command", async () => {
  const c = ctx();
  await cmdList(c);
  const listings = c.calls.filter((call) => call.join(" ") === "lxc list -f json");
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
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-orphan", status: "Stopped" }]) },
      { match: "image get-property", stdout: "" },
    ],
  });
  await cmdList(c);
  assert.match(c.out_lines[1], /^agent-orphan\s+-\s+Stopped\s+unknown$/);
});

test("forge list compares a super container against agent-base-super", async () => {
  const LIST_SUPER = JSON.stringify([{ name: "agent-o-r", status: "Running" }]);
  const c = fakeContext({
    rules: [
      { match: "lxc list", stdout: LIST_SUPER },
      // agent-base-super avant agent-base : "agent-base" est sous-chaîne de
      // "agent-base-super", donc la règle la plus spécifique doit gagner.
      { match: "image get-property agent-base-super", stdout: "SUPERSHA" },
      { match: "image get-property agent-base", stdout: "BASESHA" },
      { match: "agent-o-r user.forge.repo", stdout: "o/r" },
      { match: "agent-o-r user.forge.mode", stdout: "super" },
      { match: "agent-o-r user.forge.image_commit", stdout: "SUPERSHA" },
      { match: "sessions", stdout: "" },
    ],
  });
  await cmdList(c);
  const row = c.out_lines.find((l) => l.includes("o/r"));
  assert.ok(row, "super container row present");
  assert.ok(row.includes("super"), "MODE column shows super");
  assert.ok(row.includes("ok"), "BUILD is ok when stamp matches agent-base-super");
});
