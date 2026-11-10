// Download all of Canvas: pacing, what a whole-course scan adds, the plan, and
// a run that must stay light and stop cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';

const { steady } = await import('../src/canvas/steady.js');
const { tabCanvas } = await import('../src/canvas/tab-adapter.js');
const { scanCourse, scanGroup } = await import('../src/canvas/scan.js');
const { canvadocs } = await import('../src/canvas/canvadocs.js');
const { threadHtml, feedbackHtml, gradesHtml, readMessages } = await import('../src/canvas/talk.js');
const { listCourses, planExport, planTotals, runExport, BIG_FILE } = await import('../src/export.js');
const { chromeSaver } = await import('../src/panel/chrome-saver.js');

const throttled = () => Object.assign(new Error('slow down'), { throttled: true });
const status = (n) => Object.assign(new Error(`Canvas answered ${n}`), { status: n });

function fakeCanvas(routes) {
  const asked = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      const r = routes[url];
      if (typeof r === 'function') return r();
      if (r === undefined) throw status(404);
      return r?.data !== undefined ? r : { data: r, next: null };
    },
    async graphql(query, { id, after }) {
      const key = `graphql ${id} ${after ?? ''}`;
      asked.push(key);
      const r = routes[key];
      if (typeof r === 'function') return r();
      if (r === undefined) throw new Error('Not available');
      return { data: r };
    },
  };
}

function clock() {
  let t = 0;
  const slept = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
}

// ── pacing ──
test('steady: a throttled request waits and is sent again', async () => {
  let calls = 0;
  const c = clock();
  const canvas = steady({ get: async () => { if (++calls < 3) throw throttled(); return { data: 'ok' }; } }, c);
  assert.equal((await canvas.get('/x')).data, 'ok');
  assert.deepEqual(c.slept, [2000, 4000]);
});

test('steady: gives up after its retries, still saying why', async () => {
  const c = clock();
  const canvas = steady({ get: async () => { throw throttled(); } }, c);
  await assert.rejects(canvas.get('/x'), (e) => e.throttled === true);
  assert.equal(c.slept.length, 12);
  assert.equal(Math.max(...c.slept), 30_000); // no wait longer than half a minute
  assert.ok(c.slept.reduce((a, b) => a + b) > 4 * 60_000); // a few minutes in all
});

test('steady: a lost connection is waited out like Canvas slowing down', async () => {
  let calls = 0;
  const c = clock();
  const canvas = steady({ get: async () => { if (++calls < 4) throw Object.assign(new Error('gone'), { offline: true }); return { data: 'back' }; } }, c);
  assert.equal((await canvas.get('/x')).data, 'back');
  assert.deepEqual(c.slept, [2000, 4000, 8000]);
});

test('steady: a refusal is not retried', async () => {
  let calls = 0;
  const canvas = steady({ get: async () => { calls++; throw status(403); } }, clock());
  await assert.rejects(canvas.get('/x'), (e) => e.status === 403);
  assert.equal(calls, 1);
});

test('steady: everything waits when quota runs low', async () => {
  const c = clock();
  const canvas = steady({ get: async () => ({ data: 1, remaining: 150 }) }, c);
  await canvas.get('/a');
  await canvas.get('/b');
  assert.deepEqual(c.slept, [10_000]); // 100 units short, about 10 a second
});

test('steady: at most 6 requests run at once', async () => {
  let running = 0;
  let peak = 0;
  const canvas = steady({ get: async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    return { data: 1 };
  } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => canvas.get(`/${i}`)));
  assert.equal(peak, 6);
});

// A browser with Canvas tabs: { id: url }. A tab answers once the proxy is in its current page.
function fakeTabs(tabs, answer = () => ({ status: 200, data: 'ok' })) {
  const proxied = new Set();
  const api = {
    injected: [],
    navigate: (id, url) => { tabs[id] = url; proxied.delete(id); },
    scripting: { executeScript: async ({ target }) => { if (!tabs[target.tabId] || !tabs[target.tabId].startsWith('https://school.')) throw new Error('Cannot access'); api.injected.push(target.tabId); proxied.add(target.tabId); } },
    tabs: {
      get: async (id) => (tabs[id] ? { id, url: tabs[id] } : Promise.reject(new Error('No tab'))),
      sendMessage: async (id, message) => { if (!tabs[id] || !proxied.has(id)) throw new Error('Receiving end does not exist'); return answer(id, message); },
    },
  };
  return api;
}

test('adapter: a throttled answer has no status, so nothing reads it as "closed"', async () => {
  globalThis.chrome = fakeTabs({ 1: 'https://school.instructure.com/courses/1' }, () => ({ status: 403, throttled: true }));
  const canvas = await tabCanvas(1);
  await assert.rejects(canvas.get('/x'), (e) => e.throttled === true && e.status === undefined);
});

test('adapter: the student moving around Canvas in that tab puts the proxy back in the new page', async () => {
  const browser = (globalThis.chrome = fakeTabs({ 1: 'https://school.instructure.com/courses/1' }));
  const canvas = await tabCanvas(1);
  browser.navigate(1, 'https://school.instructure.com/calendar');
  assert.equal((await canvas.get('/x')).data, 'ok');
  assert.deepEqual(browser.injected, [1, 1]);
});

test('adapter: the tab closed or left Canvas: another tab of the same site carries on', async () => {
  const tabs = { 1: 'https://school.instructure.com/courses/1', 2: 'https://school.instructure.com/' };
  const browser = (globalThis.chrome = fakeTabs(tabs));
  const sites = [];
  const canvas = await tabCanvas(1, { findTab: async (site) => (sites.push(site), { id: 2 }) });
  browser.navigate(1, 'https://www.youtube.com/');
  assert.equal((await canvas.get('/x')).data, 'ok');
  assert.deepEqual(sites, ['https://school.instructure.com']);
  delete tabs[2];
  delete tabs[1];
  await assert.rejects(canvas.get('/y'), (e) => e.offline === true && /Keep Canvas open/.test(e.message)); // waited out by steady()
});

test('adapter: an ended login is an error of its own, never "closed to you"', async () => {
  globalThis.chrome = fakeTabs({ 1: 'https://school.instructure.com/courses/1' }, () => ({ status: 401, loggedOut: true }));
  const canvas = await tabCanvas(1);
  await assert.rejects(canvas.get('/x'), (e) => e.loggedOut === true && /login ended/.test(e.message));
});

test('adapter: no connection is told apart from a failed request', async () => {
  globalThis.chrome = fakeTabs({ 1: 'https://school.instructure.com/courses/1' }, () => ({ error: 'No connection to Canvas', offline: true }));
  const canvas = await tabCanvas(1);
  await assert.rejects(canvas.get('/x'), (e) => e.offline === true && /internet/.test(e.message));
});

