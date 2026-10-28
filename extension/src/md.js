// Markdown building blocks shared by the converters (pure, no DOM).

// Each converted file sits under a "### <file name>" heading, so headings from
// inside a file start one level below it: level 1 → "####", capped at "######".
export const contentHeading = (level, text) => `${'#'.repeat(Math.min(6, level + 3))} ${text}`;

// rows: arrays of cell strings; the first row is the header.
export function mdTable(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  return [rows[0], Array(width).fill('---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}
