// The Canvas sites the extension may read: every *.instructure.com, and each
// Canvas on a school's own address (canvas.school.edu) the student allowed.
// Chrome's granted host permissions are the list: nothing else is stored.
import { allowFileSite } from '../canvas/file.js';

const INSTRUCTURE = 'https://*.instructure.com/*';

// A site the student allowed is one exact origin; a wildcard grant (Canvas's
// file hosts, or "on all sites" set in chrome://extensions) is not a Canvas.
async function canvasSites() {
  const { origins = [] } = chrome.permissions?.getAll ? await chrome.permissions.getAll() : {}; // Safari before 15.4: instructure.com only
  return [INSTRUCTURE, ...origins.filter((o) => /^https:\/\/[^*]/.test(o))];
}

const latest = (tabs) => tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.active - a.active)[0];

// The tab to read: the active tab if it is on a Canvas site and its path
// matches `path`, else the most recently used one. Safari has no lastAccessed:
// a tab shown in a window comes first. The site of the tab found, and only
// that, may serve the files the panel then downloads (a Canvas on the
// school's own address serves them from there).
export async function findCanvasTab(path = /^\//) {
  const url = await canvasSites();
  const onPath = (t) => path.test(new URL(t.url).pathname);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true, url });
  const tab = active && onPath(active) ? active : latest((await chrome.tabs.query({ url })).filter(onPath));
  if (tab) allowFileSite(new URL(tab.url).origin);
  return tab;
}

// Another tab of the same Canvas site, when the one in use closes.
export const findSiteTab = async (site) => latest(await chrome.tabs.query({ url: `${site}/*` }));

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

// Is this site a Canvas? Asked without a login, Canvas answers
// /api/v1/users/self with exactly this: a 401, status "unauthenticated" and
// its errors list.
export async function looksLikeCanvas(origin, fetcher = fetch) {
  try {
    const res = await fetcher(`${origin}/api/v1/users/self`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    const body = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
    return res.status === 401 && body?.status === 'unauthenticated' && Array.isArray(body.errors) && body.errors.length > 0;
  } catch {
    return false;
  }
}

// Ask Chrome for this school's Canvas. Must be the first thing a click does
// (Chrome wants a user gesture). Kept only if the site turns out to be Canvas;
// otherwise throws what to tell the student.
export async function allowSite(origin) {
  const origins = [`${origin}/*`];
  if (!(await chrome.permissions.request({ origins }))) throw new Error('Chrome was not allowed to open it.');
  if (await looksLikeCanvas(origin)) return;
  await chrome.permissions.remove({ origins }).catch(() => {});
  throw new Error(`${new URL(origin).host} doesn't look like Canvas. Check the address in your Canvas tab.`);
}