// ── the whole-course scan ──
const C = '/api/v1/courses/7';
const base = () => ({
  '/api/v1/users/self': { id: 1 },
  [`${C}?include[]=syllabus_body`]: { name: 'Algebra', course_code: 'M1' },
  [`${C}/modules?include[]=items&include[]=content_details&per_page=100`]: [{ id: 1, name: 'Week 1', items: [
    { type: 'File', title: 'Slides', content_id: 11, content_details: { display_name: 'slides.pdf', locked_for_user: false } },
    { type: 'File', title: 'Closed', content_id: 12, content_details: { display_name: 'closed.pdf', locked_for_user: true, lock_explanation: 'Locked until Friday' } },
    { type: 'Page', title: 'Intro', page_url: 'intro', url: 'https://x.test/intro', content_details: {} },
    { type: 'Discussion', title: 'Talk', content_id: 40, url: 'https://x.test/talk', content_details: {} },
  ] }],
  'https://x.test/intro': { body: '<p>Hi</p>' },
  'https://x.test/talk': { message: '<p>Discuss</p>' },
  [`${C}/discussion_topics?only_announcements=true&per_page=100`]: [],
  [`${C}/students/submissions?student_ids[]=self&include[]=assignment&include[]=submission_comments&include[]=rubric_assessment&include[]=submission_history&per_page=100`]: [
    { grade: 'HD', score: 90, assignment: { name: 'Essay', points_possible: 100 }, submission_comments: [{ author_name: 'Dr <A>', created_at: '2026-03-01T00:00:00Z', comment: 'Good\nwork' }] },
    { assignment: { name: 'Not done' } },
  ],
  [`${C}/files?per_page=100`]: [
    { id: 11, display_name: 'slides.pdf', size: 10, url: 'https://x.instructure.com/f/11' },
    { id: 12, display_name: 'closed.pdf', size: 10, url: 'https://x.instructure.com/f/12' },
    { id: 13, display_name: 'loose.zip', size: 10, url: 'https://x.instructure.com/f/13' },
  ],
  [`${C}/assignments?per_page=100`]: [{ id: 5, name: 'Loose task', description: '<p>Do it</p>' }, { id: 6, name: 'Graded talk', description: '<p>dup</p>' }],
  [`${C}/pages?per_page=100`]: [{ url: 'intro', title: 'Intro' }, { url: 'extra one', title: 'Extra' }],
  [`${C}/pages/extra%20one`]: { body: '<p>More</p>' },
  [`${C}/discussion_topics?per_page=100`]: [{ id: 40, title: 'Talk', message: 'x' }, { id: 41, title: 'Graded', assignment_id: 6, message: '<p>G</p>' }],
  [`${C}/discussion_topics/40/view?include_new_entries=1`]: { participants: [{ id: 1, display_name: 'Ann' }], view: [{ id: 9, user_id: 1, created_at: '2026-01-02T00:00:00Z', message: '<p>Reply!</p>' }] },
  [`${C}/discussion_topics/41/view?include_new_entries=1`]: () => { throw status(403); },
});
const folder = (course, id) => course.folders.find((f) => f.id === id);
const titles = (f) => f?.sections.flatMap((s) => s.items.map((i) => i.title));

test('everything: what sits outside the modules is found, without repeats', async () => {
  const course = await scanCourse(fakeCanvas(base()), 7, { everything: true });
  assert.deepEqual(titles(folder(course, 'other-assignments')), ['Loose task']); // the graded discussion stays a discussion
  assert.deepEqual(titles(folder(course, 'other-pages')), ['Extra']);
  assert.deepEqual(titles(folder(course, 'other-discussions')), ['Graded']);
  assert.deepEqual(titles(folder(course, 'other-files')), ['loose.zip']); // not the module's, locked or not
});

test('everything: one listing gives file details, no request per file', async () => {
  const canvas = fakeCanvas(base());
  const course = await scanCourse(canvas, 7, { everything: true });
  assert.equal(canvas.asked.filter((u) => u.startsWith('/api/v1/files/')).length, 0);
  assert.equal(course.folders[0].sections[0].items[0].details.url, 'https://x.instructure.com/f/11');
});

test('everything: a module lock still holds when the file listing has the file', async () => {
  const course = await scanCourse(fakeCanvas(base()), 7, { everything: true });
  const closed = course.folders[0].sections[0].items.find((i) => i.title === 'Closed');
  assert.equal(closed.locked, 'Locked until Friday');
  assert.equal(closed.details, undefined);
});

test('everything: grades and teacher comments, escaped; nothing for an ungraded one', async () => {
  const course = await scanCourse(fakeCanvas(base()), 7, { everything: true });
  const subs = folder(course, 'submissions');
  assert.deepEqual(subs.sections.map((s) => s.title), ['Essay']);
  const { html } = subs.sections[0].items[0];
  assert.match(html, /Grade: HD \(90 out of 100\)/);
  assert.match(html, /Dr &lt;A&gt;/);
  assert.match(html, /Good<br>work/);
});

// A course with a quiz, a rubric and an earlier attempt, on top of base().
const marked = () => {
  const routes = base();
  routes[`${C}/modules?include[]=items&include[]=content_details&per_page=100`][0].items.push({ type: 'Quiz', title: 'Quiz 1', content_id: 60, url: 'https://x.test/quiz', content_details: {} });
  routes['https://x.test/quiz'] = { id: 60, description: '<p>Ten questions</p>', points_possible: 10 };
  routes[`${C}/quizzes/60/submissions`] = { quiz_submissions: [{ kept_score: 8, score: 6, attempt: 2 }] };
  routes[`${C}/quizzes?per_page=100`] = [{ id: 60, title: 'Quiz 1' }, { id: 61, title: 'Practice', description: '<p>Try this</p>' }];
  routes[`${C}/quizzes/61/submissions`] = () => { throw status(403); };
  routes[`${C}/assignments?per_page=100`].push({ id: 9, name: 'Quiz 1', quiz_id: 60, description: '<p>dup</p>' });
  const subs = `${C}/students/submissions?student_ids[]=self&include[]=assignment&include[]=submission_comments&include[]=rubric_assessment&include[]=submission_history&per_page=100`;
  Object.assign(routes[subs][0], {
    attempt: 2,
    assignment: { name: 'Essay', points_possible: 100, rubric: [{ id: 'c1', description: 'Argument', points: 50, ratings: [{ id: 'r1', description: 'Strong' }] }, { id: 'c2', description: 'Style', points: 50 }] },
    rubric_assessment: { c1: { points: 45, rating_id: 'r1', comments: 'Clear <thesis>' } },
    submission_history: [{ attempt: 2 }, { attempt: 1, submission_type: 'online_upload', attachments: [{ id: 80, display_name: 'draft.pdf', size: 3, url: 'https://x.instructure.com/f/80' }] }],
  });
  return routes;
};

test('everything: rubric marks, escaped, with each criterion out of its points', async () => {
  const course = await scanCourse(fakeCanvas(marked()), 7, { everything: true });
  const { html } = folder(course, 'submissions').sections[0].items.find((i) => i.title === 'Grade and feedback');
  assert.match(html, /<h3>Rubric<\/h3>/);
  assert.match(html, /<td>Argument<\/td><td>45 \/ 50<\/td><td>Strong<\/td><td>Clear &lt;thesis&gt;<\/td>/);
  assert.match(html, /<td>Style<\/td><td><\/td><td><\/td><td><\/td>/); // not marked: left blank
});

