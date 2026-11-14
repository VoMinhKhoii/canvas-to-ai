// OneDrive scan: reads what a student has in OneDrive and Teams into a Course
// (see CONTEXT.md), through the OneDrive seam.
//
//   const course = await scanOneDrive(od, tabUrl, { onProgress });
//
// od.get(url) resolves to the JSON SharePoint answers (its v2.0 drive API, on
// the student's own login) and rejects with { status } on a failed request.
// Teams keeps its files in SharePoint: a channel's files are a folder of the
// team's site, a chat's files sit in the sender's OneDrive. So the course is:
//   - the folder open in the tab (a OneDrive folder, or a channel's files from
//     Teams › Files › Open in SharePoint): a card per subfolder, like weeks;
//   - "Recordings shared with you": Teams meeting recordings, each with its
//     transcript (what an AI can read) beside the video (download only);
//   - "Files shared with you": everything else people shared, by who shared it.
// Item ids are the item's address in the drive API (files.meta reads it).
import { limiter } from '../limit.js';
import { extOf } from '../pack/names.js';

export const ONEDRIVE_URL = /^https:\/\/[^/]+\.sharepoint\.com\//;
const LIMIT = 6;
const DEPTH = 3; // the open folder, its subfolders (cards), and two levels inside them (sections)
const MAX_FOLDERS = 80; // listings read under the open folder
const MAX_SHARED = 400; // shared items read, newest first
const MAX_TRANSCRIPTS = 100;
const VIDEO = /^(mp4|mov|m4v|webm|mkv|avi|wmv)$/;
const SELECT = '$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime';

