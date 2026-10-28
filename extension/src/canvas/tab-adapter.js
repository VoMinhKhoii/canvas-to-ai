import { lockedReason } from './locked.js';

// The Canvas seam's adapter in the extension: each request is answered by
// tab-proxy.js inside the student's Canvas tab, so it carries their session.
export async function tabCanvas(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['tab-proxy.js'] });
  return {
    async get(url) {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'canvas:get', url });
      if (!res || res.error) throw new Error(res?.error ?? 'The Canvas tab did not answer. Reload it and try again.');
      if (!res.data) throw Object.assign(new Error(res.status === 401 ? 'Log in to Canvas in that tab first.' : `Canvas answered ${res.status}`), { status: res.status });
      return { data: res.data, next: res.next };
    },
  };
}

// The file seam's adapter in the extension: details through Canvas, bytes
// fetched by the panel itself (download links carry their own key).
export function canvasFiles(canvas) {
  return {
    async meta(id) {
      const { data } = await canvas.get(`/api/v1/files/${id}`);
      return { name: data.display_name, size: data.size ?? 0, url: data.url ?? '', locked: lockedReason(data, data.locked_for_user || !data.url) };
    },
    async bytes(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return res.arrayBuffer();
    },
  };
}
