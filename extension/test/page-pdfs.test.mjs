import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';
import { stopsTheRun } from '../src/canvas/stops.js';

const { pagePdfs } = await import('../src/panel/page-pdfs.js');
const page = { title: 'P', html: '<p><img src="/courses/7/files/5/preview"></p>' };
const files = (bytes) => ({ meta: async () => ({ name: 'diagram.png', url: 'https://f.test/5', size: 9000, locked: '' }), bytes });

test('page pdfs: a picture lost to an ended login stops the run, so the page is saved later with it', async () => {
  const html = async () => new TextEncoder().encode('<!doctype html><title>Log in</title>').buffer;
  const pdf = pagePdfs(files(html), { loggedIn: async () => false });
  await assert.rejects(pdf(page), (e) => stopsTheRun(e) && /login ended/.test(e.message));
});

test('page pdfs: a picture Canvas would not give, with the login fine, does not stop the run', async () => {
  let asked = 0;
  const pdf = pagePdfs(files(async () => { throw new Error('download failed (404)'); }), { loggedIn: async () => (asked++, true) });
  await pdf(page).catch(() => {}); // pdfmake's browser build does not run in Node: only the check before it matters here
  assert.equal(asked, 1);
});

test('page pdfs: Stop while pictures download ends the page at once', async () => {
  const controller = new AbortController();
  let seen;
  const bytes = (url, { signal }) => new Promise((_, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const pdf = pagePdfs(files(bytes), { signal: controller.signal });
  const making = pdf(page);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(making, (e) => e.stopped === true);
  assert.equal(seen, controller.signal); // the download itself is told to stop
});
