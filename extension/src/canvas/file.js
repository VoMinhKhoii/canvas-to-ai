import { lockedReason } from './locked.js';

// Download links are only followed to Canvas and its file hosts (the
// extension's host permissions), over https: a Canvas on a school's own
// address serves its files from there too, once the student allowed it.
const FILE_HOSTS = /(^|\.)(instructure\.com|canvas-user-content\.com|inscloudgate\.net)$/;
const sites = new Set();
export function allowFileSite(origin) {
  sites.add(origin);
}
export function isCanvasFileUrl(url) {
  try {
    const { protocol, hostname, origin } = new URL(url);
    return protocol === 'https:' && (FILE_HOSTS.test(hostname) || sites.has(origin));
  } catch {
    return false;
  }
}

// A Canvas file object as the file seam's details.
export function fileDetails(data) {
  const url = isCanvasFileUrl(data.url) ? data.url : '';
  return { name: data.display_name, size: data.size ?? 0, url, locked: lockedReason(data, data.locked_for_user || !url) };
}

// A Canvas file object as a Course item with its details, saved as `name`
// (its own name unless given). Its kind is read from its own name: a renamed
// "Makefile" is still a Makefile.
export function asFileItem(data, name) {
  const details = fileDetails(data);
  const title = name ?? details.name;
  return { kind: 'file', id: data.id, title, fileName: details.name, locked: details.locked, details: { ...details, name: title } };
}
