// The Canvas seam's trust checks: the tab proxy answers only same-site API
// responses, and the panel follows download links only to Canvas file hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isCanvasFileUrl } = await import('../src/canvas/file.js');

// The real tab-proxy.js listener, in a fake Canvas tab whose fetch lands on `landed`.
let listener;
globalThis.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn) => (listener = fn) } } };
globalThis.location = new URL('https://school.instructure.com/courses/1');
globalThis.document = { cookie: 'a=1; _csrf_token=t%2Bk' };
let landed;
let answer = {}; // what differs from a plain 200
let sent; // the last request's options
globalThis.fetch = async (target, options) => {
  sent = options;
  return { url: landed ?? String(target), ok: true, status: 200, headers: new Headers(), text: async () => 'while(1);{"name":"Course"}', ...answer };
};
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

test('proxy: Canvas slowing down is told apart from a refusal', async () => {
  landed = undefined;
  answer = { ok: false, status: 403, headers: new Headers({ 'X-Rate-Limit-Remaining': '0.5' }), text: async () => '403 Forbidden (Rate Limit Exceeded)' };
  assert.deepEqual(await ask('/api/v1/courses/1'), { status: 403, remaining: 0.5, throttled: true });
  answer = { ok: false, status: 403, text: async () => '{"status":"unauthorized"}' };
  assert.deepEqual(await ask('/api/v1/courses/1'), { status: 403 });
  answer = {};
});

test('proxy: the remaining quota comes with an answer', async () => {
  answer = { headers: new Headers({ 'X-Rate-Limit-Remaining': '612.25' }) };
  assert.equal((await ask('/api/v1/courses/1')).remaining, 612.25);
  answer = {};
});

const query = (q) => new Promise((resolve) => listener({ type: 'canvas:graphql', query: q, variables: { id: '5' } }, { id: 'ext' }, resolve));

test('proxy: a GraphQL query is posted to this Canvas site with its CSRF token', async () => {
  landed = undefined;
  assert.deepEqual(await query('query($id: ID!) { x }'), { status: 200, data: { name: 'Course' }, next: null });
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['X-CSRF-Token'], 't+k');
  assert.deepEqual(JSON.parse(sent.body), { query: 'query($id: ID!) { x }', variables: { id: '5' } });
});

test('proxy: only queries: a mutation is never sent', async () => {
  sent = 'nothing';
  assert.match((await query('mutation { deleteDiscussionEntry(input: {}) { errors } }')).error, /Not a Canvas query/);
  assert.match((await query('{ x } mutation { y }')).error, /Not a Canvas query/);
  assert.match((await query('query { x } mutation { y }')).error, /Not a Canvas query/);
  assert.equal(sent, 'nothing');
});

test('proxy: messages from anyone else, or of another kind, get no answer', () => {
  assert.equal(listener({ type: 'canvas:graphql', query: 'query { x }' }, { id: 'other' }, () => {}), false);
  assert.equal(listener({ type: 'canvas:post', url: '/api/v1/x' }, { id: 'ext' }, () => {}), false);
});

test('download links are followed only to Canvas file hosts over https', () => {
  assert.ok(isCanvasFileUrl('https://school.instructure.com/files/5/download?download_frd=1&verifier=x'));
  assert.ok(isCanvasFileUrl('https://cluster1.canvas-user-content.com/files/5'));
  assert.ok(isCanvasFileUrl('https://x.inscloudgate.net/files/5'));
  for (const url of ['http://school.instructure.com/files/5', 'https://instructure.com.evil.example/f', 'https://evilinstructure.com/f', 'javascript:alert(1)', '', undefined]) {
    assert.equal(isCanvasFileUrl(url), false, String(url));
  }
});
