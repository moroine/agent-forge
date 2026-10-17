// Largeurs calculées sur les données, jamais figées : un nom long élargit sa
// propre colonne au lieu de décaler toutes les suivantes.
const GAP = "  ";

export function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return widths;
}

// La dernière colonne n'est pas complétée : cela laisserait des espaces en fin
// de ligne, invisibles et pénibles à comparer dans les tests.
export function formatRow(cells: string[], widths: number[], indent = ""): string {
  const padded = cells.map((cell, i) =>
    i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? cell.length),
  );
  return indent + padded.join(GAP);
}
