// The Canvas sites the extension may read: every *.instructure.com, and each
// Canvas on a school's own address (canvas.school.edu) the student allowed.
// Chrome's granted host permissions are the list: nothing else is stored.
import { allowFileSite } from '../canvas/file.js';

const FILE_HOSTS_ONLY = /canvas-user-content\.com|inscloudgate\.net/; // file servers, never a Canvas to scan

async function granted() {
  const origins = chrome.permissions?.getAll ? (await chrome.permissions.getAll()).origins ?? [] : chrome.runtime.getManifest().host_permissions ?? [];
  return origins.filter((o) => o.startsWith('https://') && !FILE_HOSTS_ONLY.test(o));
}

// A host permission pattern ("https://*.instructure.com/*") as a test of a URL.
const matcher = (pattern) => {
  const host = pattern.slice('https://'.length, pattern.indexOf('/', 'https://'.length));
  const re = host.startsWith('*.') ? new RegExp(`^(.+\\.)?${host.slice(2).replace(/\./g, '\\.')}$`) : new RegExp(`^${host.replace(/\./g, '\\.')}$`);
  return (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && re.test(u.hostname);
    } catch {
      return false;
    }
  };
};

const latest = (tabs) => tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.active - a.active)[0];

// The tab to read: the active tab if it is on a Canvas site and its path
// matches `path`, else the most recently used one. Safari has no lastAccessed:
// a tab shown in a window comes first.
export async function findCanvasTab(path = /^\//) {
  const sites = await granted();
  const onCanvas = (url) => sites.some((s) => matcher(s)(url)) && path.test(new URL(url).pathname);
  for (const s of sites) if (!s.startsWith('https://*')) allowFileSite(s.slice(0, -2));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && onCanvas(active.url)) return active;
  const tabs = await chrome.tabs.query({ url: sites });
  return latest(tabs.filter((t) => onCanvas(t.url)));
}

// "canvas.school.edu", "https://canvas.school.edu/courses/12" → its origin, or null.
export function siteOrigin(text) {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.origin : null;
  } catch {
    return null;
  }
}

// Is this site a Canvas? Its API answers JSON at /api/v1/users/self (a 401
// with "unauthenticated" when the panel's request carries no login).
export async function looksLikeCanvas(origin, fetcher = fetch) {
  try {
    const res = await fetcher(`${origin}/api/v1/users/self`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    const body = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
    return Boolean(body && (body.id || body.status === 'unauthenticated' || Array.isArray(body.errors)));
  } catch {
    return false;
  }
}

// Ask Chrome for this school's Canvas. Must be the first thing a click does
// (Chrome wants a user gesture). Kept only if the site turns out to be Canvas.
export async function allowSite(origin) {
  const origins = [`${origin}/*`];
  if (!(await chrome.permissions.request({ origins }))) return 'declined';
  if (await looksLikeCanvas(origin)) {
    allowFileSite(origin);
    return 'allowed';
  }
  await chrome.permissions.remove({ origins }).catch(() => {});
  return 'not-canvas';
}