test('everything: an earlier attempt is kept beside the last, named for its attempt', async () => {
  const course = await scanCourse(fakeCanvas(marked()), 7, { everything: true });
  const essay = folder(course, 'submissions').sections[0].items;
  const draft = essay.find((i) => i.id === 80);
  assert.equal(draft.details.name, 'Attempt 1 - draft.pdf');
  assert.equal(draft.details.url, 'https://x.instructure.com/f/80');
});

test('everything: a grades page with the course total and each graded assignment', async () => {
  const course = await scanCourse(fakeCanvas(base()), 7, { everything: true, total: { final_grade: 'DI', final_score: 73.9 } });
  const [page] = folder(course, 'grades').sections[0].items;
  assert.match(page.html, /Course total: DI \(73\.9%\)/);
  assert.match(page.html, /<td>Essay<\/td><td>HD<\/td><td>90 \/ 100<\/td>/);
  assert.doesNotMatch(page.html, /Not done/);
});

test('everything: quizzes, in their module with the score kept, the rest in Other quizzes, never twice', async () => {
  const course = await scanCourse(fakeCanvas(marked()), 7, { everything: true });
  const quiz = course.folders[0].sections[0].items.find((i) => i.title === 'Quiz 1');
  assert.match(quiz.html, /Ten questions.*Your score: 8 out of 10 \(2 attempts\)/s);
  assert.deepEqual(titles(folder(course, 'other-quizzes')), ['Practice']);
  assert.match(folder(course, 'other-quizzes').sections[0].items[0].html, /Try this/); // no score to show: none given
  assert.ok(!titles(folder(course, 'other-assignments')).includes('Quiz 1'));
});

test('everything: locked past its close date but its text still given: kept; locked with nothing given: reported', async () => {
  const routes = base();
  const lock = (when) => ({ locked_for_user: true, lock_explanation: `This assignment was locked ${when}.` });
  routes[`${C}/assignments?per_page=100`].push({ id: 20, name: 'Old brief', description: '<p>Build a bridge</p>', ...lock('Nov 23, 2023') }, { id: 21, name: 'Hidden', description: '', ...lock('Jan 4, 2024') });
  routes[`${C}/modules?include[]=items&include[]=content_details&per_page=100`][0].items.push(
    { type: 'Assignment', title: 'Week brief', content_id: 22, url: 'https://x.test/a22', content_details: lock('Mar 1, 2024') },
    { type: 'Assignment', title: 'Gone', content_id: 23, url: 'https://x.test/a23', content_details: lock('Mar 2, 2024') },
  );
  routes['https://x.test/a22'] = { description: '<p>Read chapter 2</p>' };
  routes['https://x.test/a23'] = { description: null };
  const course = await scanCourse(fakeCanvas(routes), 7, { everything: true });
  const other = folder(course, 'other-assignments').sections[0].items;
  assert.match(other.find((i) => i.title === 'Old brief').html, /Build a bridge/);
  assert.equal(other.find((i) => i.title === 'Hidden').locked, 'This assignment was locked Jan 4, 2024.');
  const week = course.folders[0].sections[0].items;
  assert.match(week.find((i) => i.title === 'Week brief').html, /Read chapter 2/);
  assert.equal(week.find((i) => i.title === 'Gone').locked, 'This assignment was locked Mar 2, 2024.');

  const canvas = fakeCanvas(routes); // a single-course scan does not ask for what is locked
  await scanCourse(canvas, 7);
  assert.ok(!canvas.asked.includes('https://x.test/a22'));
});

test('grades: a course total with only a percentage', () => {
  assert.match(gradesHtml({ final_score: 90 }, []), /^<p>Course total: 90%<\/p>$/);
  assert.equal(gradesHtml({}, []), '');
});

// The login ending midway, at each kind of read: the scan stops (to continue
// later) instead of keeping "Not available" where the content should be.
const loggedOut = () => Object.assign(new Error('Your Canvas login ended'), { loggedOut: true, status: 401 });
for (const [what, key] of [
  ['a module page', 'https://x.test/intro'],
  ['a listing closed to students looks like (401)', `${C}/assignments?per_page=100`],
  ['replies', `${C}/discussion_topics/40/view?include_new_entries=1`],
]) {
  test(`login ended reading ${what}: the scan stops instead of keeping a gap`, async () => {
    await assert.rejects(scanCourse(fakeCanvas({ ...base(), [key]: () => { throw loggedOut(); } }), 7, { everything: true, replies: true }), (e) => e.loggedOut);
  });
}

test('login ended reading a message: the inbox is not kept with a gap', async () => {
  await assert.rejects(readMessages(fakeCanvas({ ...inbox(), '/api/v1/conversations/2?auto_mark_as_read=false': () => { throw loggedOut(); } })), (e) => e.loggedOut);
});

test('annotations: a viewer that will not open is checked against the login before being reported', async () => {
  const docs = { annotations: async () => { throw new Error('Canvas did not open its document viewer'); } };
  const routes = { ...withSubmittedFiles(), '/api/v1/users/self': () => { throw loggedOut(); } };
  await assert.rejects(scanCourse(fakeCanvas(routes), 7, { everything: true, docs }), (e) => e.loggedOut);
});

test('a default scan reads no quiz, rubric or grades', async () => {
  const canvas = fakeCanvas(marked());
  const course = await scanCourse(canvas, 7);
  assert.ok(!canvas.asked.some((u) => /quiz|enrollments/.test(u)));
  assert.equal(folder(course, 'grades'), undefined);
});

test('replies come only when asked for', async () => {
  const talk = (course) => course.folders[0].sections[0].items.find((i) => i.title === 'Talk').html;
  assert.doesNotMatch(talk(await scanCourse(fakeCanvas(base()), 7, { everything: true })), /Reply!/);
  const withReplies = await scanCourse(fakeCanvas(base()), 7, { everything: true, replies: true });
  assert.match(talk(withReplies), /Discuss.*Ann.*Reply!/s);
  assert.match(folder(withReplies, 'other-discussions').sections[0].items[0].html, /only after you post/);
});

test('replies: an anonymous discussion (404 from /view) is read through GraphQL, every page, in thread order', async () => {
  const node = (id, parentId, createdAt, who, message) => ({ _id: id, parentId, createdAt, message, deleted: false, author: who.startsWith('Anon') ? null : { shortName: who }, anonymousAuthor: who.startsWith('Anon') ? { shortName: who } : null });
  const routes = base();
  routes[`${C}/discussion_topics/40/view?include_new_entries=1`] = () => { throw status(404); };
  routes['graphql 40 '] = { legacyNode: { discussionEntriesConnection: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node('2', '1', '2026-01-02', 'Me', '<p>answer</p>')] } } };
  routes['graphql 40 c1'] = { legacyNode: { discussionEntriesConnection: { pageInfo: { hasNextPage: false }, nodes: [node('1', null, '2026-01-01', 'Anonymous 7f', '<p>question</p>')] } } };
  const course = await scanCourse(fakeCanvas(routes), 7, { everything: true, replies: true });
  const html = course.folders[0].sections[0].items.find((i) => i.title === 'Talk').html;
  assert.match(html, /Anonymous 7f \(2026-01-01\)<\/h4><p>question<\/p>.*Me, replying to Anonymous 7f \(2026-01-02\)<\/h4><p>answer/s);
});

