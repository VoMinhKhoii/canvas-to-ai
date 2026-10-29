// Spreadsheets (.xlsx, .xlsm, .xls, .ods, .csv, .tsv) → one Markdown table per
// sheet, through SheetJS (loaded only when a spreadsheet is converted).
// Cells show their value as formatted in the sheet; a formula is kept beside
// its value ("42 (=SUM(B2:B5))"), since how a sheet computes is often the
// lesson. Very long sheets are cut with a note saying how much was left out.
import { contentHeading, mdTable } from '../md.js';

const MAX_ROWS = 500;

// input: ArrayBuffer (or a string for .csv/.tsv).
export async function sheet(input) {
  const XLSX = await import('xlsx');
  const wb = typeof input === 'string' ? XLSX.read(input, { type: 'string', cellFormula: true }) : XLSX.read(new Uint8Array(input), { type: 'array', cellFormula: true });
  const parts = [];
  for (const [i, name] of wb.SheetNames.entries()) {
    const { rows, total } = cells(XLSX, wb.Sheets[name], MAX_ROWS);
    const hidden = wb.Workbook?.Sheets?.[i]?.Hidden ? ' (hidden)' : '';
    const heading = wb.SheetNames.length > 1 || hidden ? contentHeading(1, `Sheet: ${name}${hidden}`) : '';
    if (!rows.length) {
      if (heading) parts.push(`${heading}\n_(empty)_`);
      continue;
    }
    const more = total - rows.length;
    const body = rows[0].length === 1 ? rows.map((r) => r[0]).join('\n') : mdTable(rows);
    parts.push([heading, body, more > 0 && `_(${more.toLocaleString('en')} more rows not shown; open the file for all of them)_`].filter(Boolean).join('\n\n'));
  }
  return { md: parts.join('\n\n'), assets: new Map() };
}

// The first `limit` non-empty rows of the sheet's used range as strings, the
// empty columns at the right edge trimmed, and how many non-empty rows it has.
// Only the cells the file holds are visited: the declared range can be far
// larger than its content (a 16 KB file can claim A1:XFD1048576).
function cells(XLSX, ws, limit) {
  if (!ws?.['!ref']) return { rows: [], total: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const byRow = new Map(); // row → [[column, text]]
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const cell = ws[key];
    const value = String(cell?.w ?? cell?.v ?? '').replace(/\s+/g, ' ').trim();
    const text = cell?.f ? `${value} (=${cell.f})`.trim() : value;
    if (!text) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) continue;
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push([c - range.s.c, text]);
  }
  const order = [...byRow.keys()].sort((a, b) => a - b);
  const rows = order.slice(0, limit).map((r) => {
    const row = [];
    for (const [c, text] of byRow.get(r)) row[c] = text;
    return row;
  });
  const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
  return { rows: rows.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? '')), total: order.length };
}
