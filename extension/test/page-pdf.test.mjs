import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/dom.mjs';

const { pageDoc, pictureData } = await import('../src/pack/page-pdf.js');
const require = createRequire(import.meta.url);

// Every piece of text in a pdfmake document, in order.
const words = (node) => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(words).join(' ') : node && typeof node === 'object' ? ['text', 'stack', 'ul', 'ol', 'columns', 'content'].map((k) => words(node[k])).join(' ') + (node.table ? words(node.table.body) : '') : '');
const images = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => images(n, out));
  else if (node && typeof node === 'object') {
    if (node.image) out.push(node);
    for (const k of ['text', 'stack', 'ul', 'ol', 'columns', 'content']) images(node[k], out);
    if (node.table) images(node.table.body, out);
  }
  return out;
};
const png = readFileSync(new URL('../src/icons/icon-128.png', import.meta.url));

test('page pdf: the title, then the page; nothing a reader cannot see', () => {
  const doc = pageDoc('Week 1', '<script>x()</script><style>p{}</style><h2>Hello</h2><p>Read <span class="screenreader-only">link opens in a new tab</span>this.</p>');
  const text = words(doc.content);
  assert.equal(doc.content[0].text, 'Week 1');
  assert.match(text, /Hello/);
  assert.match(text, /Read/);
  assert.doesNotMatch(text, /x\(\)|p\{\}|new tab/);
});

test('page pdf: an embedded video or tool becomes its link', () => {
  const doc = pageDoc('V', '<iframe title="Lecture 1" src="https://media.test/1"></iframe><iframe></iframe>');
  assert.match(JSON.stringify(doc.content), /"link":"https:\/\/media\.test\/1"/);
  assert.match(words(doc.content), /Embedded: +Lecture 1/);
});

test('page pdf: a picture it has is drawn at its own size, never wider than the page; one it has not keeps its alt text', () => {
  const small = pictureData(png);
  const wide = { src: 'data:image/png;base64,d2lkZQ==', width: 4000, height: 1000 };
  const doc = pageDoc('P', '<p><img src="/files/1" width="900"></p><p><img src="/files/2"></p><p><img src="/files/3" alt="Diagram"></p>', { pictures: new Map([['/files/1', small], ['/files/2', wide]]) });
  const [a, b] = images(doc.content);
  assert.deepEqual(a.fit, [96, 96]); // 128 px, in points
  assert.equal(b.fit[0], 595.28 - 112);
  assert.equal(images(doc.content).length, 2);
  assert.match(words(doc.content), /\[Diagram\]/);
});

test('page pdf: the page\'s own fonts are not asked for', () => {
  const doc = pageDoc('F', '<p style="font-family: \'Lato Extended\', sans-serif"><b>Bold</b></p>');
  assert.doesNotMatch(JSON.stringify(doc.content), /Lato/);
});

test('page pdf: pictures: PNG and JPEG with their sizes; other kinds left out', () => {
  assert.deepEqual({ ...pictureData(png), src: undefined }, { src: undefined, width: 128, height: 128 });
  assert.match(pictureData(png).src, /^data:image\/png;base64,iVBORw0KGgo/);
  // A JPEG: SOI, an APP0 segment, then the frame header (SOF0) with 300 × 200.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0]);
  assert.deepEqual({ ...pictureData(jpeg), src: undefined }, { src: undefined, width: 300, height: 200 });
  assert.equal(pictureData(new TextEncoder().encode('GIF89a......')), null);
  assert.equal(pictureData(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), null); // no frame header: no size
});

function pdfmaker() {
  const pdfmake = require('pdfmake');
  const vfs = require('pdfmake/build/vfs_fonts.js');
  for (const [name, data] of Object.entries(vfs)) pdfmake.sharedVirtualfs.writeFileSync(name, Buffer.from(data, 'base64'));
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  pdfmake.fonts = { Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } };
  return pdfmake;
}

