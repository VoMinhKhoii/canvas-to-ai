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

import { limiter } from '../limit.js';
import { lockedReason } from './locked.js';
import { fileDetails, asFileItem } from './file.js';
import { feedbackHtml, gradesHtml, quizScoreHtml, repliesHtml } from './talk.js';
import { readAll } from './read.js';
import { stopsTheRun } from './stops.js';

const LIMIT = 6; // requests in flight, well under Canvas's rate limit
const PAGE_TYPES = new Set(['Page', 'Assignment', 'Discussion']);
const CLOSED = [401, 403, 404]; // Canvas's ways of saying a course doesn't open this to a student

// A scan's requests, a few at a time. optional(url): a listing the course
// (or group) may close to students, read as empty when it does.
function reader(canvas) {
  const limit = limiter(LIMIT);
  const get = (url) => limit(() => canvas.get(url));
  const getAll = (url) => readAll(get, url);
  const optional = (url) => getAll(url).catch((e) => (CLOSED.includes(e.status) && !stopsTheRun(e) ? [] : Promise.reject(e)));
  return { get, getAll, optional };
}

// everything: also what sits outside the modules, quizzes, each submission's
// grade, rubric, comments and earlier attempts, and a page of the course's
// grades (total: the course total, from the student's enrollment).
// replies: discussions with their replies (other students' words).
// docs: Canvadocs (canvadocs.js), to find submitted files a lecturer wrote
// notes on: each gets an annotated copy beside it.
export async function scanCourse(canvas, courseId, { onProgress = () => {}, everything = false, replies = false, total = null, docs = null } = {}) {
  const { get, getAll, optional } = reader(canvas);
  const api = `/api/v1/courses/${courseId}`;
  onProgress('Reading the course…');
  const [course, modules, announcements, submissions, courseFiles] = await Promise.all([
    get(`${api}?include[]=syllabus_body`).then((r) => r.data),
    getAll(`${api}/modules?include[]=items&include[]=content_details&per_page=100`),
    // A course can close its announcements (403) and still open everything
    // else. Any other failure is real: the scan must not pass without them.
    getAll(`${api}/discussion_topics?only_announcements=true&per_page=100`).catch((e) => (e.status === 403 ? [] : Promise.reject(e))),
    // The student's own latest submissions. A course that refuses this listing
    // (Canvas can say 401, 403 or 404 to a logged-in student) is otherwise still open.
    optional(`${api}/students/submissions?student_ids[]=self&include[]=assignment${everything ? '&include[]=submission_comments&include[]=rubric_assessment&include[]=submission_history' : ''}&per_page=100`),
    // One listing carries every file's details: no request per file later.
    everything ? optional(`${api}/files?per_page=100`) : [],
  ]);
  const fileInfo = new Map(courseFiles.map((f) => [f.id, fileDetails(f)]));
  const pageTypes = everything ? new Set([...PAGE_TYPES, 'Quiz']) : PAGE_TYPES;
  const courseFileItem = (id, info, title = info.name) => ({ kind: 'file', id, title, fileName: info.name, locked: info.locked, details: info });

  // Every module's items first, so a page that links to a file the course
  // already lists does not list it again.
  const moduleItems = await Promise.all(
    modules.map((m) => m.items ?? getAll(`${m.items_url}${m.items_url.includes('?') ? '&' : '?'}include[]=content_details&per_page=100`)),
  );
  const listed = new Set(moduleItems.flat().filter((it) => it.type === 'File').map((it) => it.content_id));

  // Files a page links to (attachments, links, embeds) are items of their own;
  // pictures it only displays (<img>) belong to the page (page images).
  const linkedFiles = new Map(); // file id → Promise<item>
  const fileItem = (id) => {
    if (!linkedFiles.has(id)) {
      linkedFiles.set(id, fileInfo.has(id) ? Promise.resolve(courseFileItem(id, fileInfo.get(id))) : get(`/api/v1/files/${id}`).then(
        ({ data }) => ({ kind: 'file', id, title: data.display_name, fileName: data.display_name, locked: lockedReason(data) }),
        (e) => {
          if (stopsTheRun(e)) throw e; // says nothing about this file
          return null; // not visible to this student
        },
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
      if (el.tagName !== 'IMG') linked.add(id);
    }
    // A copy each time: a file linked from two pages is an item in both, each with its own key.
    const files = await Promise.all([...linked].filter((id) => !listed.has(id)).map(fileItem));
    return [...page, ...files.filter(Boolean).map((item) => ({ ...item }))];
  }

  // A discussion's replies as HTML to follow its text, when they were asked for.
  const repliesTo = async (topicId) => (replies ? repliesHtml(get, canvas, api, topicId) : '');

  // A quiz's text, and the student's score when Canvas keeps one.
  async function quizScore(quiz) {
    try {
      return quizScoreHtml(quiz, (await get(`${api}/quizzes/${quiz.id}/submissions`)).data.quiz_submissions ?? []);
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      return '';
    }
  }

  async function moduleItem(it) {
    const locked = lockedReason(it.content_details);
    switch (it.type) {
      case 'File':
        if (!locked && fileInfo.has(it.content_id)) return [courseFileItem(it.content_id, fileInfo.get(it.content_id), it.title)];
        return [{ kind: 'file', id: it.content_id, title: it.title, fileName: it.content_details?.display_name ?? it.title, locked }];
      case 'ExternalUrl':
        return [{ kind: 'link', title: it.title, url: it.external_url }];
      case 'ExternalTool':
        return [{ kind: 'link', title: it.title, url: it.html_url }];
      default:
        if (!pageTypes.has(it.type) || !it.url) return [];
        // A whole-Canvas copy asks for a locked one's text too: Canvas often still gives it.
        if (locked && !everything) return [{ kind: 'page', title: it.title, html: '', locked }];
        try {
          const { data } = await get(it.url);
          const body = data.body ?? data.description ?? data.message ?? '';
          if (locked && !body.trim()) return [{ kind: 'page', title: it.title, html: '', locked }];
          const more = it.type === 'Discussion' ? await repliesTo(it.content_id) : it.type === 'Quiz' ? await quizScore(data) : '';
          return await pageWithFiles(it.title, body + more, data.attachments);
        } catch (e) {
          if (stopsTheRun(e)) throw e;
          return [{ kind: 'page', title: it.title, html: '', locked: locked || 'Not available' }];
        }
    }
  }

  // One assignment's latest submission. `body` is only the student's work on a
  // text entry: on a quiz Canvas fills it with a score summary.
  async function submissionSection(s) {
    const text = s.submission_type === 'online_text_entry' ? await pageWithFiles('Submitted text', s.body) : [];
    const link = s.submission_type === 'online_url' && s.url ? [{ kind: 'link', title: 'Submitted link', url: s.url }] : [];
    // The listing's download link is the one to keep: the link /api/v1/files/:id
    // gives for a submitted file did not download on RMIT's Canvas.
    const files = (s.attachments ?? []).map((a) => asFileItem(a));
    const annotated = everything && docs ? (await Promise.all((s.attachments ?? []).filter((a) => a.preview_url).map((a) => annotatedCopy(s, a)))).filter(Boolean) : [];
    const feedback = everything ? feedbackHtml(s) : '';
    const graded = feedback ? [{ kind: 'page', title: 'Grade and feedback', html: feedback }] : [];
    // What the student handed in before their last attempt.
    const earlier = [];
    for (const h of everything ? s.submission_history ?? [] : []) {
      if (!h.attempt || h.attempt === s.attempt) continue;
      const at = `Attempt ${h.attempt}`;
      if (h.submission_type === 'online_text_entry') earlier.push(...(await pageWithFiles(`${at} - submitted text`, h.body)));
      if (h.submission_type === 'online_url' && h.url) earlier.push({ kind: 'link', title: `${at} - submitted link`, url: h.url });
      for (const a of h.attachments ?? []) earlier.push(asFileItem(a, `${at} - ${a.display_name}`));
    }
    return { title: s.assignment?.name?.trim() || 'Assignment', items: [...text, ...link, ...files, ...annotated, ...graded, ...earlier] };
  }

  // The lecturer's notes on a submitted file, as a PDF to save beside it.
  // Its link is made when it is saved: a Canvadocs session lasts a day, an
  // export can continue later than that.
  async function annotatedCopy(s, a) {
    const name = `Annotated - ${a.display_name.replace(/\.[^.]+$/, '')}.pdf`;
    const item = { kind: 'file', id: `annotated:${a.id}`, title: name, fileName: name };
    try {
      if (!(await docs.annotations(a.preview_url))) return null;
      return { ...item, locked: '', details: { name, size: a.size ?? 0, url: '', locked: '', annotated: { course: Number(courseId), assignment: s.assignment_id, attachment: a.id } } };
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      await get('/api/v1/users/self'); // a viewer that would not open may mean the login ended: then this stops the run
      return { ...item, locked: 'Canvas did not show the lecturer\'s notes on it' };
    }
  }

  // Assignments, pages and discussions the lecturer never put in a module.
  async function foldersOutsideModules() {
    const inModules = new Set(moduleItems.flat().map((it) => `${it.type}:${it.page_url ?? it.content_id}`));
    const [assignments, pages, topics, quizzes] = await Promise.all([
      optional(`${api}/assignments?per_page=100`),
      optional(`${api}/pages?per_page=100`),
      optional(`${api}/discussion_topics?per_page=100`),
      optional(`${api}/quizzes?per_page=100`),
    ]);
    // A graded quiz is listed as an assignment too: kept as a quiz.
    const quizIds = new Set([...quizzes.map((q) => q.id), ...moduleItems.flat().filter((it) => it.type === 'Quiz').map((it) => it.content_id)]);
    // Locked with nothing given: reported. Canvas often still gives the text
    // of something locked by date (an assignment past its close): kept.
    const closed = (title, thing, body) => (lockedReason(thing) && !body?.trim() ? [{ kind: 'page', title, html: '', locked: lockedReason(thing) }] : null);
    const graded = new Set(topics.map((t) => t.assignment_id)); // a graded discussion is listed as both: kept as a discussion
    const pageItems = async (p) => {
      let body = '';
      try {
        body = (await get(`${api}/pages/${encodeURIComponent(p.url)}`)).data.body ?? '';
      } catch (e) {
        if (stopsTheRun(e)) throw e;
        if (!lockedReason(p)) return [{ kind: 'page', title: p.title, html: '', locked: 'Not available' }];
      }
      return closed(p.title, p, body) ?? pageWithFiles(p.title, body);
    };
    const folder = async (id, title, things, itemsOf) => ({ id, kind: 'other', title, sections: [{ title: null, items: (await Promise.all(things.map(itemsOf))).flat() }] });
    return Promise.all([
      folder('other-assignments', 'Other assignments', assignments.filter((a) => !inModules.has(`Assignment:${a.id}`) && !graded.has(a.id) && !quizIds.has(a.quiz_id)), (a) => closed(a.name, a, a.description) ?? pageWithFiles(a.name, a.description)),
      folder('other-quizzes', 'Other quizzes', quizzes.filter((q) => !inModules.has(`Quiz:${q.id}`)), async (q) => closed(q.title, q, q.description) ?? pageWithFiles(q.title, (q.description ?? '') + (await quizScore(q)))),
      folder('other-pages', 'Other pages', pages.filter((p) => !inModules.has(`Page:${p.url}`)), pageItems),
      folder('other-discussions', 'Other discussions', topics.filter((t) => !inModules.has(`Discussion:${t.id}`)), async (t) => closed(t.title, t, t.message) ?? pageWithFiles(t.title, (t.message ?? '') + (await repliesTo(t.id)), t.attachments)),
    ]);
  }

  let read = 0;
  const folders = await Promise.all(
    modules.map(async (m, k) => {
      const items = moduleItems[k];
      const resolved = await Promise.all(items.map((it) => (it.type === 'SubHeader' ? null : moduleItem(it))));
      const sections = [{ title: null, items: [] }];
      items.forEach((it, i) => {
        if (it.type === 'SubHeader') sections.push({ title: it.title.trim(), items: [] });
        else for (const item of resolved[i]) sections.at(-1).items.push(item); // no spread: a page can link 100k+ files
      });
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
  folders.push({ id: 'submissions', kind: 'submissions', title: 'My submissions', sections: await Promise.all(submissions.map(submissionSection)) });
  const grades = everything ? gradesHtml(total, submissions) : '';
  if (grades) folders.push({ id: 'grades', kind: 'grades', title: 'Grades', sections: [{ title: null, items: [{ kind: 'page', title: 'Grades', html: grades }] }] });
  if (everything) {
    folders.push(...(await foldersOutsideModules()));
    const placed = new Set(folders.flatMap((f) => f.sections.flatMap((s) => s.items.filter((i) => i.kind === 'file').map((i) => i.id))));
    folders.push({ id: 'other-files', kind: 'other', title: 'Other files', sections: [{ title: null, items: [...fileInfo].filter(([id]) => !placed.has(id)).map(([id, info]) => courseFileItem(id, info)) }] });
  }

  // Drop empty sections and folders; give every item an id unique in the course.
  const kept = [];
  for (const folder of folders) {
    folder.sections = folder.sections.filter((s) => s.items.length);
    if (!folder.sections.length) continue;
    let n = 0;
    for (const section of folder.sections) for (const item of section.items) item.key = `${folder.id}:${n++}`;
    kept.push(folder);
  }
  return { id: String(courseId), name: course.name, code: course.course_code ?? '', folders: kept };
}

// A student group's own space (a course's group sets give each group one):
// its files, by folder, its pages and its discussions.
export async function scanGroup(canvas, group, { replies = false } = {}) {
  const { get, getAll, optional } = reader(canvas);
  const api = `/api/v1/groups/${group.id}`;
  const [files, folders, pages, topics] = await Promise.all([
    optional(`${api}/files?per_page=100`),
    optional(`${api}/folders?per_page=100`),
    optional(`${api}/pages?per_page=100`),
    optional(`${api}/discussion_topics?per_page=100`),
  ]);
  const sections = new Map(); // folder path (null: the top) → items
  const add = (title, items) => {
    if (!sections.has(title)) sections.set(title, []);
    for (const item of items) sections.get(title).push(item);
  };
  const folderOf = new Map(folders.map((f) => [f.id, f.full_name.split('/').slice(1).join('/') || null])); // past "group files"
  for (const f of files) add(folderOf.get(f.folder_id) ?? null, [asFileItem(f)]);
  const text = async (title, url, field, more = '') => {
    try {
      const html = ((await get(url)).data[field] ?? '') + more;
      return html.trim() ? [{ kind: 'page', title, html }] : [];
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      return [{ kind: 'page', title, html: '', locked: 'Not available' }];
    }
  };
  add('Pages', (await Promise.all(pages.map((p) => text(p.title, `${api}/pages/${encodeURIComponent(p.url)}`, 'body')))).flat());
  const discussion = async (t) => {
    const html = (t.message ?? '') + (replies ? await repliesHtml(get, canvas, api, t.id) : '');
    return html.trim() ? [{ kind: 'page', title: t.title, html }] : [];
  };
  add('Discussions', (await Promise.all(topics.map(discussion))).flat());
  let n = 0;
  const kept = [...sections].filter(([, items]) => items.length).map(([title, items]) => ({ title, items }));
  for (const section of kept) for (const item of section.items) item.key = `group-${group.id}:${n++}`;
  return { id: `group-${group.id}`, kind: 'group', title: `Group - ${group.name.trim()}`, sections: kept };
}
