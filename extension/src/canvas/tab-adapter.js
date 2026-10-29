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

// Download links are only followed to Canvas and its file hosts (the
// extension's host permissions), over https.
const FILE_HOSTS = /(^|\.)(instructure\.com|canvas-user-content\.com|inscloudgate\.net)$/;
export function isCanvasFileUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && FILE_HOSTS.test(hostname);
  } catch {
    return false;
  }
}

// The file seam's adapter in the extension: details through Canvas, bytes
// fetched by the panel itself (download links carry their own key).
export function canvasFiles(canvas) {
  return {
    async meta(id) {
      const { data } = await canvas.get(`/api/v1/files/${id}`);
      const url = isCanvasFileUrl(data.url) ? data.url : '';
      return { name: data.display_name, size: data.size ?? 0, url, locked: lockedReason(data, data.locked_for_user || !url) };
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
