import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import './helpers/dom.mjs';

const { converterFor, unreadableReason } = await import('../src/pack/formats/index.js');

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const bytesOf = async (zip) => zip.generateAsync({ type: 'arraybuffer' });
const picture = (size) => new Uint8Array(size).fill(7); // stands in for image data
async function convert(name, input, ctx = {}) {
  const converter = converterFor(name);
  assert.ok(converter, `no converter for ${name}`);
  return converter.convert(input, { fileId: 1, ...ctx });
}

// ---------- spreadsheets ----------

test('xlsx: one table per sheet, formulas beside their values', async () => {
  const wb = XLSX.utils.book_new();
  const marks = XLSX.utils.aoa_to_sheet([['Student', 'A1', 'A2', 'Total'], ['Mai', 30, 40, 0], ['Tom', 25, 35, 0]]);
  marks.D2 = { t: 'n', v: 70, f: 'B2+C2' };
  marks.D3 = { t: 'n', v: 60, f: 'B3+C3' };
  XLSX.utils.book_append_sheet(wb, marks, 'Marks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Weight'], [0.3], [0.7]]), 'Weights');
  const { md } = await convert('marks.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  assert.match(md, /#### Sheet: Marks\n\n\| Student \| A1 \| A2 \| Total \|\n\| --- \| --- \| --- \| --- \|\n\| Mai \| 30 \| 40 \| 70 \(=B2\+C2\) \|/);
  assert.match(md, /#### Sheet: Weights\n\nWeight\n0.3\n0.7/);
});

test('xls, ods and csv read the same way; long sheets are cut with a note', async () => {
  const rows = [['Week', 'Topic'], ...Array.from({ length: 600 }, (_, i) => [i + 1, `Topic ${i + 1}`])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Plan');
  for (const bookType of ['xls', 'ods']) {
    const { md } = await convert(`plan.${bookType}`, XLSX.write(wb, { type: 'array', bookType: bookType === 'xls' ? 'biff8' : bookType }));
    assert.match(md, /\| 499 \| Topic 499 \|/, bookType);
    assert.ok(!md.includes('Topic 500 |'), bookType);
    assert.match(md, /_\(101 more rows not shown; open the file for all of them\)_/, bookType);
  }
  const { md } = await convert('plan.csv', 'Week,Topic\n1,Intro\n2,"Design, part 1"\n');
  assert.equal(md, '| Week | Topic |\n| --- | --- |\n| 1 | Intro |\n| 2 | Design, part 1 |');
});

// ---------- Office 97-2003 ----------

test('ppt: slides in order from the live document, stale fast-save copies ignored', async () => {
  const { md } = await convert('lecture.ppt', fixture('basic_test_ppt_file.ppt'));
  assert.equal(
    md,
    '#### Slide 1: This is a test title\n- This is a test subtitle\n- This is on page 1\n> Notes: These are the notes for page 1\n\n' +
      '#### Slide 2: This is the title on page 2\n- This is page two\n- It has several blocks of text\n- None of them have formatting\n> Notes: These are the notes on page two, again lacking formatting',
  );
  const { md: show } = await convert('show.ppt', fixture('SampleShow.ppt'));
  assert.match(show, /#### Slide 2: This is the second slide\n- It has bullet points on it/);
  assert.ok(!/Click to edit Master/.test(show));
});

test('doc: the main text, paragraph by paragraph', async () => {
  const { md } = await convert('notes.doc', fixture('SampleDoc.doc'));
  assert.equal(md.split('\n\n').slice(0, 3).join('|'), 'I am a test document|This is page 1|I am Calibri (Body) in font size 11');
});

test('doc: a damaged formatting record is an error, not a hang', async () => {
  const cfb = XLSX.CFB.read(new Uint8Array(fixture('SampleDoc.doc')), { type: 'array' });
  const word = XLSX.CFB.find(cfb, 'WordDocument').content;
  const fcClx = word[0x1a2] | (word[0x1a3] << 8) | (word[0x1a4] << 16) | (word[0x1a5] << 24);
  const table = XLSX.CFB.find(cfb, word[0x0b] & 0x02 ? '1Table' : '0Table').content;
  [0x01, 0xfd, 0xff].forEach((b, k) => (table[fcClx + k] = b)); // a Prc whose length reads as -3
  await assert.rejects(convert('broken.doc', XLSX.CFB.write(cfb, { type: 'array' })));
});

test('doc: an embedded object with streams of the same names does not hide the document', async () => {
  const sample = XLSX.CFB.read(new Uint8Array(fixture('SampleDoc.doc')), { type: 'array' });
  const out = XLSX.CFB.utils.cfb_new();
  // The embedded object comes first, as in a real course file.
  XLSX.CFB.utils.cfb_add(out, '/ObjectPool/_1192176770/1Table', new Uint8Array(64));
  XLSX.CFB.utils.cfb_add(out, '/ObjectPool/_1192176770/WordDocument', new Uint8Array(64));
  for (const [i, path] of sample.FullPaths.entries()) {
    const entry = sample.FileIndex[i];
    if (entry.type === 2 && entry.content) XLSX.CFB.utils.cfb_add(out, path.replace(/^[^/]*/, ''), entry.content);
  }
  const { md } = await convert('notes.doc', XLSX.CFB.write(out, { type: 'array' }));
  assert.match(md, /^I am a test document/);
});

test('doc: a piece that points outside the document is an error, not a short text', async () => {
  const cfb = XLSX.CFB.read(new Uint8Array(fixture('SampleDoc.doc')), { type: 'array' });
  const word = XLSX.CFB.find(cfb, 'WordDocument').content;
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const table = XLSX.CFB.find(cfb, word[0x0b] & 0x02 ? '1Table' : '0Table').content;
  let o = u32(word, 0x1a2);
  while (table[o] === 0x01) o += 3 + (table[o + 1] | (table[o + 2] << 8));
  const n = (u32(table, o + 1) - 4) / 12;
  const fcAt = o + 5 + (n + 1) * 4 + 2; // the first piece's file offset
  [0x00, 0x00, 0xff, 0x3f].forEach((b, k) => (table[fcAt + k] = b)); // far past the end of WordDocument
  await assert.rejects(convert('broken.doc', XLSX.CFB.write(cfb, { type: 'array' })), /damaged Word file/);
});

// ---------- Office Open XML ----------

function slideXml({ title, bullets = [], pictures = [] }) {
  const sp = (y, ph, paras) => `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="${y}"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const pics = pictures.map((p, i) => `<p:pic><p:blipFill><a:blip r:embed="rIdPic${i}"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="${900 + i}"/><a:ext cx="${p.cx}" cy="${p.cy}"/></a:xfrm></p:spPr></p:pic>`);
  return `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>${sp(0, '<p:ph type="title"/>', [title])}${sp(200, '<p:ph idx="1"/>', bullets)}${pics.join('')}</p:spTree></p:cSld></p:sld>`;
}

async function pptx(slides) {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(s));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<Relationships>${(s.pictures ?? []).map((p, k) => `<Relationship Id="rIdPic${k}" Type="image" Target="../media/${p.media}"/>`).join('')}</Relationships>`);
    for (const p of s.pictures ?? []) zip.file(`ppt/media/${p.media}`, picture(20_000));
  });
  return bytesOf(zip);
}

