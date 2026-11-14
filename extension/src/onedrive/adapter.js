// The OneDrive seam's adapter in the extension. The panel asks SharePoint
// itself: with the extension's permission for *.sharepoint.com, Chrome sends
// the student's SharePoint login cookies, so nothing is registered with
// Microsoft and no token is kept.
//
// A request SharePoint sends elsewhere (to the Microsoft login page) or
// refuses with 401/403 on the first read means the login has ended.
export function oneDrive({ fetch = globalThis.fetch } = {}) {
  return {
    async get(url) {
      const res = await fetch(url, { credentials: 'include', redirect: 'manual', headers: { Accept: 'application/json' } }).catch(() => {
        throw Object.assign(new Error('No connection to OneDrive. Check your internet, then try again.'), { offline: true });
      });
      if (res.type === 'opaqueredirect' || res.status === 401) throw Object.assign(new Error('Log in to OneDrive in this tab, then press Scan again.'), { loggedOut: true, status: 401 });
      if (!res.ok) throw Object.assign(new Error(`OneDrive answered ${res.status}`), { status: res.status });
      return res.json();
    },
  };
}

// The file seam's adapter: an item's id is its address in the drive API.
// Download links are short-lived and carry their own key (no cookies needed),
// so they are looked up when a file is picked, not when the folder is read.
export function oneDriveFiles(od, { fetch = globalThis.fetch } = {}) {
  return {
    async meta(id) {
      if (/\/media\/transcripts\/[^/]+$/.test(id)) {
        const [list, tid] = [await od.get(id.replace(/\/[^/]+$/, '')), id.split('/').pop()];
        const t = list.value.find((x) => x.id === tid);
        if (!t?.temporaryDownloadUrl) return { name: '', size: 0, url: '', locked: 'The transcript is gone' };
        return { name: t.displayName.replace(/\.\w+$/, '.vtt'), size: t.size ?? 0, url: t.temporaryDownloadUrl, locked: null };
      }
      const it = await od.get(`${id}?$select=name,size,@content.downloadUrl`);
      const url = it['@content.downloadUrl'] ?? '';
      return { name: it.name, size: it.size ?? 0, url, locked: url ? null : "OneDrive won't let you download it" };
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
