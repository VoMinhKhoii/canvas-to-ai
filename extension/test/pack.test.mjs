import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';
import { makePdf } from './helpers/pdf.mjs';
import JSZip from 'jszip';

const { createPackBuilder, isReadable } = await import('../src/pack/build.js');

// The file seam, in memory: Canvas file details by id, bytes by URL.
function fakeFiles(files) {
  const calls = { meta: 0, bytes: 0 };
  return {
    calls,
    async meta(id) {
      calls.meta++;
      if (!files[id]) throw new Error('not found');
      const { name, size = 50_000, locked = '' } = files[id];
      return { name, size, url: `https://files.test/${id}`, locked };
    },
    async bytes(url) {
      calls.bytes++;
      return files[Number(url.split('/').pop())].bytes;
    },
  };
}
const pdf = { load: () => import('pdfjs-dist/legacy/build/pdf.mjs'), renderPage: async () => null };

const file = (key, id, title, fileName = title, extra = {}) => ({ key, kind: 'file', id, title, fileName, ...extra });
const course = { name: 'Systems Architecture and Design' };
const week1 = { id: 'w1', title: 'Week 1 · Introduction' };
const pre = { title: 'Pre-class' };
const lab = { title: 'Lab' };
const picks = [
  { folder: week1, section: pre, item: { key: 'p', kind: 'page', title: 'Welcome', html: '<p>Read this first.</p><img src="/courses/7/files/88/preview"><img src="/courses/7/files/89/preview">' } },
  { folder: week1, section: pre, item: file('f1', 11, '1.1 Intro.pdf') },
  { folder: week1, section: pre, item: { key: 'l', kind: 'link', title: 'Lecture recording', url: 'https://video.test/1' } },
  { folder: week1, section: lab, item: file('f2', 12, 'Screenshot', 'shot.png') },
  { folder: week1, section: lab, item: file('f3', 11, '1.1 Intro.pdf (again)', '1.1 Intro.pdf') },
  { folder: week1, section: lab, item: file('f4', 13, 'Lecture.mov') },
  { folder: week1, section: lab, item: file('f5', 14, 'Lab 2.pdf', 'Lab 2.pdf', { locked: 'Locked until Nov 3' }) },
];
const store = {
  11: { name: '1.1 Intro.pdf', bytes: makePdf([['Software architecture is about structure.']]) },
  12: { name: 'shot.png' },
  88: { name: 'diagram.png', size: 40_000 },
  89: { name: 'bullet.png', size: 900 }, // an icon: too small to send
};

test('a pack: folders, sections and items in order, with exactly the pictures it uses', async () => {
  const packs = createPackBuilder({ files: fakeFiles(store), pdf });
  const { markdown, images, skipped } = await packs.build(course, picks);
  assert.equal(
    markdown,
    [
      '# Systems Architecture and Design',
      '## Week 1 · Introduction',
      '**Pre-class**',
      '### Welcome\nRead this first.\n\n![](images/88-diagram.png)',
      '### 1.1 Intro.pdf\n[p.1]\nSoftware architecture is about structure.',
      '### Lecture recording\nLink: https://video.test/1',
      '**Lab**',
      '### Screenshot\n![](images/12-shot.png)',
      '### 1.1 Intro.pdf (again)\n_(same file as above)_',
      "## Not included\n- Lecture.mov (video: the AI can't watch it here)\n- Lab 2.pdf (Locked until Nov 3)",
    ].join('\n\n') + '\n',
  );
  assert.deepEqual(images.map((i) => i.name), ['88-diagram.png', '12-shot.png']);
  assert.equal(images[0].url, 'https://files.test/88');
  assert.equal(skipped.length, 2);
});

test('conversions are cached across builds and reported as they finish', async () => {
  const files = fakeFiles(store);
  const packs = createPackBuilder({ files, pdf });
  const progress = [];
  await packs.build(course, picks, (p) => progress.push(p));
  await packs.build(course, picks);
  assert.equal(files.calls.bytes, 1); // the PDF was downloaded once
  assert.deepEqual(progress, [{ done: 1, total: 1, name: '1.1 Intro.pdf' }]);
});