test('pptx: icons and a logo on every slide are dropped, and so are their assets', async () => {
  const logo = { media: 'logo.png', cx: 1_200_000, cy: 1_200_000 }; // 1.7% of the slide
  const icon = { media: 'icon.png', cx: 600_000, cy: 600_000 }; // 0.4%
  const diagram = { media: 'diagram.png', cx: 6_000_000, cy: 4_000_000 }; // 29%
  const { md, assets } = await convert('deck.pptx', await pptx([
    { title: 'C4 model', bullets: ['Context', 'Containers'], pictures: [logo, icon, diagram] },
    { title: 'Context', bullets: ['Users'], pictures: [logo] },
    { title: 'Containers', bullets: ['Apps'], pictures: [logo] },
  ]));
  assert.match(md, /#### Slide 1: C4 model\n- Context\n- Containers\n!\[\]\(images\/1-diagram.png\)/);
  assert.ok(!md.includes('logo') && !md.includes('icon'), md);
  assert.deepEqual([...assets.keys()], ['1-diagram.png']);
});

test('docx: headings, lists, tables and pictures', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lab 1</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Install Node</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Step</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Time</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Setup</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10 min</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="image" Target="media/shot.png"/></Relationships>');
  zip.file('word/media/shot.png', picture(20_000));
  const { md, assets } = await convert('lab.docx', await bytesOf(zip));
  assert.equal(md, '#### Lab 1\n\n- Install Node\n\n| Step | Time |\n| --- | --- |\n| Setup | 10 min |\n\n![](images/1-shot.png)');
  assert.deepEqual([...assets.keys()], ['1-shot.png']);
});

// ---------- OpenDocument, EPUB ----------

