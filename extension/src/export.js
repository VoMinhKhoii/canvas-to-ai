// The Export (see CONTEXT.md): every course a student picks, one folder each.
//
//   const courses = await listCourses(canvas);
//   const plan = await planExport(canvas, files, courses, options); // nothing saved yet: sizes are known first
//   const result = await runExport(plan, { save, done, signal, onProgress });
//
// Built to stay light on the student's computer. Courses are read one at a
// time and only small records are kept. No zip and no file ever sits in
// memory: the browser writes each file to disk itself, a few at a time.
import { scanCourse, scanGroup } from './canvas/scan.js';
import { readMessages } from './canvas/talk.js';
import { stopsTheRun, stopReason } from './canvas/stops.js';
import { readAll } from './canvas/read.js';
import { htmlToMd } from './pack/formats/html-to-md.js';
import { losesText, pdfSize } from './pack/page-shown.js';
import { pathAllocator, safe } from './pack/names.js';

export const BIG_FILE = 200 * 1024 * 1024;
const PARALLEL_SAVES = 3;
const MAX_FILE_NAME = 80; // folders are capped too: paths have a limit on Windows

// At most `max` characters, never half of one (𝐍 is two UTF-16 units: half
// of it is not a valid name), and few enough bytes for the disk: a name of
// 4-byte letters runs past the 255 bytes macOS allows long before 80 of them.
const utf8 = new TextEncoder();
function cut(s, max) {
  const chars = [...s].slice(0, max);
  while (utf8.encode(chars.join('')).length > max * 2.5) chars.pop();
  return chars.join('');
}
const part = (s, max) => safe(cut(s.replace(/\s*\/\s*/g, ' - '), max));
function fileName(name) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 10;
  const ext = hasExt ? name.slice(dot) : ''; // kept whole: cutting the name to length would cut it off
  return safe(cut(hasExt ? name.slice(0, dot) : name, MAX_FILE_NAME - ext.length) + ext); // the whole name: "desktop.ini" is refused, "desktop" is not
}

// The courses the student is or was enrolled in, current ones first. Canvas
// gives a course closed by date without a name: there is nothing to read.
export async function listCourses(canvas) {
  const read = (state) => readAll(canvas.get, `/api/v1/courses?enrollment_state=${state}&include[]=term&per_page=100`);
  const [current, past] = await Promise.all([read('active'), read('completed')]);
  const courses = new Map();
  for (const [list, isPast] of [[current, false], [past, true]]) {
    for (const c of list) {
      if (c.name && !courses.has(c.id)) courses.set(c.id, { id: c.id, name: c.name, code: c.course_code ?? '', term: c.term?.name ?? '', past: isPast });
    }
  }
  return [...courses.values()];
}

// One folder name per course; two courses of the same name get their ids.
function courseDirs(courses) {
  const base = (c) => part(c.name, 60);
  const count = new Map();
  for (const c of courses) count.set(base(c).toLowerCase(), (count.get(base(c).toLowerCase()) ?? 0) + 1);
  return new Map(courses.map((c) => [c.id, count.get(base(c).toLowerCase()) > 1 ? `${base(c)} (${c.id})` : base(c)]));
}

