// Markdown building blocks shared by the converters (pure, no DOM).

// Each converted file sits under a "### <file name>" heading, so headings from
// inside a file start one level below it: level 1 → "####", capped at "######".
export const contentHeading = (level, text) => `${'#'.repeat(Math.min(6, level + 3))} ${text}`;

// rows: arrays of cell strings; the first row is the header. Rows are padded
// to the widest row and pipes inside cells escaped, so every row (header
// included) has the separator's column count. A ragged table (one 4000-cell
// row over 4000 one-cell rows) would pad to millions of empty cells: past
// MAX_PADDING its body rows stay short, which Markdown fills in as empty cells.
const MAX_PADDING = 20_000;
export function mdTable(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0); // no spread: a table can have 100k+ rows
  const given = rows.reduce((n, r) => n + r.length, 0);
  const padBody = width * rows.length - given <= Math.max(MAX_PADDING, given);
  const row = (cells, pad) => `| ${[...cells, ...Array(pad ? width - cells.length : 0).fill('')].map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [row(rows[0], true), row(Array(width).fill('---'), true), ...rows.slice(1).map((r) => row(r, padBody))].join('\n');
}

// s.replace(re, '') for a pattern whose matches all end with `closer` (such
// as /<[^>]+>/): no match can start after the last closer, so the rest is not
// searched. Without the cut, a long run of openers with no closer after them
// ("<<<<…") is rescanned to the end from every opener: quadratic.
export function removeBefore(s, re, closer) {
  const end = s.lastIndexOf(closer) + 1;
  return s.slice(0, end).replace(re, '') + s.slice(end);
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