test('odt and odp', async () => {
  const odt = new JSZip();
  odt.file('content.xml', `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>
    <text:h text:outline-level="1">Week 1 notes</text:h><text:p>Hello<text:s text:c="2"/>world</text:p><text:p><text:span>Bold </text:span><text:span>and plain</text:span></text:p>
    <text:list><text:list-item><text:p>First</text:p></text:list-item><text:list-item><text:p>Second</text:p></text:list-item></text:list>
    <table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body></office:document-content>`);
  const { md } = await convert('notes.odt', await bytesOf(odt));
  assert.equal(md, '#### Week 1 notes\n\nHello world\n\nBold and plain\n\n- First\n\n- Second\n\n| A | B |\n| --- | --- |');

  const odp = new JSZip();
  odp.file('content.xml', `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:draw="d"><office:body><office:presentation>
    <draw:page><draw:frame><draw:text-box><text:p>Agile</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:p>Sprints</text:p><text:p>Stand-ups</text:p></draw:text-box></draw:frame></draw:page>
  </office:presentation></office:body></office:document-content>`);
  const { md: slides } = await convert('talk.odp', await bytesOf(odp));
  assert.equal(slides, '#### Slide 1: Agile\n- Sprints\n- Stand-ups');
});

test('epub: chapters in spine order, with their pictures', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<package><manifest><item id="c2" href="ch2.xhtml"/><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OEBPS/ch1.xhtml', '<html><body><h1>Chapter 1</h1><p>Design is choices.</p><img src="images/fig.png"/></body></html>');
  zip.file('OEBPS/ch2.xhtml', '<html><body><h1>Chapter 2</h1><p>Trade-offs.</p></body></html>');
  zip.file('OEBPS/images/fig.png', picture(20_000));
  const { md, assets } = await convert('book.epub', await bytesOf(zip));
  assert.equal(md, '#### Chapter 1\n\nDesign is choices.\n\n![](images/1-OEBPS_images_fig-y4zeqd.png)\n\n#### Chapter 2\n\nTrade-offs.');
  assert.deepEqual([...assets.keys()], ['1-OEBPS_images_fig-y4zeqd.png']);
});

// ---------- archives ----------