test('page pdf: a Canvas-like page with Vietnamese text, a table, a list and a picture renders', async () => {
  const pdfmake = pdfmaker();
  const html = '<h2 style="color: rgb(45, 59, 69); font-family: Lato">Chào mừng các bạn</h2><p>Tiếng Việt: ắ ằ ẳ ẵ ặ ữ ự.</p><ul><li>One<ul><li>Two</li></ul></li></ul>'
    + '<table border="1" style="width: 100%"><tbody><tr><th>Week</th><th>Topic</th></tr><tr><td colspan="2">Intro</td></tr></tbody></table><p><img src="/files/1"></p><pre>def f():\n    pass</pre>';
  const buffer = await pdfmake.createPdf(pageDoc('Tuần 1', html, { pictures: new Map([['/files/1', pictureData(png)]]) })).getBuffer();
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buffer.length > 10_000);
});

test('page pdf: plain, a table becomes its rows as lines, and renders where the table would not', async () => {
  const html = '<table style="width: 100%"><tr><td>Week 1</td><td><table><tr><td>Intro</td></tr></table></td></tr><tr><td></td><td>Lab</td></tr></table>'; // no <tbody>: a table pdfmake cannot lay out
  await assert.rejects(pdfmaker().createPdf(pageDoc('T', html)).getBuffer());
  const doc = pageDoc('T', html, { plain: true });
  assert.doesNotMatch(JSON.stringify(doc.content), /"table"|width/);
  assert.match(words(doc.content), /Week 1 · Intro/);
  assert.match(words(doc.content), /Lab/);
  const buffer = await pdfmaker().createPdf(doc).getBuffer();
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
});


test('page pdf: the page\'s own links point at its Canvas site; emoji, which the font lacks, are left out', () => {
  const doc = pageDoc('L', '<p>📌 Read <a href="/courses/7/files/12/download">the worksheet</a> 👍🏽</p><iframe src="/media_objects_iframe/m-1"></iframe>', { base: 'https://uni.instructure.com' });
  const json = JSON.stringify(doc.content);
  assert.match(json, /"link":"https:\/\/uni\.instructure\.com\/courses\/7\/files\/12\/download"/);
  assert.match(json, /"link":"https:\/\/uni\.instructure\.com\/media_objects_iframe\/m-1"/);
  assert.doesNotMatch(words(doc.content), /📌|👍|🏽/);
  assert.match(words(doc.content), /Read/);
  assert.match(words(pageDoc('S ★', '<p>A ↔ B; © 2026; ACME™ ⚠ Done ✔️ ❤️ x ≤ π</p>').content), /^S +A <-> B; © 2026; ACME™ +Done √ +x ≤ π *$/); // what the font draws stays, arrows and ticks become look-alikes, the rest goes
});

test('page pdf: letters the font cannot draw are noticed; Vietnamese (even decomposed), Greek and Cyrillic are not', async () => {
  const { lacksLetters } = await import('../src/pack/page-pdf.js');
  for (const s of ['学生', 'こんにちは', '안녕', 'مرحبا', 'สวัสดี', '&#23398;&#29983;', '<img alt="学生">']) assert.ok(lacksLetters('T', `<p>${s}</p>`), s);
  assert.ok(lacksLetters('学生', '<p>Hi</p>'));
  for (const s of ['Tiếng Việt ắ ự', 'Tiếng Việt'.normalize('NFD'), 'Ωμέγα', 'Привет', '→ 📌 ⚠ © 1 + 2', '<a href="https://x.test/学">link</a>']) assert.ok(!lacksLetters('T', `<p>${s}</p>`), s);
});

test('page pdf: the font\'s coverage table matches the font pdfmake ships (npm run fonts after an upgrade)', async () => {
  const { coverage } = await import('../font-coverage.mjs');
  const { COVERED } = await import('../src/pack/font-coverage.js');
  assert.deepEqual(COVERED, coverage());
});
