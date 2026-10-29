// Crafted course files (a lecturer or another student can upload anything):
// each converter's work and output must stay in proportion to the file. Each
// input here took the panel seconds to hours, or hundreds of MB, before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import './helpers/dom.mjs';

const { converterFor } = await import('../src/pack/formats/index.js');
const { pagesToMd } = await import('../src/pack/formats/pdf-layout.js');
const { htmlToMd } = await import('../src/pack/formats/html-to-md.js');
const { mdTable } = await import('../src/pack/md.js');
const { limiter } = await import('../src/limit.js');

async function convert(name, input) {
  const converter = converterFor(name);
  return converter.convert(converter.binary ? input : new TextDecoder().decode(input), { fileId: 1 });
}
const zip = (files) => {
  const z = new JSZip();
  for (const [name, text] of Object.entries(files)) z.file(name, text);
  return z.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
};
const text = (s) => new TextEncoder().encode(s).buffer;
// Runs fn and checks it finishes well within a second (each took seconds or more before).
async function quickly(fn) {
  const start = performance.now();
  const result = await fn();
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
  return result;
}

// ---------- spreadsheets ----------

test('xlsx: a huge declared range with one cell is read by its cells, not its range', async () => {
  // Written by hand: SheetJS's own writer would walk the whole range.
  const bytes = await zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
  });
  const { md } = await quickly(() => convert('grades.xlsx', bytes));
  assert.equal(md, 'x');
});

// ---------- Office 97-2003 ----------

function cfb(streams) {
  const file = XLSX.CFB.utils.cfb_new();
  for (const [name, bytes] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(file, `/${name}`, bytes);
  return new Uint8Array(XLSX.CFB.write(file, { type: 'array' })).buffer;
}

// A .ppt whose slide list names one slide container `slides` times.
function aliasedPpt(slides, text) {
  const body = new TextEncoder().encode(text);
  const b = new Uint8Array(200 + 28 * slides + body.length);
  const v = new DataView(b.buffer);
  let o = 0;
  const rec = (ver, type, len) => (v.setUint16(o, ver, true), v.setUint16(o + 2, type, true), v.setUint32(o + 4, len, true), (o += 8), o - 8);
  const end = (at) => v.setUint32(at + 4, o - at - 8, true);
  const u32 = (x) => (v.setUint32(o, x, true), (o += 4));
  const docAt = rec(0xf, 0x03e8, 0);
  const listAt = rec(0xf, 0x0ff0, 0);
  for (let i = 0; i < slides; i++) (rec(0, 0x03f3, 20), u32(1), u32(0), u32(0), u32(0), u32(256 + i));
  end(listAt), end(docAt);
  const slideAt = rec(0xf, 0x03ee, 0);
  rec(0, 0x0fa8, body.length), b.set(body, o), (o += body.length);
  end(slideAt);
  const dirAt = rec(0, 0x1772, 12);
  u32(1 | (2 << 20)), u32(slideAt), u32(docAt); // persist id 1 → the slide, 2 → the document
  const editAt = rec(0, 0x0ff5, 28);
  u32(0), u32(0), u32(0), u32(dirAt), u32(2), u32(0), u32(0);
  const user = new Uint8Array(32);
  new DataView(user.buffer).setUint32(16, editAt, true);
  return cfb({ 'PowerPoint Document': b.slice(0, o), 'Current User': user });
}

test('ppt: a slide named many times in the slide list is read once', async () => {
  const { md } = await quickly(() => convert('deck.ppt', aliasedPpt(20000, 'Only slide\rits one line')));
  assert.equal(md, '#### Slide 1\n- Only slide\n- its one line');
});

test('doc: a text length past the stream is a damaged file, not a huge one', async () => {
  // 3000 pieces all pointing at one 10 KB run of text: 30 million characters from a 46 KB file.
  const run = 10000, pieces = 3000, at = 0x200;
  const word = new Uint8Array(at + run).fill(0x61, at);
  const w = new DataView(word.buffer);
  w.setUint16(0, 0xa5ec, true);
  w.setUint16(0x0a, 0x0200, true); // text in 1Table
  w.setUint32(0x4c, run * pieces, true); // ccpText
  const lcb = 12 * pieces + 4;
  w.setUint32(0x1a2, 0, true);
  w.setUint32(0x1a6, lcb + 5, true);
  const table = new Uint8Array(5 + lcb);
  const t = new DataView(table.buffer);
  table[0] = 0x02;
  t.setUint32(1, lcb, true);
  for (let i = 0; i <= pieces; i++) t.setUint32(5 + i * 4, i * run, true);
  for (let i = 0; i < pieces; i++) t.setUint32(5 + (pieces + 1) * 4 + i * 8 + 2, 0x40000000 | (at * 2), true); // 8-bit text at `at`
  await quickly(() => assert.rejects(convert('notes.doc', cfb({ WordDocument: word, '1Table': table })), /damaged Word file/));
});

// ---------- PDF layout ----------

const styles = { sans: { fontFamily: 'sans-serif' }, mono: { fontFamily: 'monospace' } };
const frag = (str, x, y, size = 12, font = 'sans') => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, fontName: font });

