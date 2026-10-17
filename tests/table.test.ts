import { test } from "node:test";
import assert from "node:assert/strict";
import { columnWidths, formatRow } from "../cli/lib/table.ts";

test("columnWidths takes the longest cell of each column", () => {
  assert.deepEqual(columnWidths([["a", "bbb"], ["cccc", "d"]]), [4, 3]);
});

test("formatRow pads every column but the last", () => {
  assert.equal(formatRow(["REPO", "MODE"], [8, 4]), "REPO      MODE");
});

test("formatRow leaves no trailing whitespace", () => {
  const line = formatRow(["a", "b"], [10, 8]);
  assert.equal(line, "a           b");
  assert.ok(!line.endsWith(" "));
});

test("formatRow applies an indent for nested rows", () => {
  assert.equal(formatRow(["cli", "attached"], [5, 8], "  "), "  cli    attached");
});

test("a long value widens its own column instead of shifting the others", () => {
  const rows = [
    ["REPO", "MODE", "STATE", "BUILD"],
    ["moroine/agent-forge", "autonomous", "Running", "behind"],
    ["acme/super-long-repository-name", "supervised", "Stopped", "ok"],
  ];
  const w = columnWidths(rows);
  const lines = rows.map((r) => formatRow(r, w));
  // Vérifier l'alignement direct : le contenu de chaque colonne doit correspondre
  // à la cellule source quand on extrait la tranche de la ligne au offset calculé.
  for (let col = 0; col < w.length; col++) {
    const offset = w.slice(0, col).reduce((a, b) => a + b + 2, 0);
    for (let rowIdx = 0; rowIdx < lines.length; rowIdx++) {
      const line = lines[rowIdx];
      const cell = rows[rowIdx][col];
      const sliced = line.slice(offset, offset + w[col]).trim();
      assert.equal(sliced, cell, `column ${col} misaligned at row ${rowIdx}: expected "${cell}", got "${sliced}"`);
    }
  }
});

test("columnWidths handles rows of differing lengths", () => {
  assert.deepEqual(columnWidths([["a", "b"], ["ccc", "dddd", "eeeee", "f"]]), [3, 4, 5, 1]);
});

test("the widest realistic row stays within 80 columns", () => {
  const rows = [
    ["REPO", "MODE", "STATE", "BUILD"],
    ["acme/super-long-repository-name", "supervised", "Stopped", "behind"],
  ];
  const w = columnWidths(rows);
  for (const r of rows) assert.ok(formatRow(r, w).length <= 80);
});