// otherCourses: the student's courses not picked. Their messages wait for
// them: they belong in those courses' folders, not in Other messages.
// A check that stopped need not start over: `known` holds what an earlier
// one already read ({ inbox, groups, courses: { id: part } }), and
// keep(key, value) is told each part as it is read ('inbox', 'groups',
// 'course:<id>'). docs: Canvadocs, for lecturers' notes on submitted files.
export async function planExport(canvas, files, courses, { messages = false, replies = false, otherCourses = [], docs = null, known = {}, keep = () => {}, signal, onProgress = () => {} } = {}) {
  const place = pathAllocator();
  const entries = [];
  const notSaved = [];
  const dirs = courseDirs(courses);
  let pageNo = 0;

  // Everything one folder of a course (or of the inbox) becomes.
  async function folderParts(dir, label, folders) {
    const entries = [];
    const notSaved = [];
    const links = [];
    const details = (item) => {
      if (item.kind !== 'file' || item.locked) return null;
      if (item.details) return Promise.resolve(item.details);
      const lookup = files.meta(item.id).catch((e) => (stopsTheRun(e) ? Promise.reject(e) : null));
      lookup.catch(() => {}); // awaited below, unless an earlier one already ended the run
      return lookup;
    };
    const jobs = folders.flatMap((folder, f) => folder.sections.flatMap((section) => section.items.map((item) => ({
      item,
      folder,
      dir: [`${dir}/${String(f + 1).padStart(2, '0')} ${part(folder.title, 50)}`, section.title && part(section.title, 40)].filter(Boolean).join('/'),
      info: details(item),
    }))));
    for (const { item, folder, dir: at, info } of jobs) {
      const title = `${label} › ${item.title}`;
      if (item.kind === 'link') links.push(`- ${folder.title}: [${item.title}](${item.url})`);
      else if (item.locked) notSaved.push({ title, reason: item.locked });
      else if (item.kind === 'page') {
        // An export is kept to be read: its pages are PDFs, made as they are
        // saved. One with text the PDF's font cannot draw stays Markdown.
        const html = item.html ?? '';
        const asPdf = !losesText(item.title, html);
        const path = place(at, `${fileName(item.title)}.${asPdf ? 'pdf' : 'md'}`, `page:${pageNo++}`);
        const md = asPdf ? null : `# ${item.title}\n\n${htmlToMd(html)}\n`;
        entries.push(asPdf ? { path, page: { title: item.title, html }, size: pdfSize(html), title } : { path, md, size: md.length, title });
      } else {
        const meta = await info;
        if (!(meta?.url || meta?.annotated) || meta.locked) {
          notSaved.push({ title, reason: meta?.locked || 'Not available' });
          continue;
        }
        const path = place(at, fileName(meta.name), `file:${item.id}`);
        // An annotated copy has no link yet: it is made when the copy is saved.
        if (path) entries.push({ path, ...(meta.annotated ? { annotated: meta.annotated } : { url: meta.url }), size: meta.size, title });
      }
    }
    if (links.length) {
      const md = `# Links\n\n${links.join('\n')}\n`;
      entries.push({ path: `${dir}/Links.md`, md, size: md.length, title: `${label} › Links` });
    }
    return { entries, notSaved };
  }
  const add = (part) => {
    for (const e of part.entries) entries.push(e); // no spread: a course can have tens of thousands
    for (const n of part.notSaved) notSaved.push(n);
  };

  // The inbox first: each conversation then goes in its course's folder.
  const inbox = new Map(); // context code → sections
  if (messages) {
    let read = known.inbox;
    if (!read) {
      onProgress('Reading your messages…');
      read = await readMessages(canvas, (n, total) => onProgress(`Reading your messages… ${n} of ${total}`));
      await keep('inbox', read);
    }
    for (const { context, section } of read) {
      if (!inbox.has(context)) inbox.set(context, []);
      inbox.get(context).push(section);
    }
  }
  const messageFolder = (sections) => ({ id: 'messages', kind: 'messages', title: 'Messages', sections });

  // A listing the export can do without: what was read before a failure is
  // kept and the run goes on, unless the failure stops the run.
  async function listing(url) {
    const out = [];
    try {
      for (let next = url; next; ) {
        const page = await canvas.get(next);
        out.push(...page.data);
        next = page.next;
      }
    } catch (e) {
      if (stopsTheRun(e)) throw e;
    }
    return out;
  }

  // Each course's total, from the student's enrollments: one listing for all
  // (none when every course was read before).
  onProgress('Reading your grades and groups…');
  const enrollments = courses.some((c) => !known.courses?.[c.id]) ? await listing('/api/v1/users/self/enrollments?type[]=StudentEnrollment&state[]=active&state[]=completed&per_page=100') : [];
  const totals = new Map(enrollments.filter((e) => e.grades).map((e) => [e.course_id, e.grades]));

  // The student's groups: each one's space goes in its course's folder.
  let groups = known.groups;
  if (!groups) {
    groups = await listing('/api/v1/users/self/groups?per_page=100');
    await keep('groups', groups);
  }
  const groupFolders = async (list) => (await Promise.all(list.map((g) => scanGroup(canvas, g, { replies })))).filter((f) => f.sections.length);

  const failed = new Set(); // courses Canvas would not give: their messages and groups go in Other messages / Other groups
  for (const [n, c] of courses.entries()) {
    if (signal?.aborted) break;
    const sections = inbox.get(`course_${c.id}`);
    if (known.courses?.[c.id]) {
      inbox.delete(`course_${c.id}`);
      add(known.courses[c.id]);
      continue;
    }
    const name = (text) => onProgress(`Course ${n + 1} of ${courses.length}: ${text}`);
    name(c.name);
    try {
      const course = await scanCourse(canvas, c.id, { everything: true, replies, total: totals.get(c.id), docs, onProgress: name });
      const ofCourse = await groupFolders(groups.filter((g) => g.course_id === c.id));
      const part = await folderParts(dirs.get(c.id), c.name, [...course.folders, ...ofCourse, ...(sections ? [messageFolder(sections)] : [])]);
      if (signal?.aborted) break; // a course read halfway is not kept
      await keep(`course:${c.id}`, part);
      add(part);
      inbox.delete(`course_${c.id}`);
    } catch (e) {
      if (stopsTheRun(e)) throw e; // the rest would fail too: the student should know now
      await canvas.get('/api/v1/users/self'); // throws if the login or the tab is gone: stop, don't fail every course left
      notSaved.push({ title: c.name, reason: e.status === 403 ? 'This course is closed to you' : e.message });
      failed.add(c.id);
    }
  }
  // What belongs to a course not picked waits for that course; the report says so.
  const waiting = [];
  for (const c of otherCourses) {
    const talks = inbox.get(`course_${c.id}`)?.length ?? 0;
    const spaces = groups.filter((g) => g.course_id === c.id).length;
    inbox.delete(`course_${c.id}`);
    const what = [talks && `${talks} inbox conversation${talks === 1 ? '' : 's'}`, spaces && `${spaces} group space${spaces === 1 ? '' : 's'}`].filter(Boolean);
    if (what.length) waiting.push({ title: c.name, reason: `${what.join(' and ')}, saved when you download that course` });
  }
  const others = [...inbox.values()].flat();
  if (others.length && !signal?.aborted) add(await folderParts('Other messages', 'Other messages', [messageFolder(others)]));
  // Groups of no listed course (a student club, a course Canvas no longer names) or of a course Canvas would not give.
  const listed = new Set([...courses, ...otherCourses].map((c) => c.id));
  const loose = signal?.aborted ? [] : await groupFolders(groups.filter((g) => !listed.has(g.course_id) || failed.has(g.course_id)));
  if (loose.length) add(await folderParts('Other groups', 'Other groups', loose));
  return { entries, notSaved, waiting };
}

