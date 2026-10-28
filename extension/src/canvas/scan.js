// Course scan: reads a Canvas course into a Course (see CONTEXT.md) through
// the Canvas seam.
//
//   const course = await scanCourse(canvas, courseId, { onProgress });
//
// canvas.get(url) resolves to { data, next } (next: the following page's URL,
// or null) and rejects on a failed request; `url` is a Canvas API path or a
// full URL Canvas returned. About 30 requests for a 12-week course: the
// modules come with their items and lock state in one listing; pages are read
// for their text and the files they link to. File details (download link,
// size) are left to the pack, for the files a student actually picks.

const LIMIT = 6; // requests in flight, well under Canvas's rate limit
const PAGE_TYPES = new Set(['Page', 'Assignment', 'Discussion']);

export async function scanCourse(canvas, courseId, { onProgress = () => {} } = {}) {
  const get = limited(canvas.get, LIMIT);
  const getAll = async (url) => {
    const out = [];
    for (let next = url; next; ) {
      const page = await get(next);
      out.push(...page.data);
      next = page.next;
    }
    return out;
  };
  const api = `/api/v1/courses/${courseId}`;
  onProgress('Reading the course…');
  const [course, modules, announcements] = await Promise.all([
    get(`${api}?include[]=syllabus_body`).then((r) => r.data),
    getAll(`${api}/modules?include[]=items&include[]=content_details&per_page=100`),
    getAll(`${api}/discussion_topics?only_announcements=true&per_page=100`),
  ]);

  // Every module's items first, so a page that links to a file the course
  // already lists does not list it again.
  const moduleItems = await Promise.all(
    modules.map((m) => m.items ?? getAll(`${m.items_url}${m.items_url.includes('?') ? '&' : '?'}include[]=content_details&per_page=100`)),
  );
  const listed = new Set(moduleItems.flat().filter((it) => it.type === 'File').map((it) => it.content_id));

  // Files a page links to (attachments, links, embeds) are items of their own;
  // pictures it only displays (<img>) belong to the page (page images).
  const pageImageIds = new Set();
  const linkedFiles = new Map(); // file id → Promise<item>
  const fileItem = (id) => {
    if (!linkedFiles.has(id)) {
      linkedFiles.set(id, get(`/api/v1/files/${id}`).then(
        ({ data }) => ({ kind: 'file', id, title: data.display_name, fileName: data.display_name, locked: data.locked_for_user ? plain(data.lock_explanation) || 'Locked' : '' }),
        () => null, // not visible to this student
      ));
    }
    return linkedFiles.get(id);
  };
  async function pageWithFiles(title, html, attachments = []) {
    const page = html?.trim() ? [{ kind: 'page', title, html }] : [];
    const linked = new Set(attachments.map((a) => a.id));
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    for (const el of doc.querySelectorAll('[href*="/files/"], [src*="/files/"], [data-api-endpoint*="/files/"]')) {
      const id = Number(/\/files\/(\d+)/.exec(el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('data-api-endpoint'))?.[1]);
      if (!id) continue;
      if (el.tagName === 'IMG') pageImageIds.add(id);
      else linked.add(id);
    }
    const files = (await Promise.all([...linked].filter((id) => !listed.has(id)).map(fileItem))).filter(Boolean);
    return [...page, ...files];
  }

  async function moduleItem(it) {
    const locked = it.content_details?.locked_for_user ? plain(it.content_details.lock_explanation) || 'Locked' : '';
    switch (it.type) {
      case 'File':
        return [{ kind: 'file', id: it.content_id, title: it.title, fileName: it.content_details?.display_name ?? it.title, locked }];
      case 'ExternalUrl':
        return [{ kind: 'link', title: it.title, url: it.external_url }];
      case 'ExternalTool':
        return [{ kind: 'link', title: it.title, url: it.html_url }];
      default:
        if (!PAGE_TYPES.has(it.type) || !it.url) return [];
        if (locked) return [{ kind: 'page', title: it.title, html: '', locked }];
        try {
          const { data } = await get(it.url);
          return pageWithFiles(it.title, data.body ?? data.description ?? data.message, data.attachments);
        } catch {
          return [{ kind: 'page', title: it.title, html: '', locked: 'Not available' }];
        }
    }
  }

  let read = 0;
  const folders = await Promise.all(
    modules.map(async (m, k) => {
      const items = moduleItems[k];
      const resolved = await Promise.all(items.map((it) => (it.type === 'SubHeader' ? null : moduleItem(it))));
      const sections = [{ title: null, items: [] }];
      items.forEach((it, i) => (it.type === 'SubHeader' ? sections.push({ title: it.title.trim(), items: [] }) : sections.at(-1).items.push(...resolved[i])));
      onProgress(`Reading the course… ${++read} of ${modules.length} modules`);
      return { id: `m${m.id}`, kind: 'module', title: m.name.trim(), sections };
    }),
  );

  announcements.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  const announcementItems = (
    await Promise.all(announcements.map((a) => pageWithFiles([a.posted_at?.slice(0, 10), a.title].filter(Boolean).join(' · '), a.message, a.attachments)))
  ).flat();
  folders.push({ id: 'announcements', kind: 'announcements', title: 'Announcements', sections: [{ title: null, items: announcementItems }] });
  folders.push({ id: 'syllabus', kind: 'syllabus', title: 'Syllabus', sections: [{ title: null, items: await pageWithFiles('Syllabus', course.syllabus_body) }] });

  // Drop empty sections and folders; give every item an id unique in the course.
  const kept = [];
  for (const folder of folders) {
    folder.sections = folder.sections.filter((s) => s.items.length);
    if (!folder.sections.length) continue;
    let n = 0;
    for (const section of folder.sections) for (const item of section.items) item.key = `${folder.id}:${n++}`;
    kept.push(folder);
  }
  for (const item of await Promise.all(linkedFiles.values())) if (item) listed.add(item.id);
  return {
    id: String(courseId),
    name: course.name,
    code: course.course_code ?? '',
    folders: kept,
    pageImageIds: [...pageImageIds].filter((id) => !listed.has(id)),
  };
}

// Lock explanations come as HTML ("This file is locked until <b>…</b>").
const plain = (html) => (html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// fn limited to n calls in flight.
function limited(fn, n) {
  let active = 0;
  const waiting = [];
  return async (...args) => {
    while (active >= n) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn(...args);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