test('replies: a GraphQL failure is noted on the page; Canvas slowing down is not', async () => {
  const routes = base();
  routes[`${C}/discussion_topics/40/view?include_new_entries=1`] = () => { throw status(404); };
  const course = await scanCourse(fakeCanvas(routes), 7, { everything: true, replies: true });
  assert.match(course.folders[0].sections[0].items.find((i) => i.title === 'Talk').html, /Replies not available\./);
  routes['graphql 40 '] = () => { throw throttled(); };
  await assert.rejects(scanCourse(fakeCanvas(routes), 7, { everything: true, replies: true }), (e) => e.throttled);
});

test('a default scan asks Canvas for nothing new', async () => {
  const routes = base();
  routes[`${C}/students/submissions?student_ids[]=self&include[]=assignment&per_page=100`] = [];
  const canvas = fakeCanvas(routes);
  const course = await scanCourse(canvas, 7);
  assert.equal(canvas.asked.some((u) => /\/files\?|\/assignments\?|\/pages\?|\/view/.test(u)), false);
  assert.equal(folder(course, 'other-files'), undefined);
});

for (const [what, key] of [
  ['announcements', `${C}/discussion_topics?only_announcements=true&per_page=100`],
  ['submissions', `${C}/students/submissions?student_ids[]=self&include[]=assignment&include[]=submission_comments&include[]=rubric_assessment&include[]=submission_history&per_page=100`],
  ['a module page', 'https://x.test/intro'],
  ['a loose page', `${C}/pages/extra%20one`],
]) {
  test(`throttled ${what}: the scan fails instead of passing without it`, async () => {
    await assert.rejects(scanCourse(fakeCanvas({ ...base(), [key]: () => { throw throttled(); } }), 7, { everything: true }), (e) => e.throttled);
  });
}

// ── what people wrote ──
test('thread: reply order, who answers whom, deleted replies gone, new entries kept', () => {
  const html = threadHtml({
    participants: [{ id: 1, display_name: 'Ann' }, { id: 2, display_name: 'B<o>b' }],
    view: [{ id: 1, user_id: 1, created_at: '2026-01-01', message: 'first-entry', replies: [{ id: 2, deleted: true, replies: [{ id: 3, user_id: 2, created_at: '2026-01-03', message: 'three' }] }] }],
    new_entries: [{ id: 4, user_id: 2, parent_id: 1, created_at: '2026-01-04', message: 'four' }, { id: 1, user_id: 1, message: 'first-entry' }],
  });
  assert.equal(html.match(/first-entry/g).length, 1);
  assert.ok(html.indexOf('three') < html.indexOf('four'));
  assert.match(html, /B&lt;o&gt;b, replying to Ann \(2026-01-04\)/);
});

test('thread: a very deep thread does not overflow', () => {
  let entry = { id: 0, message: 'x' };
  for (let i = 1; i < 50_000; i++) entry = { id: i, message: 'x', replies: [entry] };
  assert.ok(threadHtml({ view: [entry] }).length > 0);
});

test('feedback: nothing to say is nothing', () => assert.equal(feedbackHtml({}), ''));

const inbox = () => ({
  '/api/v1/conversations?per_page=100': [{ id: 1, context_code: 'course_7', subject: 'Hi', last_message_at: '2026-02-01T00:00:00Z' }, { id: 2, context_code: 'group_3' }],
  '/api/v1/conversations?per_page=100&scope=archived': [{ id: 3, context_code: 'course_7', subject: 'Old' }],
  '/api/v1/conversations?per_page=100&scope=sent': [{ id: 1, context_code: 'course_7', subject: 'Hi' }],
  '/api/v1/conversations/1?auto_mark_as_read=false': { subject: 'Hi', last_message_at: '2026-02-01T00:00:00Z', participants: [{ id: 1, name: 'Ann' }, { id: 2, name: 'Me' }], messages: [
    { author_id: 2, created_at: '2026-02-01T00:00:00Z', body: 'second <b>', attachments: [{ id: 70, display_name: 'a.pdf', size: 5, url: 'https://x.instructure.com/f/70' }] },
    { author_id: 1, created_at: '2026-01-31T00:00:00Z', body: 'first' },
  ] },
  '/api/v1/conversations/2?auto_mark_as_read=false': { subject: 'Group', participants: [], messages: [] },
  '/api/v1/conversations/3?auto_mark_as_read=false': () => { throw status(404); },
});

test('messages: every open leaves the inbox unread; inbox, archived and sent, once each', async () => {
  const canvas = fakeCanvas(inbox());
  const read = await readMessages(canvas);
  assert.equal(read.length, 3);
  const opened = canvas.asked.filter((u) => /conversations\/\d/.test(u));
  assert.equal(opened.length, 3);
  assert.ok(opened.every((u) => u.includes('auto_mark_as_read=false')));
});

test('messages: read in order, escaped, attachments beside the text, a lost one reported', async () => {
  const read = await readMessages(fakeCanvas(inbox()));
  const hi = read.find((r) => r.section.items[0].title === '2026-02-01 Hi').section;
  assert.equal(hi.title, '2026-02-01 Hi');
  assert.ok(hi.items[0].html.indexOf('first') < hi.items[0].html.indexOf('second'));
  assert.match(hi.items[0].html, /second &lt;b&gt;/);
  assert.equal(hi.items[1].details.url, 'https://x.instructure.com/f/70');
  assert.equal(read.find((r) => r.section.items[0].title === 'Old').section.items[0].locked, 'Not available');
});

test('messages: throttling is not mistaken for a lost conversation', async () => {
  await assert.rejects(readMessages(fakeCanvas({ ...inbox(), '/api/v1/conversations/2?auto_mark_as_read=false': () => { throw throttled(); } })), (e) => e.throttled);
});

