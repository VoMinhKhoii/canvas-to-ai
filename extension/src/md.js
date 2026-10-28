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

// Outside code, text such as "<header>" or "List<Employee>" is read as an HTML
// tag by Markdown viewers and vanishes ("New elements like , , and ."). Wrap
// it in backticks; fenced blocks and inline code are left alone.
const TAG = /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g;
export function codeTags(md) {
  let fenced = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(TAG, (tag) => `\`${tag}\``)))
        .join('');
    })
    .join('\n');
}
