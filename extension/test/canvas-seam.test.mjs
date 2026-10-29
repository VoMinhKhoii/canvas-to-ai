// The Canvas seam's trust checks: the tab proxy answers only same-site API
// responses, and the panel follows download links only to Canvas file hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isCanvasFileUrl } = await import('../src/canvas/tab-adapter.js');

// The real tab-proxy.js listener, in a fake Canvas tab whose fetch lands on `landed`.
let listener;
globalThis.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn) => (listener = fn) } } };
globalThis.location = new URL('https://school.instructure.com/courses/1');
let landed;
globalThis.fetch = async (target) => ({
  url: landed ?? String(target),
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => 'while(1);{"name":"Course"}',
});
await import('../src/canvas/tab-proxy.js');
const ask = (url) => new Promise((resolve) => listener({ type: 'canvas:get', url }, { id: 'ext' }, resolve));

test('proxy: an API answer from this Canvas site is passed on', async () => {
  landed = undefined;
  assert.deepEqual(await ask('/api/v1/courses/1'), { status: 200, data: { name: 'Course' }, next: null });
});

test('proxy: a request redirected off the API is refused, not parsed', async () => {
  landed = 'https://school.instructure.com/login/canvas';
  assert.match((await ask('/api/v1/courses/1')).error, /sent the request elsewhere/);
  landed = 'https://elsewhere.example/api/v1/courses/1';
  assert.match((await ask('/api/v1/courses/1')).error, /sent the request elsewhere/);
});

test('download links are followed only to Canvas file hosts over https', () => {
  assert.ok(isCanvasFileUrl('https://school.instructure.com/files/5/download?download_frd=1&verifier=x'));
  assert.ok(isCanvasFileUrl('https://cluster1.canvas-user-content.com/files/5'));
  assert.ok(isCanvasFileUrl('https://x.inscloudgate.net/files/5'));
  for (const url of ['http://school.instructure.com/files/5', 'https://instructure.com.evil.example/f', 'https://evilinstructure.com/f', 'javascript:alert(1)', '', undefined]) {
    assert.equal(isCanvasFileUrl(url), false, String(url));
  }
});