test('pdf: a 100k-line paragraph joins in linear time', async () => {
  const n = 100000;
  const items = Array.from({ length: n }, (_, i) => frag('ab cd', 72, n * 14 - i * 14));
  const [page] = await quickly(() => pagesToMd([{ items, styles, view: [0, 0, 612, n * 14 + 100] }]));
  assert.equal(page.md.length, n * 6 - 1);
});

test('pdf: code indent is capped however far right a line is drawn', () => {
  const items = [frag('a{', 10, 700, 0.001, 'mono'), frag('b{', 6000, 699.998, 0.001, 'mono')];
  const [page] = pagesToMd([{ items, styles, view: [0, 0, 7000, 792] }]);
  assert.equal(page.md, `\`\`\`\na{\n${' '.repeat(120)}b{\n\`\`\``);
});

// ---------- OpenDocument ----------

const odt = (body) => zip({ 'content.xml': `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>${body}</office:text></office:body></office:document-content>` });

test('odt: nested tables render each level once', async () => {
  let inner = '<text:p>core</text:p>';
  for (let i = 0; i < 20; i++) inner = `<table:table><table:table-row><table:table-cell><text:p>x</text:p>${inner}</table:table-cell></table:table-row></table:table>`;
  const { md } = await quickly(async () => convert('notes.odt', await odt(inner)));
  assert.ok(md.length < 2000, `${md.length} characters`);
  assert.match(md, /core/);
});

test('odt: text:s counts are not spelled out (a billion spaces reads as one)', async () => {
  const { md } = await quickly(async () => convert('notes.odt', await odt('<text:p>a<text:s text:c="1000000000"/>b</text:p>'.repeat(20))));
  assert.equal(md, Array(20).fill('a b').join('\n\n'));
});

// ---------- tables ----------

test('ragged tables are not padded to millions of empty cells', () => {
  const out = mdTable([Array(5000).fill('h'), ...Array.from({ length: 5000 }, () => ['a'])]);
  assert.ok(out.length < 100000, `${out.length} characters`);
  assert.match(out, /^\| h \| h \|/);
  assert.equal(out.split('\n').at(-1), '| a |');
});

// ---------- PowerPoint (.pptx) ----------

test('pptx: a slide part listed many times is read once', async () => {
  const bytes = await zip({
    'ppt/presentation.xml': `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${'<p:sldId r:id="rId1"/>'.repeat(5000)}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Once</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
  const { md } = await quickly(() => convert('deck.pptx', bytes));
  assert.equal(md, '#### Slide 1: Once');
});

// ---------- text and HTML ----------

test('text formats: runs with no closing mark are not rescanned', async () => {
  const n = 200000;
  await quickly(() => convert('main.js', text(`a${' '.repeat(n)}a`)));
  await quickly(() => convert('lecture.vtt', text('<'.repeat(n))));
  await quickly(() => convert('lecture.srt', text('{\\'.repeat(n / 2))));
  await quickly(() => convert('invite.ics', text(`BEGIN:VEVENT\nSUMMARY:x\nDESCRIPTION:${'<http:'.repeat(n / 6)}\nEND:VEVENT`)));
});

test('html: long blank runs, long lists and unclosed <img runs convert in linear time', async () => {
  await quickly(() => htmlToMd(`<p>${'&nbsp;'.repeat(200000)}x</p>`));
  await quickly(() => htmlToMd(`<pre>${' '.repeat(200000)}x</pre>`));
  const list = await quickly(() => htmlToMd(`<ol>${'<li>a</li>'.repeat(20000)}</ol>`));
  assert.match(list, /^1\. a\n2\. a/);
  assert.match(list, /20000\. a$/);
  const book = await zip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    'c.opf': '<package><manifest><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    'ch1.xhtml': '<img'.repeat(100000),
  });
  await quickly(() => convert('book.epub', book));
});

test('limiter: a long queue drains in linear time', async () => {
  const limit = limiter(6);
  const results = await quickly(() => Promise.all(Array.from({ length: 100000 }, (_, i) => limit(() => i))));
  assert.equal(results[99999], 99999);
});