// The folder a SharePoint or OneDrive tab shows, as a URL the shares API
// resolves, or null (OneDrive's home, a site's home page).
//   …/Forms/AllItems.aspx?id=/sites/x/Shared Documents/General → that folder
//   …/my?id=/personal/me/Documents/Notes                        → that folder
//   …/sites/x/Shared Documents/Forms/AllItems.aspx              → the library
//   …/:f:/r/sites/x/…, …/:f:/g/…  (a sharing link)              → the link
export function folderUrlOf(tabUrl) {
  const url = new URL(tabUrl);
  const id = url.searchParams.get('id');
  // The id is a decoded path: a folder named "Week #1" must not end the URL at "#".
  if (id?.startsWith('/')) return url.origin + id.split('/').map(encodeURIComponent).join('/');
  if (/^\/:f:\//.test(url.pathname)) return `${url.origin}${url.pathname}${url.search}`;
  const forms = url.pathname.indexOf('/Forms/');
  if (forms > 0) return url.origin + url.pathname.slice(0, forms);
  return null;
}

// The shares API's name for a URL: "u!" and the URL in unpadded base64url.
export function shareId(url) {
  const bytes = new TextEncoder().encode(url);
  return `u!${btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

const itemApi = (origin, driveId, id) => `${origin}/_api/v2.0/drives/${driveId}/items/${id}`;
const originOf = (url) => new URL(url).origin;

// "Systems Architecture and Design Online Lecture-20261110_143613-Meeting Recording.mp4"
//   → { meeting: "Systems Architecture and Design Online Lecture", when: "10 Nov 2026, 14:36" }
// Some recordings carry the time in UTC ("…-20260916_064538UTC-Meeting
// Recording.mp4"): that one is shown in the student's own time zone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function recordingName(name) {
  const m = /^(.*)-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}(UTC)?-Meeting Recording\.\w+$/.exec(name);
  if (!m) return null;
  const [, meeting, ...parts] = m;
  const [y, mo, d, h, mi] = parts.slice(0, 5).map(Number);
  const t = parts[5] ? new Date(Date.UTC(y, mo - 1, d, h, mi)) : null;
  const [Y, M, D, H, Mi] = t ? [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes()] : [y, mo, d, h, mi];
  const two = (n) => String(n).padStart(2, '0');
  return { meeting: meeting.trim(), when: `${D} ${MONTHS[M - 1]} ${Y}, ${two(H)}:${two(Mi)}` };
}

export async function scanOneDrive(od, tabUrl, { onProgress = () => {} } = {}) {
  const limit = limiter(LIMIT);
  const get = (url) => limit(() => od.get(url));
  const origin = originOf(tabUrl);
  // A listing read whole: SharePoint gives it a page at a time.
  const getAll = async (url, max = Infinity) => {
    const out = [];
    for (let next = url; next && out.length < max; ) {
      const page = await get(next);
      out.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return out;
  };

  onProgress('Reading OneDrive…');
  // "Shared with you" lives on the student's OneDrive host (<tenant>-my), not
  // on a team site's. Either read can fail on its own (a folder this student
  // can't open, a OneDrive never visited): only both failing is an ended login.
  const myOrigin = origin.replace(/^https:\/\/([^.]+?)(-my)?\./, 'https://$1-my.');
  const folderUrl = folderUrlOf(tabUrl);
  const [open, shared] = await Promise.allSettled([
    folderUrl ? get(`${origin}/_api/v2.0/shares/${shareId(folderUrl)}/driveItem?${SELECT}`) : null,
    getAll(`${myOrigin}/_api/v2.0/me/drive/sharedWithMe?$top=200`, MAX_SHARED),
  ]);
  for (const { reason } of [open, shared]) if (reason && ![401, 403, 404].includes(reason.status)) throw reason;
  // Nothing to show: only a 401/403 means the login ended; a 404 is said as it is.
  if (!open.value?.folder && shared.reason) {
    if ([401, 403].includes(shared.reason.status)) throw Object.assign(new Error('Log in to OneDrive in this tab, then press Scan again.'), { loggedOut: true });
    throw Object.assign(new Error("OneDrive couldn't find your files here. Open your OneDrive or a class's files in this tab, then press Scan again."), { missing: true });
  }
  const closed = (e) => ([403, 404].includes(e.status) ? null : Promise.reject(e)); // a folder this student can't open

  // A drive item as a Course item, with its details: its download address is
  // the drive API's content address, which never expires (adapter.js).
  const fileItem = (it) => {
    const id = itemApi(originOf(it.webUrl), it.parentReference.driveId, it.id);
    return { kind: 'file', id, title: it.name, fileName: it.name, locked: null, details: { name: it.name, size: it.size ?? 0, url: `${id}/content`, locked: null } };
  };
  const folderItem = (it) => ({ kind: 'file', id: `folder:${it.webUrl}`, title: it.name, fileName: it.name, locked: 'A folder: open it in this tab to list its files' });

  // Each video gets its transcript beside it, when Teams made one. A meeting
  // recording is named by its time: its meeting (the section) or its folder
  // (often "Recordings") already says what it is.
  let lookups = 0;
  async function withTranscript(item) {
    if (!VIDEO.test(extOf(item.fileName))) return [item];
    const title = recordingName(item.fileName)?.when ?? item.fileName.replace(/\.\w+$/, '');
    const list = lookups++ < MAX_TRANSCRIPTS ? await get(`${item.id}/media/transcripts`).then((r) => r.value ?? [], () => []) : [];
    if (!list.length) return [{ ...item, title }];
    const t = list.find((x) => x.isDefault) ?? list[0];
    const id = `${item.id}/media/transcripts/${t.id}`;
    const fileName = `${item.fileName.replace(/\.\w+$/, '')}.vtt`; // named after its video: a meeting's transcripts share one name
    const transcript = { kind: 'file', id, title: `${title} (transcript)`, fileName, locked: null, details: { name: fileName, size: t.size ?? 0, url: `${id}/streamContent`, locked: null } };
    return [transcript, { ...item, title: `${title} (video)` }];
  }

  const top = open.value?.folder ? open.value : null;
  const folders = [];
  if (top) {
    onProgress(`Reading ${top.name === 'root' ? 'the folder' : top.name}…`);
    folders.push(...(await openFolder(top)));
  }
  if (shared.value) {
    onProgress('Reading what was shared with you…');
    folders.push(...(await sharedFolders(shared.value)));
  }

  let n = 0;
  for (const folder of folders) for (const section of folder.sections) for (const item of section.items) item.key = `${folder.id}:${n++}`;
  const title = top ? (top.name === 'root' ? await libraryName(top) : top.name) : 'OneDrive and Teams';
  return { name: title, code: new URL(origin).hostname, root: 'OneDrive', folders: folders.filter((f) => f.sections.length) };

  // A library's top folder is named "root": name it after its team (a Teams
  // class's files) or its owner (someone's OneDrive).
  async function libraryName(root) {
    const drive = await get(`${originOf(root.webUrl)}/_api/v2.0/drives/${root.parentReference.driveId}?$select=name,owner`).catch(() => ({}));
    const owner = drive.owner?.group?.displayName?.replace(/\s+Owners$/, '') ?? (drive.owner?.user && `OneDrive - ${drive.owner.user.displayName}`);
    return owner || drive.name || 'Files';
  }

  // The open folder: its own files on one card, then a card per subfolder,
  // whose own subfolders are its sections (two levels deep; deeper folders
  // are listed, to be opened in the tab).
  async function openFolder(top) {
    let budget = MAX_FOLDERS;
    const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
    // A folder's files as items (sorted, videos with their transcripts) and
    // its subfolders (sorted), or null when it can't be read (closed to this
    // student, or past MAX_FOLDERS).
    async function contents(it) {
      const children = budget-- > 0 ? await getAll(`${itemApi(originOf(it.webUrl), it.parentReference.driveId, it.id)}/children?$top=200&${SELECT}`).catch(closed) : null;
      if (!children) return null;
      const items = (await Promise.all(children.filter((c) => c.file).sort(byName).map((f) => withTranscript(fileItem(f))))).flat();
      return { items, subs: children.filter((c) => c.folder).sort(byName) };
    }
    // Every file under `it`, as sections titled by their path below it.
    async function sections(it, path, depth) {
      const found = await contents(it);
      if (!found) return [{ title: path, items: [folderItem(it)] }];
      const { items, subs } = found;
      if (depth >= DEPTH) items.push(...subs.map(folderItem));
      const own = items.length ? [{ title: path, items }] : [];
      const nested = depth < DEPTH ? await Promise.all(subs.map((s) => sections(s, path ? `${path}/${s.name}` : s.name, depth + 1))) : [];
      return [...own, ...nested.flat()];
    }
    const { items: loose, subs } = (await contents(top)) ?? { items: [], subs: [] };
    const cards = await Promise.all(subs.map(async (s) => ({ id: `folder-${s.id}`, title: s.name, sections: await sections(s, null, 2) })));
    const name = top.name === 'root' ? 'Files' : top.name;
    return [...(loose.length ? [{ id: 'here', title: name, sections: [{ title: null, items: loose }] }] : []), ...cards];
  }

  // Shared with the student: recordings by meeting, other files by who shared them.
  async function sharedFolders(list) {
    const items = list.map((s) => s.remoteItem ?? s).filter((it) => it?.parentReference?.driveId && it.webUrl);
    const when = (it) => it.shared?.sharedDateTime ?? it.lastModifiedDateTime ?? '';
    items.sort((a, b) => when(b).localeCompare(when(a)));
    const sharer = (it) => it.shared?.sharedBy?.user?.displayName ?? it.createdBy?.user?.displayName ?? 'Someone';
    const placed = await Promise.all(
      items.map(async (it) => {
        const from = `From ${sharer(it)}`;
        if (it.folder) return ['others', from, [folderItem(it)]];
        const rec = recordingName(it.name);
        if (rec || VIDEO.test(extOf(it.name))) return ['recordings', rec?.meeting ?? from, await withTranscript(fileItem(it))];
        return ['others', from, [fileItem(it)]];
      }),
    );
    // Sections in the order of their newest share, items newest first.
    const groups = { recordings: new Map(), others: new Map() };
    for (const [card, title, entries] of placed) groups[card].set(title, [...(groups[card].get(title) ?? []), ...entries]);
    const sections = (map) => [...map].map(([title, list]) => ({ title, items: list }));
    return [
      { id: 'recordings', title: 'Recordings shared with you', sections: sections(groups.recordings) },
      { id: 'shared', title: 'Files shared with you', sections: sections(groups.others) },
    ];
  }
}