test('a failed conversion is reported and retried on the next build', async () => {
  let fail = true;
  const files = fakeFiles(store);
  const bytes = files.bytes;
  files.bytes = async (url) => {
    if (fail) throw new Error('download failed (500)');
    return bytes(url);
  };
  const packs = createPackBuilder({ files, pdf });
  const first = await packs.build(course, [picks[1]]);
  assert.deepEqual(first.skipped, [{ title: '1.1 Intro.pdf', reason: 'download failed (500)' }]);
  fail = false;
  const second = await packs.build(course, [picks[1]]);
  assert.equal(second.skipped.length, 0);
});

test('readable covers documents, slides, sheets, archives, code and pictures', () => {
  for (const name of ['a.pdf', 'a.pptx', 'a.ppt', 'a.docx', 'a.doc', 'a.xlsx', 'a.xls', 'a.csv', 'a.odt', 'a.epub', 'a.zip', 'a.ipynb', 'a.vtt', 'Main.java', 'Dockerfile', 'a.png']) assert.ok(isReadable(name), name);
  for (const name of ['a.mp4', 'a.key', 'a.rar']) assert.ok(!isReadable(name), name);
});

test('a picked picture whose file Canvas has locked is left out, not linked', async () => {
  const packs = createPackBuilder({ files: fakeFiles({ 15: { name: 'answers.png', locked: 'Locked until Nov 10' } }), pdf });
  const { markdown, images, skipped } = await packs.build(course, [{ folder: week1, section: lab, item: file('f6', 15, 'Answers', 'answers.png') }]);
  assert.deepEqual(images, []);
  assert.deepEqual(skipped, [{ title: 'Answers', reason: 'Locked until Nov 10' }]);
  assert.ok(!markdown.includes('images/'));
});

// ---------- archives through the builder ----------

const zipOf = async (entries) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) zip.file(name, data);
  return zip.generateAsync({ type: 'arraybuffer' });
};
const zipPick = (id) => [{ folder: week1, section: lab, item: file('z', id, 'code.zip') }];

test('zips inside a zip: pictures keep their own names, and one budget covers them all', async () => {
  const shots = (n) => zipOf({ 'img.png': new Uint8Array(20_000).fill(n) });
  const many = (prefix) => zipOf(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${prefix}/f${i}.txt`, `${prefix} file ${i}`])));
  const store = {
    21: { name: 'pictures.zip', bytes: await zipOf({ 'a.zip': await shots(1), 'b.zip': await shots(2) }) },
    22: { name: 'nested.zip', bytes: await zipOf({ 'one.zip': await many('one'), 'two.zip': await many('two') }) },
  };
  const packs = createPackBuilder({ files: fakeFiles(store), pdf });

  const { images } = await packs.build(course, zipPick(21));
  assert.equal(new Set(images.map((i) => i.name)).size, 2); // a.zip/img.png and b.zip/img.png

  const { markdown } = await packs.build(course, zipPick(22));
  const files = markdown.match(/#### (one|two)\/f\d+\.txt/g) ?? [];
  assert.equal(files.length, 120 - 2); // the two inner zips count as files too
  assert.match(markdown, /more files not included/);
});

test('a zip stays near its length cap, however its files are sized', async () => {
  const big = (c) => c.repeat(60_000);
  const store = { 23: { name: 'big.zip', bytes: await zipOf({ 'a.txt': big('a'), 'b.txt': big('b'), 'c.txt': big('c'), 'd.txt': big('d') }) } };
  const { markdown } = await createPackBuilder({ files: fakeFiles(store), pdf }).build(course, zipPick(23));
  assert.ok(markdown.length < 201_000, String(markdown.length));
  assert.match(markdown, /cut here/);
});

test('the contents list of every zip inside a zip counts toward the length cap', async () => {
  const listing = (n) => zipOf(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${'d'.repeat(90)}/${n}-${i}.bin`, 'x'])));
  const inner = {};
  for (let n = 0; n < 20; n++) inner[`n${n}.zip`] = await listing(n); // all different, so none is a duplicate
  const store = { 24: { name: 'lists.zip', bytes: await zipOf(inner) } };
  const { markdown } = await createPackBuilder({ files: fakeFiles(store), pdf }).build(course, zipPick(24));
  assert.ok(markdown.length < 240_000, String(markdown.length)); // one list may overshoot; 20 would be ~600k
});