// ── the plan ──
test('courses: current first, no repeats, none without a name', async () => {
  const list = await listCourses(fakeCanvas({
    '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100': [{ id: 1, name: 'A', course_code: 'a', term: { name: 'S2' } }, { id: 9, access_restricted_by_date: true }],
    '/api/v1/courses?enrollment_state=completed&include[]=term&per_page=100': [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
  }));
  assert.deepEqual(list.map((c) => [c.id, c.past, c.term]), [[1, false, 'S2'], [2, true, '']]);
});

const noFiles = { meta: async () => ({ name: 'looked.pdf', size: 1, url: 'https://x.instructure.com/f', locked: '' }) };
const one = (id, name) => ({ id, name });
const planOf = (canvas, courses, options) => planExport(canvas, noFiles, courses, options);

test('plan: each course in its own folder; same names kept apart', async () => {
  const routes = { ...base(), ...Object.fromEntries(Object.entries(base()).map(([k, v]) => [k.replaceAll('/courses/7', '/courses/8'), v])) };
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra'), one(8, 'algebra')]);
  const tops = new Set(plan.entries.map((e) => e.path.split('/')[0]));
  assert.deepEqual([...tops].sort(), ['Algebra (7)', 'algebra (8)']);
});

test('plan: pages as Markdown, links gathered, locked items reported', async () => {
  const routes = base();
  routes[`${C}/modules?include[]=items&include[]=content_details&per_page=100`][0].items.push({ type: 'ExternalUrl', title: 'Rec', external_url: 'https://v.test/1' });
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra')]);
  const intro = plan.entries.find((e) => e.path === 'Algebra/01 Week 1/Intro.md');
  assert.match(intro.md, /^# Intro\n\nHi/);
  assert.match(plan.entries.find((e) => e.path === 'Algebra/Links.md').md, /\[Rec\]\(https:\/\/v\.test\/1\)/);
  assert.deepEqual(plan.notSaved.find((n) => n.title.endsWith('Closed')).reason, 'Locked until Friday');
});

test('plan: messages go with their course; the rest in Other messages; two of one name both kept', async () => {
  const routes = { ...base(), ...inbox() };
  routes['/api/v1/conversations/3?auto_mark_as_read=false'] = { subject: 'Hi', last_message_at: '2026-02-01T00:00:00Z', messages: [] };
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra')], { messages: true });
  const paths = plan.entries.map((e) => e.path);
  assert.ok(paths.some((p) => /^Algebra\/\d+ Messages\/2026-02-01 Hi\/2026-02-01 Hi\.md$/.test(p)));
  assert.ok(paths.some((p) => /^Algebra\/\d+ Messages\/2026-02-01 Hi\.md$/.test(p)));
  assert.ok(paths.some((p) => /^Other messages\/01 Messages\/Group\.md$/.test(p)));
  assert.equal(paths.filter((p) => !p).length, 0);
});

test('plan: messages of a course not picked wait for that course, not Other messages', async () => {
  const routes = { ...base(), ...inbox() };
  routes['/api/v1/conversations?per_page=100'] = [...routes['/api/v1/conversations?per_page=100'], { id: 4, context_code: 'course_8', subject: 'Other course' }, { id: 5, context_code: 'course_99', subject: 'Unlisted course' }];
  routes['/api/v1/conversations/4?auto_mark_as_read=false'] = { subject: 'Other course', messages: [] };
  routes['/api/v1/conversations/5?auto_mark_as_read=false'] = { subject: 'Unlisted course', messages: [] };
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra')], { messages: true, otherCourses: [one(8, 'Biology')] });
  const paths = plan.entries.map((e) => e.path);
  assert.ok(!paths.some((p) => p.includes('Other course')));
  assert.ok(paths.some((p) => /^Other messages\/01 Messages\/Unlisted course\.md$/.test(p))); // a course not in the list has no folder to wait for
  assert.ok(paths.some((p) => /^Other messages\/01 Messages\/Group\.md$/.test(p)));
});

test('plan: a size check that stopped carries on, reading nothing twice, ending with the same plan', async () => {
  const routes = { ...base(), ...inbox() };
  const kept = {};
  const keep = async (key, value) => { kept[key] = structuredClone(value); }; // as IndexedDB stores it
  const whole = await planOf(fakeCanvas(routes), [one(7, 'Algebra')], { messages: true, keep });
  assert.deepEqual(Object.keys(kept).sort(), ['course:7', 'groups', 'inbox']);

  const canvas = fakeCanvas(routes);
  const again = await planOf(canvas, [one(7, 'Algebra')], { messages: true, known: { inbox: kept.inbox, groups: kept.groups, courses: { 7: kept['course:7'] } } });
  assert.deepEqual(canvas.asked, []);
  assert.deepEqual(again, whole);
});

test('plan: a course is kept only once it is read whole', async () => {
  const controller = new AbortController();
  const kept = [];
  const canvas = fakeCanvas(base());
  const get = canvas.get;
  canvas.get = (url) => { if (url.includes('/pages/')) controller.abort(); return get(url); };
  await planOf(canvas, [one(7, 'Algebra')], { keep: async (key) => kept.push(key), signal: controller.signal });
  assert.deepEqual(kept.filter((k) => k.startsWith('course:')), []);
});

test('plan: each course\'s grades page has its total, from one listing of enrollments', async () => {
  const routes = base();
  routes['/api/v1/users/self/enrollments?type[]=StudentEnrollment&state[]=active&state[]=completed&per_page=100'] = [{ course_id: 7, grades: { final_grade: 'HD', final_score: 88 } }, { course_id: 8, grades: {} }];
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra')]);
  const grades = plan.entries.find((e) => /^Algebra\/\d+ Grades\/Grades\.md$/.test(e.path));
  assert.match(grades.md, /Course total: HD \(88%\)/);
});

// ── lecturers' notes (Canvadocs) ──
// A Canvadocs host: preview links open sessions; notes: { session id: count }.
function fakeDocs(notes, { readyAfter = 1, landing } = {}) {
  const asked = [];
  let polls = 0;
  const res = (url, body, ok = true) => ({ url, ok, json: async () => body });
  const docsHost = 'https://canvadocs-syd.instructure.com';
  return {
    asked,
    fetch: async (url, options = {}) => {
      const u = String(url);
      asked.push(`${options.method ?? 'GET'} ${u}`);
      const preview = /canvadoc_session\?id=(\w+)/.exec(u);
      if (preview) return res(landing ?? `${docsHost}/1/sessions/${preview[1]}/view`, {});
      const [, id, rest] = /\/1\/sessions\/(\w+)\/(.*)$/.exec(u);
      if (rest === 'annotations') return res(u, { data: Array.from({ length: notes[id] ?? 0 }, () => ({})) });
      if (rest === 'annotated.pdf') return res(u, {}, true);
      if (rest === 'annotated.pdf/is_ready') return res(u, { ready: ++polls >= readyAfter });
      throw new Error(`unexpected ${u}`);
    },
  };
}

test('canvadocs: counts a file\'s notes in the session its preview link opens', async () => {
  const host = fakeDocs({ s1: 3, s2: 0 });
  const docs = canvadocs('https://school.instructure.com', { fetch: host.fetch });
  assert.equal(await docs.annotations('/api/v1/canvadoc_session?id=s1'), 3);
  assert.equal(await docs.annotations('/api/v1/canvadoc_session?id=s2'), 0);
  assert.equal(host.asked[0], 'GET https://school.instructure.com/api/v1/canvadoc_session?id=s1');
});

test('canvadocs: asks for the annotated PDF and waits until it is ready', async () => {
  const host = fakeDocs({}, { readyAfter: 3 });
  const docs = canvadocs('https://school.instructure.com', { fetch: host.fetch, sleep: async () => {} });
  assert.equal(await docs.annotatedPdf('/api/v1/canvadoc_session?id=s1'), 'https://canvadocs-syd.instructure.com/1/sessions/s1/annotated.pdf');
  assert.ok(host.asked.includes('POST https://canvadocs-syd.instructure.com/1/sessions/s1/annotated.pdf'));
  assert.equal(host.asked.filter((a) => a.endsWith('is_ready')).length, 3);
});

test('canvadocs: a preview link that lands anywhere but a Canvadocs session is refused', async () => {
  for (const landing of ['https://school.instructure.com/login', 'https://evil.example/1/sessions/x/view']) {
    const docs = canvadocs('https://school.instructure.com', { fetch: fakeDocs({}, { landing }).fetch });
    await assert.rejects(docs.annotations('/api/v1/canvadoc_session?id=s1'), /document viewer/);
  }
});

const withSubmittedFiles = () => {
  const routes = marked();
  const subs = Object.keys(routes).find((k) => k.includes('/students/submissions'));
  routes[subs][0].assignment_id = 3;
  routes[subs][0].attachments = [
    { id: 90, display_name: 'report.docx', size: 50, url: 'https://x.instructure.com/f/90', preview_url: '/api/v1/canvadoc_session?id=s90' },
    { id: 91, display_name: 'code.zip', size: 9, url: 'https://x.instructure.com/f/91', preview_url: '/api/v1/canvadoc_session?id=s91' },
    { id: 92, display_name: 'plain.txt', size: 1, url: 'https://x.instructure.com/f/92' },
  ];
  return routes;
};

test('annotations: a submitted file the lecturer wrote notes on gets an annotated copy beside it, made when saved', async () => {
  const docs = canvadocs('https://x.instructure.com', { fetch: fakeDocs({ s90: 4 }).fetch });
  const course = await scanCourse(fakeCanvas(withSubmittedFiles()), 7, { everything: true, docs });
  const items = folder(course, 'submissions').sections[0].items;
  const copy = items.find((i) => i.title === 'Annotated - report.pdf');
  assert.deepEqual(copy.details.annotated, { course: 7, assignment: 3, attachment: 90 });
  assert.equal(copy.details.url, '');
  assert.ok(!items.some((i) => i.title === 'Annotated - code.pdf')); // no notes: no copy
  const plan = await planExport(fakeCanvas(withSubmittedFiles()), noFiles, [one(7, 'Algebra')], { docs });
  const entry = plan.entries.find((e) => e.path.endsWith('Annotated - report.pdf'));
  assert.deepEqual(Object.keys(entry).sort(), ['annotated', 'path', 'size', 'title']);
  assert.equal(planTotals({ entries: [entry] }).files, 1);
});

test('annotations: when Canvadocs will not answer, the report says so', async () => {
  const docs = { annotations: async () => { throw new Error('down'); } };
  const plan = await planExport(fakeCanvas(withSubmittedFiles()), noFiles, [one(7, 'Algebra')], { docs });
  assert.match(plan.notSaved.find((n) => /Annotated - report/.test(n.title)).reason, /lecturer's notes/);
});

// ── groups ──
const groupRoutes = (id) => ({
  [`/api/v1/groups/${id}/files?per_page=100`]: [
    { id: 300 + id, display_name: 'plan.pdf', size: 5, folder_id: 1, url: 'https://x.instructure.com/f/g1' },
    { id: 400 + id, display_name: 'draft.docx', size: 6, folder_id: 2, url: 'https://x.instructure.com/f/g2' },
  ],
  [`/api/v1/groups/${id}/folders?per_page=100`]: [{ id: 1, full_name: 'group files' }, { id: 2, full_name: 'group files/Submissions/Week 3' }],
  [`/api/v1/groups/${id}/pages?per_page=100`]: [{ url: 'notes', title: 'Meeting notes' }],
  [`/api/v1/groups/${id}/pages/notes`]: { body: '<p>Agenda</p>' },
  [`/api/v1/groups/${id}/discussion_topics?per_page=100`]: [{ id: 5, title: 'Who does what', message: '<p>Split it</p>' }],
  [`/api/v1/groups/${id}/discussion_topics/5/view?include_new_entries=1`]: { participants: [{ id: 1, display_name: 'Bo' }], view: [{ id: 1, user_id: 1, message: '<p>I take the intro</p>' }] },
});

test('groups: a group\'s files by folder, its pages and discussions (replies when asked)', async () => {
  const group = await scanGroup(fakeCanvas(groupRoutes(3)), { id: 3, name: ' Team 6 ' }, { replies: true });
  assert.equal(group.title, 'Group - Team 6');
  assert.deepEqual(group.sections.map((s) => [s.title, s.items.map((i) => i.title)]), [
    [null, ['plan.pdf']],
    ['Submissions/Week 3', ['draft.docx']],
    ['Pages', ['Meeting notes']],
    ['Discussions', ['Who does what']],
  ]);
  assert.match(group.sections[3].items[0].html, /Split it.*Bo.*I take the intro/s);
});

test('plan: each group goes in its course\'s folder; a group of no listed course in Other groups; one of a course not picked waits', async () => {
  const routes = { ...base(), ...groupRoutes(3), ...groupRoutes(4), ...groupRoutes(5) };
  routes['/api/v1/users/self/groups?per_page=100'] = [{ id: 3, name: 'Team 6', course_id: 7 }, { id: 4, name: 'Club', course_id: null }, { id: 5, name: 'Lab 2', course_id: 8 }];
  const plan = await planOf(fakeCanvas(routes), [one(7, 'Algebra')], { otherCourses: [one(8, 'Biology')] });
  const paths = plan.entries.map((e) => e.path);
  assert.ok(paths.some((p) => /^Algebra\/\d+ Group - Team 6\/plan\.pdf$/.test(p)));
  assert.ok(paths.some((p) => /^Algebra\/\d+ Group - Team 6\/Submissions - Week 3\/draft\.docx$/.test(p)));
  assert.ok(paths.some((p) => /^Other groups\/01 Group - Club\/plan\.pdf$/.test(p)));
  assert.ok(!paths.some((p) => p.includes('Lab 2')));
});

test('plan: no messages are read unless asked for', async () => {
  const canvas = fakeCanvas({ ...base(), ...inbox() });
  await planOf(canvas, [one(7, 'Algebra')]);
  assert.equal(canvas.asked.some((u) => u.includes('conversations')), false);
});

test('plan: a closed course is reported and the rest carry on', async () => {
  const routes = { ...base(), '/api/v1/courses/6?include[]=syllabus_body': () => { throw status(403); }, '/api/v1/users/self': { id: 1 } };
  const plan = await planOf(fakeCanvas(routes), [one(6, 'Closed one'), one(7, 'Algebra')]);
  assert.deepEqual(plan.notSaved[0], { title: 'Closed one', reason: 'This course is closed to you' });
  assert.ok(plan.entries.length > 0);
});

test('plan: a lost login stops the run instead of failing every course', async () => {
  const routes = { '/api/v1/users/self': () => { throw status(401); } };
  await assert.rejects(planOf(fakeCanvas(routes), [one(6, 'A'), one(7, 'B')]), (e) => e.status === 401);
});

test('plan: throttling stops the run', async () => {
  await assert.rejects(planOf(fakeCanvas({ ...base(), [`${C}?include[]=syllabus_body`]: () => { throw throttled(); } }), [one(7, 'A')]), (e) => e.throttled);
});

test('plan: a long name is cut, keeping its extension', async () => {
  const routes = base();
  routes[`${C}/files?per_page=100`].push({ id: 14, display_name: `${'x'.repeat(300)}.pdf`, size: 1, url: 'https://x.instructure.com/f/14' });
  const plan = await planOf(fakeCanvas(routes), [one(7, 'A')]);
  const long = plan.entries.find((e) => e.path.endsWith('.pdf') && e.path.includes('xxx'));
  assert.ok(long.path.split('/').at(-1).length <= 80);
});

// ── the run ──
const md = (path) => ({ path, md: 'x', size: 1, title: path });
const file = (path, size = 1) => ({ path, url: 'https://x/f', size, title: path });

test('run: at most 3 saves at once, the report last', async () => {
  let running = 0;
  let peak = 0;
  const order = [];
  const save = async (e) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    order.push(e.path);
  };
  await runExport({ entries: Array.from({ length: 30 }, (_, i) => file(`f${i}`)), notSaved: [] }, { save, done: new Set() });
  assert.equal(peak, 3);
  assert.equal(order.length, 31);
  assert.equal(order.at(-1), 'Export report.md');
});

test('run: a continued export skips what is saved', async () => {
  const saved = [];
  await runExport({ entries: [file('a'), file('b')], notSaved: [] }, { save: async (e) => saved.push(e.path), done: new Set(['a']) });
  assert.deepEqual(saved, ['b', 'Export report.md']);
});

test('run: a full disk ends it at once, with no report and nothing marked saved', async () => {
  const saved = [];
  const done = new Set();
  const save = async (e) => {
    saved.push(e.path);
    throw Object.assign(new Error('Your disk is full'), { fatal: true });
  };
  const result = await runExport({ entries: Array.from({ length: 50 }, (_, i) => file(`f${i}`)), notSaved: [] }, { save, done });
  assert.equal(result.stopped, true);
  assert.equal(result.fatal.message, 'Your disk is full');
  assert.equal(done.size, 0);
  assert.ok(saved.length <= 3);
  assert.ok(!saved.includes('Export report.md'));
});

test('run: one failed file is reported and the rest carry on', async () => {
  const result = await runExport({ entries: [file('a'), file('b')], notSaved: [] }, { save: async (e) => { if (e.path === 'a') throw new Error('SERVER_FORBIDDEN'); }, done: new Set() });
  assert.deepEqual(result.failed, [{ title: 'a', reason: 'SERVER_FORBIDDEN' }]);
  assert.equal(result.stopped, false);
});

test('run: Stop starts nothing new and leaves it continuable', async () => {
  const controller = new AbortController();
  const saved = [];
  const save = async (e) => {
    saved.push(e.path);
    controller.abort();
  };
  const result = await runExport({ entries: Array.from({ length: 20 }, (_, i) => file(`f${i}`)), notSaved: [] }, { save, done: new Set(), signal: controller.signal });
  assert.equal(result.stopped, true);
  assert.ok(saved.length <= 3);
  assert.ok(!saved.includes('Export report.md'));
});

test('run: the report says so when everything was saved', async () => {
  const report = [];
  await runExport({ entries: [file('a')], notSaved: [] }, { save: async (e) => e.md && report.push(e.md), done: new Set() });
  assert.match(report[0], /Everything was saved/);
});

test('run: what failed is tried once more at the end, and only what fails twice is reported', async () => {
  const tries = new Map();
  const save = async (e) => {
    tries.set(e.path, (tries.get(e.path) ?? 0) + 1);
    if (e.path === 'flaky' && tries.get('flaky') === 1) throw new Error('NETWORK_FAILED');
    if (e.path === 'broken') throw new Error('SERVER_FORBIDDEN');
  };
  const done = new Set();
  const result = await runExport({ entries: [file('a'), file('flaky'), file('broken'), file('b')], notSaved: [] }, { save, done });
  assert.deepEqual(Object.fromEntries(tries), { a: 1, flaky: 2, broken: 2, b: 1, 'Export report.md': 1 });
  assert.ok(done.has('flaky'));
  assert.deepEqual(result.failed, [{ title: 'broken', reason: 'SERVER_FORBIDDEN' }]);
});

test('plan: names of 4-byte letters are cut whole, short enough for the disk', async () => {
  const fancy = '𝐍𝐞𝐨 𝐋𝐞𝐚𝐠𝐮𝐞 𝐒𝐞𝐚𝐬𝐨𝐧 𝟐 𝐔𝐍𝐋𝐄𝐀𝐒𝐇 𝐘𝐎𝐔𝐑 𝐏𝐎𝐓𝐄𝐍𝐓𝐈𝐀𝐋 𝐀𝐍𝐃 𝐂𝐎𝐌𝐏𝐄𝐓𝐄 𝐖𝐈𝐓𝐇 𝐓𝐇𝐄 𝐁𝐄𝐒𝐓 𝐓𝐄𝐀𝐌𝐒 𝐈𝐍 𝐓𝐇𝐄 𝐒𝐂𝐇𝐎𝐎𝐋';
  const routes = base();
  routes[`${C}/discussion_topics?only_announcements=true&per_page=100`] = [{ title: fancy, posted_at: '2026-04-03T00:00:00Z', message: '<p>News</p>' }];
  const plan = await planOf(fakeCanvas(routes), [one(7, fancy)]);
  for (const e of plan.entries) {
    for (const name of e.path.split('/')) {
      assert.ok(new TextEncoder().encode(name).length <= 255, name);
      assert.doesNotMatch(name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `half a letter in ${name}`);
    }
  }
  assert.ok(plan.entries.some((e) => e.path.includes('𝐍𝐞𝐨')));
});

test('run: files over the limit wait for a yes, and are listed in the report', async () => {
  const entries = [file('huge.mp4', BIG_FILE + 1), file('a'), md('p.md')];
  assert.deepEqual(planTotals({ entries }), { files: 2, pages: 1, bytes: BIG_FILE + 3, bigFiles: 1, bigBytes: BIG_FILE + 1 });
  const seen = [];
  const report = [];
  const save = async (e) => { seen.push(e.path); if (e.md) report.push(e.md); };
  await runExport({ entries, notSaved: [{ title: 'L', reason: 'Locked' }] }, { save, done: new Set() });
  assert.ok(!seen.includes('huge.mp4'));
  assert.match(report.at(-1), /huge\.mp4/);
  assert.match(report.at(-1), /L: Locked/);
  seen.length = 0;
  await runExport({ entries, notSaved: [] }, { save, done: new Set(), big: true });
  assert.ok(seen.includes('huge.mp4'));
});

// ── chrome.downloads ──
function fakeDownloads(behave) {
  const listeners = new Set();
  let id = 0;
  const api = {
    started: [],
    cancelled: [],
    erased: [],
    states: new Map(),
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    emit: (d) => [...listeners].forEach((f) => f(d)),
    listeners,
    async download(o) {
      const n = ++id;
      api.started.push(o);
      await behave?.(n, api, o);
      return n;
    },
    search: async ({ id: n }) => [api.states.get(n) ?? { state: 'in_progress' }],
    cancel: async (n) => {
      api.cancelled.push(n);
      api.emit({ id: n, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
    },
    erase: async ({ id: n }) => api.erased.push(n),
  };
  return api;
}
const later = (f) => setTimeout(f, 1);
const finish = (n, api) => later(() => api.emit({ id: n, state: { current: 'complete' } }));
const fail = (n, api, code) => later(() => api.emit({ id: n, state: { current: 'interrupted' }, error: { current: code } }));

test('saver: resolves when the file is really finished, in the export folder, without duplicates', async () => {
  const api = fakeDownloads(finish);
  const saver = chromeSaver(api, 'Canvas export X', new AbortController().signal);
  await saver.save(file('A/b.pdf'));
  assert.deepEqual(api.started[0], { url: 'https://x/f', filename: 'Canvas export X/A/b.pdf', conflictAction: 'overwrite', saveAs: false });
  assert.deepEqual(api.erased, [1]);
  saver.close();
  assert.equal(api.listeners.size, 0);
});

test('saver: a download that finished before its id was known still counts', async () => {
  const api = fakeDownloads((n, a) => a.states.set(n, { state: 'complete' }));
  const saver = chromeSaver(api, 'R', new AbortController().signal);
  await saver.save(file('a'));
  saver.close();
});

const quick = (more) => ({ sleep: async () => {}, online: () => true, ...more });

test('saver: a dropped connection is waited out and tried again', async () => {
  const api = fakeDownloads((n, a) => (n === 1 ? fail(n, a, 'NETWORK_FAILED') : finish(n, a)));
  const waits = [];
  const saver = chromeSaver(api, 'R', new AbortController().signal, quick({ sleep: async (ms) => waits.push(ms) }));
  await saver.save(file('a'));
  assert.equal(api.started.length, 2);
  assert.deepEqual(waits, [5000]);
  saver.close();
});

test('saver: one file the network keeps failing is given up after 5 tries; the run goes on', async () => {
  const api = fakeDownloads((n, a) => fail(n, a, 'NETWORK_FAILED'));
  const saver = chromeSaver(api, 'R', new AbortController().signal, quick());
  await assert.rejects(saver.save(file('a')), (e) => /NETWORK_FAILED/.test(e.message) && !e.fatal);
  assert.equal(api.started.length, 5);
  saver.close();
});

test('saver: with the computer offline, the run stops instead of failing every file left', async () => {
  const api = fakeDownloads((n, a) => fail(n, a, 'NETWORK_DISCONNECTED'));
  const saver = chromeSaver(api, 'R', new AbortController().signal, quick({ online: () => false }));
  await assert.rejects(saver.save(file('a')), (e) => e.fatal === true && /internet/.test(e.message));
  saver.close();
});

test('saver: Canvas\'s login page saved in place of a file is deleted, and the run stops', async () => {
  const api = fakeDownloads((n, a) => { a.states.set(n, { state: 'complete', mime: 'text/html' }); finish(n, a); });
  api.removed = [];
  api.removeFile = async (n) => api.removed.push(n);
  const saver = chromeSaver(api, 'R', new AbortController().signal, quick({ loggedIn: async () => false }));
  await assert.rejects(saver.save(file('notes.pdf')), (e) => e.fatal === true && /login ended/.test(e.message));
  assert.deepEqual(api.removed, [1]);
  saver.close();
});

test('saver: a web page that really is the file is kept', async () => {
  const api = fakeDownloads((n, a) => { a.states.set(n, { state: 'complete', mime: 'text/html' }); finish(n, a); });
  api.removeFile = async () => assert.fail('removed');
  let asked = 0;
  const saver = chromeSaver(api, 'R', new AbortController().signal, quick({ loggedIn: async () => (asked++, true) }));
  await saver.save(file('lab')); // no .html: Canvas is asked
  await saver.save(file('lab.html')); // a page by name: nothing to ask
  assert.equal(asked, 1);
  saver.close();
});

test('saver: before continuing, what Chrome finished counts as saved and what it left half-done is cancelled', async () => {
  const api = fakeDownloads();
  api.removed = [];
  api.removeFile = async (n) => api.removed.push(n);
  const root = 'Canvas export 2026-11-10 ab1';
  const rows = [
    { id: 7, state: 'complete', filename: `/Users/s/Downloads/${root}/Algebra/01 Week 1/notes.pdf`, mime: 'application/pdf' },
    { id: 8, state: 'interrupted', filename: `/Users/s/Downloads/${root}/Algebra/01 Week 1/big.zip.crdownload` },
    { id: 9, state: 'in_progress', filename: `/Users/s/Downloads/${root}/Algebra/slides.pdf.crdownload` },
    { id: 10, state: 'complete', filename: `C:\\Users\\s\\Downloads\\${root}\\Biology\\a.pdf`, mime: 'application/pdf' },
    { id: 11, state: 'complete', filename: `/Users/s/Downloads/${root}/Algebra/quiz.pdf`, mime: 'text/html' },
  ];
  api.search = async (q) => rows.filter((r) => new RegExp(q.filenameRegex).test(r.filename));
  const saver = chromeSaver(api, root, new AbortController().signal, quick());
  assert.deepEqual(await saver.tidy(), ['Algebra/01 Week 1/notes.pdf', 'Biology/a.pdf']); // not quiz.pdf: a web page, saved again
  assert.deepEqual(api.cancelled, [8, 9]);
  assert.deepEqual(api.removed, []); // nothing deleted: saving it again replaces it
  assert.deepEqual(api.erased.sort(), [10, 11, 7, 8, 9].sort());
  saver.close();
});

test('saver: a full disk is fatal and is not retried', async () => {
  const api = fakeDownloads((n, a) => fail(n, a, 'FILE_NO_SPACE'));
  const saver = chromeSaver(api, 'R', new AbortController().signal);
  await assert.rejects(saver.save(file('a')), (e) => e.fatal === true);
  assert.equal(api.started.length, 1);
  saver.close();
});

test('saver: a forbidden file fails without retry or ending the run', async () => {
  const api = fakeDownloads((n, a) => fail(n, a, 'SERVER_FORBIDDEN'));
  const saver = chromeSaver(api, 'R', new AbortController().signal);
  await assert.rejects(saver.save(file('a')), (e) => e.message === 'SERVER_FORBIDDEN' && !e.fatal);
  assert.equal(api.started.length, 1);
  saver.close();
});

test('saver: Stop cancels what is downloading', async () => {
  const controller = new AbortController();
  const api = fakeDownloads();
  const saver = chromeSaver(api, 'R', controller.signal);
  const saving = saver.save(file('a'));
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(saving, /USER_CANCELED/);
  assert.deepEqual(api.cancelled, [1]);
  saver.close();
});

test('saver: a page is written from a Blob whose address is let go', async () => {
  const revoked = [];
  const real = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => revoked.push(u);
  const api = fakeDownloads(finish);
  const saver = chromeSaver(api, 'R', new AbortController().signal);
  await saver.save(md('a.md'));
  URL.revokeObjectURL = real;
  assert.match(api.started[0].url, /^blob:/);
  assert.deepEqual(revoked, [api.started[0].url]);
  saver.close();
});
