import { fileDetails } from './file.js';

// The Canvas seam's adapter in the extension: each request is answered by
// tab-proxy.js inside the student's Canvas tab, so it carries their session.
//
// A long run outlives the page in that tab: the student moves around Canvas
// (the proxy goes with the old page) or closes the tab. The proxy is then put
// back, in that tab or another of the same Canvas site (findTab). Until it
// is, a request fails as `offline`, which steady() waits out.
export async function tabCanvas(tabId, { findTab = async () => null } = {}) {
  const site = new URL((await chrome.tabs.get(tabId)).url).origin;
  const onSite = async (id) => (await chrome.tabs.get(id).catch(() => null))?.url?.startsWith(`${site}/`);
  const inject = async (id) => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['tab-proxy.js'] });
    tabId = id;
  };
  await inject(tabId);
  async function reconnect() {
    if (await onSite(tabId)) return inject(tabId);
    const other = await findTab(site);
    if (other) await inject(other.id);
  }
  const lost = () => Object.assign(new Error('Lost the Canvas tab. Keep Canvas open in a tab, then try again.'), { offline: true });
  const ask = async (message) => {
    let res = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
    if (res === null) {
      await reconnect().catch(() => {});
      res = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
      if (res === null) throw lost();
    }
    if (res?.offline) throw Object.assign(new Error('Lost the connection to Canvas. Check your internet, then try again.'), { offline: true });
    if (!res || res.error) throw new Error(res?.error ?? 'The Canvas tab did not answer. Reload it and try again.');
    // No status on a throttled answer: a 403 means "closed to you" to the scan.
    if (res.throttled) throw Object.assign(new Error('Canvas asked to slow down. Wait a few minutes and try again.'), { throttled: true });
    if (!res.data) throw Object.assign(new Error(res.status === 401 ? 'Log in to Canvas in that tab first.' : `Canvas answered ${res.status}`), { status: res.status });
    return res;
  };
  return {
    async get(url) {
      const res = await ask({ type: 'canvas:get', url });
      return { data: res.data, next: res.next, remaining: res.remaining };
    },
    // A GraphQL query; its `data`. Canvas reports a failed query in the body.
    async graphql(query, variables) {
      const res = await ask({ type: 'canvas:graphql', query, variables });
      if (!res.data.data || res.data.errors?.length) throw new Error(res.data.errors?.[0]?.message ?? 'Canvas could not answer that');
      return { data: res.data.data, remaining: res.remaining };
    },
  };
}

// The file seam's adapter in the extension: details through Canvas, bytes
// fetched by the panel itself (download links carry their own key).
export function canvasFiles(canvas) {
  return {
    async meta(id) {
      const { data } = await canvas.get(`/api/v1/files/${id}`);
      return fileDetails(data);
    },
    async bytes(url) {
      const res = await fetch(url).catch(() => {
        throw new Error("couldn't download it: check your connection and copy again");
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return res.arrayBuffer();
    },
  };
}
