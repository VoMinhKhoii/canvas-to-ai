import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCanvasTab, siteOrigin, looksLikeCanvas, allowSite } from '../src/panel/sites.js';
import { isCanvasFileUrl, fileDetails } from '../src/canvas/file.js';

// Chrome with these granted origins and these tabs ({ id, url, active, lastAccessed }).
function fakeChrome(origins, tabs, { grant = true } = {}) {
  const asked = [];
  const removed = [];
  const glob = (p) => new RegExp(`^${p.replace(/[.?]/g, '\\$&').replace(/\*/g, '.*')}$`);
  globalThis.chrome = {
    asked,
    removed,
    permissions: {
      getAll: async () => ({ origins: [...origins] }),
      request: async ({ origins: o }) => (asked.push(...o), grant && origins.push(...o), grant),
      remove: async ({ origins: o }) => (removed.push(...o), true),
    },
    tabs: {
      query: async ({ active, url }) => tabs.filter((t) => (active ? t.active : [url].flat().some((p) => glob(p).test(t.url)))),
    },
  };
  return globalThis.chrome;
}
const COURSE = /^\/courses\/(\d+)/;
const BUILT_IN = ['https://*.instructure.com/*', 'https://*.canvas-user-content.com/*', 'https://*.inscloudgate.net/*'];

test('sites: a course on a Canvas the student allowed is found like one on instructure.com', async () => {
  fakeChrome([...BUILT_IN, 'https://canvas.school.edu/*'], [
    { id: 1, url: 'https://www.youtube.com/', active: true },
    { id: 2, url: 'https://canvas.school.edu/courses/42/modules', lastAccessed: 5 },
    { id: 3, url: 'https://x.instructure.com/courses/7', lastAccessed: 2 },
  ]);
  assert.equal((await findCanvasTab(COURSE)).id, 2);
});

test('sites: the active tab wins, and a site never allowed is not Canvas', async () => {
  fakeChrome(BUILT_IN, [
    { id: 1, url: 'https://canvas.other.edu/courses/9', active: true },
    { id: 2, url: 'https://x.instructure.com/courses/7', lastAccessed: 1 },
  ]);
  assert.equal((await findCanvasTab(COURSE)).id, 2);
  fakeChrome(BUILT_IN, [{ id: 3, url: 'https://x.instructure.com/courses/7', active: true }, { id: 4, url: 'https://y.instructure.com/courses/8', lastAccessed: 9 }]);
  assert.equal((await findCanvasTab(COURSE)).id, 3);
});

test('sites: a tab on the course list is not a course: the course tab behind it is', async () => {
  fakeChrome(BUILT_IN, [{ id: 1, url: 'https://school.instructure.com/courses/', active: true }, { id: 2, url: 'https://school.instructure.com/courses/42', lastAccessed: 1 }]);
  assert.equal((await findCanvasTab(COURSE)).id, 2);
});

test('sites: file servers are not Canvas sites, and the course path must match', async () => {
  fakeChrome(BUILT_IN, [{ id: 1, url: 'https://x.canvas-user-content.com/courses/1', active: true }, { id: 2, url: 'https://x.instructure.com/calendar' }]);
  assert.equal(await findCanvasTab(COURSE), undefined);
  assert.equal((await findCanvasTab()).id, 2);
});

test('sites: an allowed site serves its own files; others still do not', async () => {
  assert.equal(isCanvasFileUrl('https://canvas.mine.edu/files/1/download?verifier=v'), false);
  fakeChrome([...BUILT_IN, 'https://canvas.mine.edu/*'], []);
  await findCanvasTab();
  assert.equal(isCanvasFileUrl('https://canvas.mine.edu/files/1/download?verifier=v'), true);
  assert.equal(fileDetails({ display_name: 'a.pdf', url: 'https://canvas.mine.edu/files/1/download' }).url, 'https://canvas.mine.edu/files/1/download');
  assert.equal(isCanvasFileUrl('http://canvas.mine.edu/files/1/download'), false);
  assert.equal(isCanvasFileUrl('https://evil.example/files/1/download'), false);
});

test('sites: what the student types becomes an https origin', () => {
  assert.equal(siteOrigin(' canvas.school.edu '), 'https://canvas.school.edu');
  assert.equal(siteOrigin('https://canvas.school.edu/courses/12/modules'), 'https://canvas.school.edu');
  assert.equal(siteOrigin('http://canvas.school.edu'), null);
  assert.equal(siteOrigin('localhost'), null);
  assert.equal(siteOrigin(''), null);
});

const answer = (status, body) => async () => ({ status, text: async () => body });
test('sites: Canvas is told apart by its API', async () => {
  assert.equal(await looksLikeCanvas('https://c.edu', answer(401, '{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}')), true);
  assert.equal(await looksLikeCanvas('https://c.edu', answer(200, 'while(1);{"id":5,"name":"A"}')), true);
  assert.equal(await looksLikeCanvas('https://bb.edu', answer(404, '<html>Not found</html>')), false);
  assert.equal(await looksLikeCanvas('https://bb.edu', answer(200, '{"ok":true}')), false);
  assert.equal(await looksLikeCanvas('https://gone.edu', async () => Promise.reject(new TypeError('Failed to fetch'))), false);
});

test('sites: a site that is not Canvas gives its permission back', async () => {
  const chrome = fakeChrome([...BUILT_IN], []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = answer(200, '<html>Blackboard</html>');
  try {
    assert.equal(await allowSite('https://vuws.westernsydney.edu.au'), 'not-canvas');
    assert.deepEqual(chrome.removed, ['https://vuws.westernsydney.edu.au/*']);
    globalThis.fetch = answer(401, '{"status":"unauthenticated"}');
    assert.equal(await allowSite('https://canvas.school.edu'), 'allowed');
    fakeChrome([...BUILT_IN], [], { grant: false });
    assert.equal(await allowSite('https://canvas.school.edu'), 'declined');
  } finally {
    globalThis.fetch = realFetch;
  }
});