test('zip: contents listed, readable files converted, build and dependency files left out', async () => {
  const zip = new JSZip();
  zip.file('lab/src/Main.java', 'class Main {\n  public static void main(String[] a) {}\n}\n');
  zip.file('lab/README.md', '# Lab 3\nRun it.');
  zip.file('lab/data.csv', 'x,y\n1,2\n');
  zip.file('lab/node_modules/left-pad/index.js', 'module.exports = 1;');
  zip.file('lab/package-lock.json', '{}');
  zip.file('lab/screen.png', picture(20_000));
  zip.file('lab/tool.exe', picture(100));
  const ctx = { fileId: 5 };
  const { md, assets } = await convert('lab3.zip', await bytesOf(zip), ctx);
  assert.match(md, /^#### Contents \(5 files; 2 build, dependency or editor files left out\)\n- lab\/data.csv\n- lab\/README.md\n- lab\/screen.png\n- lab\/src\/Main.java\n- lab\/tool.exe/);
  assert.match(md, /#### lab\/src\/Main.java\n```java\nclass Main \{/);
  assert.match(md, /#### lab\/data.csv\n\| x \| y \|/);
  assert.match(md, /#### lab\/README.md\n#### Lab 3\nRun it./); // its own heading goes under the file's
  assert.ok(!md.includes('left-pad') && !md.includes('module.exports'));
  assert.equal(assets.size, 0); // a code project's pictures are its icons: not sent
});

test('zip: files are paid for before they are unpacked, pictures too, from one budget', async () => {
  const text = new JSZip();
  text.file('small.txt', 'fits');
  text.file('zbig.txt', 'x'.repeat(5_000)); // unpacks past what is left
  const budget = { files: 120, chars: 200_000, bytes: 1_000 };
  const { md } = await convert('code.zip', await text.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }), { budget });
  assert.match(md, /#### small.txt\nfits/);
  assert.ok(!md.includes('xxxx') && /1 more files not included/.test(md), md);

  const shots = new JSZip();
  for (let i = 0; i < 5; i++) shots.file(`s${i}.png`, picture(20_000 + i));
  const { assets } = await convert('shots.zip', await bytesOf(shots), { budget: { files: 2, chars: 200_000, bytes: 1e9 } });
  assert.equal(assets.size, 2);
});

test('zip: a document cut for length sends only the pictures its kept part shows', async () => {
  const doc = new JSZip();
  doc.file('word/document.xml', `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
    <w:p><w:r><w:t>${'word '.repeat(14_000)}</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p></w:body></w:document>`);
  doc.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="image" Target="media/late.png"/></Relationships>');
  doc.file('word/media/late.png', picture(20_000));
  const outer = new JSZip();
  outer.file('notes.docx', await bytesOf(doc));
  const { md, assets } = await convert('week.zip', await bytesOf(outer));
  assert.match(md, /cut here/);
  assert.equal(assets.size, 0);
});

// ---------- text formats ----------

test('captions become a transcript; rtf keeps its text; notebooks keep code cells', async () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nWelcome to week one.\n\n2\n00:00:03.000 --> 00:00:05.000\n<v Tri>Today we cover\n\n3\n00:00:05.000 --> 00:00:07.000\nTriage. Then design.';
  assert.equal((await convert('lecture.vtt', vtt)).md, 'Welcome to week one.\n\nToday we cover Triage.\n\nThen design.');
  const rtfText = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}\\f0 Caf\\\'e9 menu\\par Second line\\par}';
  assert.equal((await convert('menu.rtf', rtfText)).md, 'Café menu\nSecond line');
  const nb = JSON.stringify({ metadata: { kernelspec: { language: 'python' } }, cells: [{ cell_type: 'markdown', source: ['# Lab'] }, { cell_type: 'code', source: 'print(1)' }] });
  assert.equal((await convert('lab.ipynb', nb)).md, '# Lab\n\n```python\nprint(1)\n```');
  assert.equal((await convert('Dockerfile', 'FROM node:22\n')).md, '```dockerfile\nFROM node:22\n```');
});

test('Arduino sketches, systemd units and calendars are read as text', async () => {
  assert.equal((await convert('blink.ino', 'void loop() {}\n')).md, '```cpp\nvoid loop() {}\n```');
  assert.match((await convert('app.service', '[Unit]\nDescription=App\n')).md, /^```ini\n\[Unit\]/);
  const invite = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'ATTENDEE;CN="A Lecturer":mailto:a.lecturer@rmit.edu.', '\tvn',
    'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'ACTION:DISPLAY', 'END:VALARM', // a reminder first: its description is not the event's
    'DESCRIPTION:Online Lecture v', '\tia TEAMS\\n\\n________________\\nClick here to join <https://aus01.safelinks.protection.outlook.com/ap/t-1/?url=x>',
    'DTSTART;TZID=SE Asia Standard Time:20240305T090000', 'DTEND;TZID=SE Asia Standard Time:20240305T110000',
    'LOCATION:Microsoft Teams Meeting', 'SUMMARY:OENG1272 Lecture\\, week 2', 'X-ALT-DESC;FMTTYPE=text/html:<html><body>…</body></html>',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  assert.equal((await convert('class.ics', invite)).md, '#### OENG1272 Lecture, week 2\n2024-03-05 09:00 to 2024-03-05 11:00\nWhere: Microsoft Teams Meeting\nOnline Lecture via TEAMS\nClick here to join');
});

test('a CSV of hundreds of thousands of rows shows the first 500 and says how many more', async () => {
  const csv = ['Name,Year', ...Array.from({ length: 300_000 }, (_, i) => `n${i},2012`)].join('\n');
  const { md } = await convert('names.csv', csv);
  assert.match(md, /\| n498 \| 2012 \|/);
  assert.ok(!md.includes('| n499 |'));
  assert.match(md, /299,501 more rows not shown/);
});

test('files that cannot be read say why, in plain words', () => {
  assert.equal(converterFor('lecture.mp4'), null);
  assert.equal(unreadableReason('lecture.mp4'), "video: the AI can't watch it here");
  assert.equal(unreadableReason('slides.key'), 'Apple file: export it as PDF first');
  assert.equal(unreadableReason('code.rar'), 'compressed file: only .zip can be opened');
  assert.equal(unreadableReason('mystery.xyz'), ".xyz files can't be read");
});

test('zip: generated READMEs, licences and identical copies are left out; a picture bundle sends its pictures', async () => {
  const project = new JSZip();
  project.file('app/README.md', '# Getting Started with Create React App\n\nThis project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).');
  project.file('app/LICENSE', 'MIT');
  project.file('app/src/App.js', 'export default 1;');
  project.file('solution/src/App.js', 'export default 1;');
  project.file('solution/src/Extra.js', 'export const x = 2;');
  const ctx = { fileId: 6 };
  const { md } = await convert('code.zip', await bytesOf(project), ctx);
  assert.ok(!md.includes('bootstrapped') && !md.includes('#### app/LICENSE'), md);
  assert.equal(md.match(/export default 1;/g).length, 1);
  assert.match(md, /#### solution\/src\/Extra.js/);

  const shots = new JSZip();
  shots.file('week1/a.png', picture(20_000));
  shots.file('week1/b.png', picture(30_000));
  const { assets } = await convert('screenshots.zip', await bytesOf(shots), ctx);
  assert.equal(assets.size, 2);
});

test('Markdown files keep their headings, one level below the file', async () => {
  const { md } = await convert('notes.md', '# Title\n\n```\n# not a heading\n```\n## Part');
  assert.equal(md, '#### Title\n\n```\n# not a heading\n```\n##### Part');
});
