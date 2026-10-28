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
function cells(XLSX, ws, limit) {
  if (!ws?.['!ref']) return { rows: [], total: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  let total = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const text = String(cell?.w ?? cell?.v ?? '').replace(/\s+/g, ' ').trim();
      row.push(cell?.f ? `${text} (=${cell.f})`.trim() : text);
    }
    if (row.some(Boolean) && ++total <= limit) rows.push(row);
  }
  const width = rows.reduce((w, row) => Math.max(w, row.findLastIndex(Boolean) + 1), 0);
  return { rows: rows.map((row) => row.slice(0, width)), total };
}
