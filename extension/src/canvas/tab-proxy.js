// Injected into the Canvas tab. Answers the side panel's Canvas API requests
// with the student's own session (the tab's cookies). Only GET requests to
// this Canvas site's /api/v1 are made, and only for this extension.
if (!globalThis.__canvasToAiProxy) {
  globalThis.__canvasToAiProxy = true;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'canvas:get' || sender.id !== chrome.runtime.id) return false;
    canvasGet(message.url).then(reply, (e) => reply({ error: e.message }));
    return true; // the reply is sent asynchronously
  });
}

async function canvasGet(url) {
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/v1/')) throw new Error('Not a Canvas API address');
  const res = await fetch(target, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) return { status: res.status };
  // Canvas prefixes JSON for cookie sessions with "while(1);".
  const data = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') || '')?.[1] ?? null;
  return { status: res.status, data, next };
}
