import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';
import { stopsTheRun } from '../src/canvas/stops.js';

const { pagePictures } = await import('../src/panel/page-pictures.js');
const html = '<p><img src="/courses/7/files/5/preview"></p>';
const files = (bytes) => ({ meta: async () => ({ name: 'diagram.png', url: 'https://f.test/5', size: 9000, locked: '' }), bytes });

test('page pictures: a picture lost to an ended login stops the run, so the page is saved later with it', async () => {
  const loginPage = async () => new TextEncoder().encode('<!doctype html><title>Log in</title>').buffer;
  const pictures = pagePictures(files(loginPage), { loggedIn: async () => false });
  await assert.rejects(pictures(html), (e) => stopsTheRun(e) && /login ended/.test(e.message));
});

test('page pictures: a picture Canvas would not give, with the login fine, does not stop the run', async () => {
  let asked = 0;
  const pictures = pagePictures(files(async () => { throw new Error('download failed (404)'); }), { loggedIn: async () => (asked++, true) });
  assert.equal((await pictures(html)).size, 0); // the page is made without it
  assert.equal(asked, 1);
});

test('page pictures: a PNG is fetched once for two of its uses, and given with its size', async () => {
  const png = (await import('node:fs')).readFileSync(new URL('../src/icons/icon-128.png', import.meta.url));
  let fetched = 0;
  const pictures = pagePictures(files(async () => (fetched++, png)));
  const shown = await pictures(`${html}${html}<img src="https://elsewhere.test/a.png">`);
  assert.equal(fetched, 1);
  assert.deepEqual([...shown.keys()], ['/courses/7/files/5/preview']);
  assert.equal(shown.get('/courses/7/files/5/preview').width, 128);
});

test('page pictures: Stop while pictures download ends the page at once', async () => {
  const controller = new AbortController();
  let seen;
  const bytes = (url, { signal }) => new Promise((_, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const pictures = pagePictures(files(bytes), { signal: controller.signal });
  const making = pictures(html);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(making, (e) => e.stopped === true);
  assert.equal(seen, controller.signal); // the download itself is told to stop
});
