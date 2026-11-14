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

// The file seam's adapter. Every OneDrive item carries its details (the scan
// has them), so meta() is never asked. Download addresses never expire: the
// drive API's content address sends the student's cookies on to a freshly
// signed link each time, and a transcript's streamContent answers with the
// same cookies.
export function oneDriveFiles({ fetch = globalThis.fetch } = {}) {
  return {
    async meta() {
      throw new Error('OneDrive items carry their details');
    },
    async bytes(url) {
      const res = await fetch(url, { credentials: 'include' }).catch(() => {
        throw new Error("couldn't download it: check your connection and copy again");
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return res.arrayBuffer();
    },
  };
}
