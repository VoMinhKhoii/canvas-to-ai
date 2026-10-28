// Injected into the Canvas tab with chrome.scripting.executeScript, so API calls
// run on the Canvas origin with the student's own session cookie (no token).
// Must stay self-contained: the function is serialized and helpers outside it
// don't exist in the tab.
export async function collectCourse(courseId) {
  const api = `${location.origin}/api/v1`;
  const progress = (text) => chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {});

  // Keep at most 4 requests in flight so we stay well under Canvas rate limits.
  let active = 0;
  const waiting = [];
  async function get(url) {
    while (active >= 4) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Canvas prefixes cookie-authenticated JSON with "while(1);".
      const data = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') || '')?.[1];
      return { data, next };
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function getAll(path) {
    let url = `${api}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    const out = [];
    while (url) {
      const page = await get(url);
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }

  const files = new Map();
  function file(id) {
    if (!files.has(id)) {
      files.set(
        id,
        get(`${api}/files/${id}`).then(
          ({ data }) => ({
            kind: 'file',
            id,
            name: data.display_name,
            size: data.size || 0,
            url: data.url || '',
            unavailable: data.locked_for_user || !data.url ? data.lock_explanation || 'locked' : '',
          }),
          (e) => ({ kind: 'file', id, name: `file ${id}`, size: 0, url: '', unavailable: e.message }),
        ),
      );
    }
    return files.get(id);
  }

  function filesIn(html, attachments) {
    const ids = [...(attachments || []).map((a) => a.id), ...[...(html || '').matchAll(/\/files\/(\d+)/g)].map((m) => +m[1])];
    return Promise.all([...new Set(ids)].map(file));
  }

  async function textWithFiles(title, html, attachments) {
    const text = html && html.trim() ? [{ kind: 'text', title, html }] : [];
    return [...text, ...(await filesIn(html, attachments))];
  }

  function dedupe(items) {
    const seen = new Set();
    return items.filter((it) => it.kind !== 'file' || (!seen.has(it.id) && seen.add(it.id)));
  }

  const course = (await get(`${api}/courses/${courseId}?include[]=syllabus_body`)).data;
  const modules = await getAll(`/courses/${courseId}/modules`);
  let done = 0;
  progress(`Scanning ${modules.length} modules…`);

  const moduleGroups = await Promise.all(
    modules.map(async (m) => {
      const moduleItems = await getAll(`/courses/${courseId}/modules/${m.id}/items`);
      const items = await Promise.all(
        moduleItems.map(async (it) => {
          if (it.type === 'File') return [await file(it.content_id)];
          if (!['Page', 'Assignment', 'Discussion'].includes(it.type) || !it.url) return [];
          try {
            const { data } = await get(it.url);
            return textWithFiles(it.title, data.body || data.description || data.message, data.attachments);
          } catch {
            return []; // locked or hidden item
          }
        }),
      );
      progress(`Scanned ${++done}/${modules.length} modules…`);
      return { title: m.name, items: dedupe(items.flat()) };
    }),
  );

  progress('Scanning announcements…');
  const announcements = await getAll(`/courses/${courseId}/discussion_topics?only_announcements=true`);
  announcements.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  const announcementItems = await Promise.all(
    announcements.map((a) => textWithFiles([a.posted_at?.slice(0, 10), a.title].filter(Boolean).join(' · '), a.message, a.attachments)),
  );

  const groups = [
    ...moduleGroups,
    { title: 'Announcements', items: dedupe(announcementItems.flat()) },
    { title: 'Syllabus', items: await textWithFiles('Syllabus', course.syllabus_body) },
  ];
  return { courseName: course.name, groups: groups.filter((g) => g.items.length) };
}
