// OpenDocument text (.odt) and presentations (.odp), from LibreOffice and
// Google Docs exports: the body is content.xml in the zip. (OpenDocument
// spreadsheets go through sheet.js.)
import JSZip from 'jszip';
import { contentHeading, mdTable } from '../md.js';
import { xml } from './zip.js';

// Text of a text:p / text:h, with text:s (spaces), text:tab and text:line-break.
const inline = (el) => rawText(el).replace(/\s+/g, ' ').trim();
function rawText(el) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.textContent;
    else if (n.tagName === 'text:s') out += ' '.repeat(Math.min(1, Number(n.getAttribute('text:c') || 1))); // inline() collapses runs: one space reads the same as text:c of them
    else if (n.tagName === 'text:tab' || n.tagName === 'text:line-break') out += ' ';
    else if (n.nodeType === 1 && n.tagName !== 'text:note') out += rawText(n); // spaces at span edges are kept
  }
  return out;
}

// A table's own rows, also inside header-rows/rows/row-group wrappers, but not
// those of tables nested in its cells: each cell renders its own tables, so
// taking theirs too would render nested tables again at every level.
const ROW_GROUPS = new Set(['table:table-header-rows', 'table:table-rows', 'table:table-row-group']);
function ownRows(parent) {
  const rows = [];
  for (const el of parent.children) {
    if (el.tagName === 'table:table-row') rows.push(el);
    else if (ROW_GROUPS.has(el.tagName)) for (const row of ownRows(el)) rows.push(row); // no spread: a group can hold 100k+ rows
  }
  return rows;
}

// Block elements of an office:text body or a presentation frame → Markdown lines.
function blocks(parent, depth = 0) {
  const out = [];
  for (const el of parent.children) {
    if (el.tagName === 'text:h') {
      const text = inline(el);
      if (text) out.push(contentHeading(Number(el.getAttribute('text:outline-level') || 1), text));
    } else if (el.tagName === 'text:p') {
      const text = inline(el);
      if (text) out.push(text);
    } else if (el.tagName === 'text:list') {
      for (const item of el.children) {
        const lines = blocks(item, depth + 1);
        lines.forEach((l, i) => out.push(i === 0 && !l.startsWith('  ') && !l.startsWith('- ') ? `${'  '.repeat(depth)}- ${l}` : l));
      }
    } else if (el.tagName === 'table:table') {
      const rows = ownRows(el).map((tr) => [...tr.children].filter((tc) => tc.tagName === 'table:table-cell').map((tc) => blocks(tc).join(' ')));
      if (rows.length) out.push(mdTable(rows));
    } else if (el.tagName === 'text:section' || el.tagName === 'draw:frame' || el.tagName === 'draw:text-box') {
      out.push(...blocks(el, depth));
    }
  }
  return out;
}

async function content(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file('content.xml');
  if (!file) throw new Error('not an OpenDocument file');
  return xml(await file.async('string'));
}

export async function odt(bytes) {
  const body = (await content(bytes)).getElementsByTagName('office:text')[0];
  return { md: body ? blocks(body).join('\n\n') : '', assets: new Map() };
}

export async function odp(bytes) {
  const pages = [...(await content(bytes)).getElementsByTagName('draw:page')];
  const md = pages
    .map((page, i) => {
      const lines = [];
      for (const frame of page.getElementsByTagName('draw:frame')) lines.push(...blocks(frame));
      const [title, ...rest] = lines;
      if (!title) return '';
      return [contentHeading(1, `Slide ${i + 1}: ${title}`), ...rest.map((l) => (l.startsWith('- ') || l.startsWith('|') ? l : `- ${l}`))].join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  return { md, assets: new Map() };
}
