import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';

const { scanCourse } = await import('../src/canvas/scan.js');

// A recorded-style Canvas: url (as the scan asks for it) → { data, next }.
function fakeCanvas(routes) {
  const asked = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      if (!(url in routes)) throw Object.assign(new Error(`Canvas answered 404 for ${url}`), { status: 404 });
      const r = routes[url];
      return Array.isArray(r) || r?.data === undefined ? { data: r, next: null } : r;
    },
  };
}

const C = '/api/v1/courses/7';
const routes = {
  [`${C}?include[]=syllabus_body`]: { name: 'Systems Architecture and Design', course_code: 'ISYS3461', syllabus_body: '<p>Read <a href="/courses/7/files/90">the guide</a>.</p>' },
  [`${C}/modules?include[]=items&include[]=content_details&per_page=100`]: [
    { id: 1, name: 'Week 1/Topic 1 - Introduction', items: [
      { type: 'Page', title: "What's happening", url: 'https://x.test/api/v1/courses/7/pages/w1', content_details: { locked_for_user: false } },
      { type: 'SubHeader', title: 'Pre-class ' },
      { type: 'File', title: '1.1 Intro.pdf', content_id: 11, content_details: { display_name: 'intro.pdf', locked_for_user: false } },
      { type: 'ExternalUrl', title: 'Lecture Recording Week 1', external_url: 'https://video.test/1' },
      { type: 'SubHeader', title: 'Lab' },
      { type: 'File', title: 'Lab 1.pdf', content_id: 12, content_details: { display_name: 'lab1.pdf', locked_for_user: true, lock_explanation: 'This file is locked until <b>Nov 3</b>.' } },
      { type: 'SubHeader', title: 'Recording' },
    ] },
    { id: 2, name: 'Week 2 - Backend', items_url: 'https://x.test/api/v1/courses/7/modules/2/items' },
    { id: 3, name: 'Week 10 - Holidays', items: [] },
  ],
  'https://x.test/api/v1/courses/7/modules/2/items?include[]=content_details&per_page=100': [
    { type: 'File', title: 'Backend.pptx', content_id: 21, content_details: { display_name: 'Backend.pptx', locked_for_user: false } },
    { type: 'Assignment', title: 'Assignment 1', url: 'https://x.test/api/v1/courses/7/assignments/5', content_details: { locked_for_user: false } },
  ],
  'https://x.test/api/v1/courses/7/assignments/5': { description: '<p>Use <a href="/courses/7/files/77">the reading</a>.</p>' },
  'https://x.test/api/v1/courses/7/pages/w1': { body: '<p>Slides: <a href="/courses/7/files/11">intro</a>, extra <a href="/courses/7/files/77/download">reading</a>.</p><img src="/courses/7/files/88/preview">' },
  '/api/v1/files/77': { display_name: 'reading.pdf', locked_for_user: false },
  '/api/v1/files/90': { display_name: 'guide.docx', locked_for_user: false },
  [`${C}/discussion_topics?only_announcements=true&per_page=100`]: { data: [{ title: 'Welcome', posted_at: '2026-10-19T01:00:00Z', message: '<p>Hi</p>' }], next: '/api/v1/courses/7/discussion_topics?page=2' },
  '/api/v1/courses/7/discussion_topics?page=2': [{ title: 'Lab moved', posted_at: '2026-10-26T01:00:00Z', message: '<p>Room 2.4</p>', attachments: [{ id: 95 }] }],
  '/api/v1/files/95': { display_name: 'room-map.png', locked_for_user: false },
};

test('a course becomes folders of sections of items', async () => {
  const canvas = fakeCanvas(routes);
  const course = await scanCourse(canvas, 7);
  assert.equal(course.name, 'Systems Architecture and Design');
  assert.equal(course.code, 'ISYS3461');
  assert.deepEqual(course.folders.map((f) => f.title), ['Week 1/Topic 1 - Introduction', 'Week 2 - Backend', 'Announcements', 'Syllabus']);

  const [week1] = course.folders;
  assert.deepEqual(week1.sections.map((s) => s.title), [null, 'Pre-class', 'Lab']); // empty "Recording" dropped
  const [top, pre, lab] = week1.sections;
  // The page also links to 1.1 Intro.pdf, which the module already lists: not repeated.
  assert.deepEqual(top.items.map((i) => [i.kind, i.title]), [['page', "What's happening"], ['file', 'reading.pdf']]);
  assert.deepEqual(pre.items.map((i) => [i.kind, i.title]), [['file', '1.1 Intro.pdf'], ['link', 'Lecture Recording Week 1']]);
  assert.equal(pre.items[1].url, 'https://video.test/1');
  assert.equal(lab.items[0].locked, 'This file is locked until Nov 3.');
  assert.equal(pre.items[0].fileName, 'intro.pdf');
});

test('announcements are read across pages, newest first, with their attachments', async () => {
  const course = await scanCourse(fakeCanvas(routes), 7);
  const ann = course.folders.find((f) => f.id === 'announcements');
  assert.deepEqual(ann.sections[0].items.map((i) => i.title), ['2026-10-26 · Lab moved', 'room-map.png', '2026-10-19 · Welcome']);
});

test('pictures a page only displays are not items; a file two pages link to is an item in both, keys unique', async () => {
  const canvas = fakeCanvas(routes);
  const course = await scanCourse(canvas, 7);
  const items = course.folders.flatMap((f) => f.sections.flatMap((s) => s.items));
  assert.ok(!items.some((i) => i.id === 88));
  const reading = items.filter((i) => i.id === 77);
  assert.deepEqual(reading.map((i) => i.key), ['m1:1', 'm2:2']);
  assert.equal(canvas.asked.filter((u) => u === '/api/v1/files/77').length, 1);
  const keys = items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('one listing request covers every module; file details are not fetched for module files', async () => {
  const canvas = fakeCanvas(routes);
  await scanCourse(canvas, 7);
  assert.ok(!canvas.asked.includes('/api/v1/files/11') && !canvas.asked.includes('/api/v1/files/12'));
  assert.equal(canvas.asked.filter((u) => u.includes('/modules?')).length, 1);
});
