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
    const rows = cells(XLSX, wb.Sheets[name]);
    const hidden = wb.Workbook?.Sheets?.[i]?.Hidden ? ' (hidden)' : '';
    const heading = wb.SheetNames.length > 1 || hidden ? contentHeading(1, `Sheet: ${name}${hidden}`) : '';
    if (!rows.length) {
      if (heading) parts.push(`${heading}\n_(empty)_`);
      continue;
    }
    const shown = rows.slice(0, MAX_ROWS);
    const more = rows.length - shown.length;
    const body = shown[0].length === 1 ? shown.map((r) => r[0]).join('\n') : mdTable(shown);
    parts.push([heading, body, more > 0 && `_(${more.toLocaleString('en')} more rows not shown; open the file for all of them)_`].filter(Boolean).join('\n\n'));
  }
  return { md: parts.join('\n\n'), assets: new Map() };
}

// The sheet's used range as rows of strings, with empty rows and the empty
// columns at the right edge trimmed.
function cells(XLSX, ws) {
  if (!ws?.['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const text = String(cell?.w ?? cell?.v ?? '').replace(/\s+/g, ' ').trim();
      row.push(cell?.f ? `${text} (=${cell.f})`.trim() : text);
    }
    if (row.some(Boolean)) rows.push(row);
  }
  const width = Math.max(0, ...rows.map((row) => row.findLastIndex(Boolean) + 1));
  return rows.map((row) => row.slice(0, width));
}