export const planTotals = ({ entries }) => {
  const big = entries.filter((e) => e.size > BIG_FILE);
  return {
    files: entries.filter((e) => e.url || e.annotated).length,
    pages: entries.filter((e) => e.page || e.md !== undefined).length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    bigFiles: big.length,
    bigBytes: big.reduce((n, e) => n + e.size, 0),
  };
};

function report({ notSaved, waiting = [] }, leftOut, failed) {
  const list = (title, rows) => (rows.length ? [`## ${title}`, '', ...rows.map((r) => `- ${r.title}: ${r.reason}`), ''] : []);
  const rows = [
    ...list('Could not be saved', failed),
    ...list('Left out: over 200 MB', leftOut.map((e) => ({ title: e.title, reason: `${Math.round(e.size / 1048576)} MB` }))),
    ...list('Canvas would not give these', notSaved),
    ...list('Kept for courses you did not pick', waiting),
  ];
  return ['# Canvas export', '', ...(rows.length ? rows : ['Everything was saved.', ''])].join('\n');
}

// save(entry) resolves once the entry is on disk; a rejection with `fatal`
// (the disk is full) or one that stops the run (stops.js) ends the run. done: paths already saved, added to as it
// goes, so a stopped export can continue where it left off.
export async function runExport(plan, { save, done, signal, big = false, onProgress = () => {} }) {
  const leftOut = big ? [] : plan.entries.filter((e) => e.size > BIG_FILE);
  const todo = plan.entries.filter((e) => !done.has(e.path) && (big || e.size <= BIG_FILE));
  let finished = 0;
  let fatal = null;
  // Saves `entries`, a few at a time; resolves to those that failed.
  async function pass(entries) {
    const missed = [];
    let next = 0;
    async function worker() {
      while (next < entries.length && !fatal && !signal?.aborted) {
        const entry = entries[next++];
        try {
          await save(entry);
          done.add(entry.path);
        } catch (e) {
          if (signal?.aborted) break; // Stop: nothing failed
          // The disk full, or Canvas gone for every entry left (the login
          // ended, no connection): stop, to continue later.
          if (e.fatal || stopsTheRun(e)) fatal ??= e.fatal ? e : Object.assign(new Error(stopReason(e)), { fatal: true });
          else missed.push({ entry, reason: e.message });
        }
        onProgress(++finished, todo.length);
      }
    }
    await Promise.all(Array.from({ length: PARALLEL_SAVES }, worker));
    return missed;
  }
  let missed = await pass(todo);
  // One more go at what failed: a file server that dropped connections for a
  // few minutes midway has usually recovered by the end.
  if (missed.length && !fatal && !signal?.aborted) {
    finished -= missed.length; // counted again as they are tried again
    missed = await pass(missed.map((m) => m.entry));
  }
  const failed = missed.map((m) => ({ title: m.entry.title, reason: m.reason }));
  const stopped = Boolean(signal?.aborted || fatal);
  if (!stopped) {
    const md = report(plan, leftOut, failed);
    await save({ path: 'Export report.md', md, size: md.length, title: 'Export report' }).catch(() => {}); // the files are saved either way
  }
  return { stopped, fatal, failed, leftOut, saved: done.size };
}
