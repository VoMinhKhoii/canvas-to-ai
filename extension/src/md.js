// Markdown building blocks shared by the converters (pure, no DOM).

// Each converted file sits under a "### <file name>" heading, so headings from
// inside a file start one level below it: level 1 → "####", capped at "######".
export const contentHeading = (level, text) => `${'#'.repeat(Math.min(6, level + 3))} ${text}`;

// rows: arrays of cell strings; the first row is the header. Rows are padded
// to the widest row and pipes inside cells escaped, so every row (header
// included) has the separator's column count.
export function mdTable(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const row = (cells) => `| ${[...cells, ...Array(width - cells.length).fill('')].map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [rows[0], Array(width).fill('---'), ...rows.slice(1)].map(row).join('\n');
}
