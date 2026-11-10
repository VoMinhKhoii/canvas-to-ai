// Injected into the Canvas tab. Answers the side panel's Canvas API requests
// with the student's own session (the tab's cookies). Only reads, only to this
// Canvas site, and only for this extension: GET requests to /api/v1, and
// GraphQL queries (never mutations) for what /api/v1 won't give, such as the
// replies to an anonymous discussion.
if (!globalThis.__canvasToAiProxy) {
  globalThis.__canvasToAiProxy = true;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    const job = message?.type === 'canvas:get' ? canvasGet(message.url) : message?.type === 'canvas:graphql' ? canvasQuery(message.query, message.variables) : null;
    if (!job) return false;
    job.then(reply, (e) => reply({ error: e.message, ...(e.offline && { offline: true }) }));
    return true; // the reply is sent asynchronously
  });
}

async function canvasGet(url) {
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/v1/')) throw new Error('Not a Canvas API address');
  return answer(await send(target, { credentials: 'include', headers: { Accept: 'application/json' } }), '/api/v1/');
}

async function canvasQuery(query, variables) {
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('Not a Canvas query');
  // Canvas wants its CSRF token on a POST, even one that only reads.
  const token = decodeURIComponent(/(?:^|;\s*)_csrf_token=([^;]+)/.exec(document.cookie)?.[1] ?? '');
  const res = await send(new URL('/api/graphql', location.origin), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return answer(res, '/api/graphql');
}

// fetch fails outright only when the connection does: the panel waits that out.
const send = (target, options) => fetch(target, options).catch(() => {
  throw Object.assign(new Error('No connection to Canvas'), { offline: true });
});

async function answer(res, path) {
  // A redirect (an expired login, a misconfigured site) must not make another
  // page's content pass for an API answer.
  const landed = new URL(res.url);
  if (landed.origin !== location.origin || !landed.pathname.startsWith(path)) throw new Error('Canvas sent the request elsewhere. Log in to Canvas in that tab and try again.');
  const remaining = Number.parseFloat(res.headers.get('X-Rate-Limit-Remaining'));
  const quota = Number.isNaN(remaining) ? {} : { remaining };
  if (!res.ok) {
    // Canvas says "slow down" with a 403 (429 on some sites), the same status
    // as "not for you": only the body tells them apart.
    const throttled = res.status === 429 || (res.status === 403 && /rate limit exceeded/i.test(await res.text()));
    return { status: res.status, ...quota, ...(throttled && { throttled }) };
  }
  // Canvas prefixes JSON for cookie sessions with "while(1);".
  const data = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') || '')?.[1] ?? null;
  return { status: res.status, data, next, ...quota };
}
