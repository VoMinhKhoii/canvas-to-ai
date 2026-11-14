// The side panel: finds the Canvas course tab, scans the course, keeps the
// selection, and runs Copy text for AI, Download and Save with pictures.
import { scanCourseInFull } from '../canvas/scan.js';
import { tabCanvas, canvasFiles } from '../canvas/tab-adapter.js';
import { scanOneDrive, ONEDRIVE_URL } from '../onedrive/scan.js';
import { oneDrive, oneDriveFiles } from '../onedrive/adapter.js';
import { createPackBuilder } from '../pack/build.js';
import { safe, pathAllocator } from '../pack/names.js';
import { createSelection } from './selection.js';
import { limiter } from '../limit.js';
import { htmlToMd } from '../pack/formats/html-to-md.js';
import { folderCards, folderCard, pickedLine, loadingCards, termsCard, ownSiteForm, esc } from './view.js';
import { exportFlow } from './export-panel.js';
import { findCanvasTab, siteOrigin, allowSite } from './sites.js';

const $ = (id) => document.getElementById(id);
const COURSE_ID = /^\/courses\/(\d+)/;
const COPY_LABEL = 'Copy text for AI';
// Chrome saves files itself (chrome.downloads); Safari has no downloads API.
const SAVES_FILES = Boolean(chrome.downloads);
const SAFARI_SITES = '<br><br>If it is open: in Safari, allow Canvas to AI on your Canvas site (Safari › Settings › Extensions › Canvas to AI › Edit Websites).';
// OneDrive and Teams (SharePoint): an optional permission, asked for from ⋯ › OneDrive and Teams.
// Wildcards only: sites.js counts an exact-origin grant as a Canvas site.
// "*.teams.microsoft.com" also matches teams.microsoft.com itself.
const SHAREPOINT_TABS = ['https://*.sharepoint.com/*'];
const SHAREPOINT = { origins: [...SHAREPOINT_TABS, 'https://*.teams.microsoft.com/*', 'https://*.teams.cloud.microsoft/*'] };
const TEAMS_URL = /^https:\/\/([^/]+\.)?teams\.(microsoft\.com|cloud\.microsoft)\//;
const TEAMS_HINT = 'Teams keeps a class\'s files in SharePoint, where Canvas to AI reads them. In Teams, open the class channel, then <b>Files › Open in SharePoint</b>, and press <b>Scan again</b> in that tab.<br><br>For lecture recordings and files people shared with you, open your <b>OneDrive</b> and press <b>Scan again</b>.';
const ONEDRIVE_HINT = 'Open your OneDrive in a tab for lecture recordings and files people shared with you, then press <b>Scan again</b>.<br><br>Teams keeps a class\'s files in SharePoint: in Teams, open the channel, then <b>Files › Open in SharePoint</b>, and press <b>Scan again</b>.';
const CLOSED_COURSE = 'Canvas only lets students in this course read it. You may see its syllabus, but its modules and files are closed. If the course has a <b>Join this Course</b> button, join and scan again.';

// pdf.js and a canvas to render picture pages, loaded on the first PDF.
const pdf = {
  async load() {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
    return lib;
  },
  async renderPage(page) {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1280 / base.width) });
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    await page.render({ canvas, viewport }).promise;
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75)); // null if the canvas is too big
  },
};

const state = { course: null, sel: null, open: new Set(), files: null, packs: null, busy: false, pack: null };

// The tab to read: the active tab if it is a Canvas course, a SharePoint page
// (OneDrive, Teams files) or Teams, else the most recently used Canvas course
// or SharePoint tab. Chrome shows the extension a SharePoint or Teams tab's
// address only once the student allowed OneDrive and Teams. oneDrive:
// SharePoint and Teams tabs only. Safari has no lastAccessed: a tab shown in a
// window comes first.
async function findTab({ oneDrive = false } = {}) {
  const course = oneDrive ? null : await findCanvasTab(COURSE_ID); // also lets its site serve downloads (sites.js)
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && (active.id === course?.id || ONEDRIVE_URL.test(active.url || '') || TEAMS_URL.test(active.url || ''))) return active;
  const sharepoint = await chrome.tabs.query({ url: SHAREPOINT_TABS });
  return [course, ...sharepoint].filter(Boolean).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.active - a.active)[0];
}

// The school's own Canvas address, typed into ownSiteForm().
function askForOwnSite() {
  $('own-site').addEventListener('submit', async (e) => {
    e.preventDefault();
    const origin = siteOrigin($('own-site-url').value);
    if (!origin) return ($('own-site-note').textContent = 'Type the address you see in your Canvas tab, like canvas.school.edu.');
    try {
      await allowSite(origin); // Chrome's prompt: the first thing the click does
      scan();
    } catch (err) {
      $('own-site-note').textContent = err.message;
    }
  });
}

function setStatus(html, tone = '') {
  $('status').innerHTML = html;
  $('status').dataset.tone = tone;
}

function message(html) {
  $('folders').innerHTML = `<p class="message">${html}</p>`;
}

// Terms: shown before anything is read from Canvas, and from ⋯ › AI use and
// terms. Agreeing is remembered in localStorage when it is available.
const TERMS_KEY = 'canvas-to-ai:terms'; // the version of the terms the student agreed to
const TERMS_VERSION = '2';
let agreedNow = false;
function agreed() {
  try {
    return agreedNow || localStorage.getItem(TERMS_KEY) === TERMS_VERSION;
  } catch {
    return agreedNow;
  }
}
function showTerms() {
  $('folders').innerHTML = termsCard(state.course ? 'Back to the course' : 'I understand');
  $('agree').addEventListener('click', () => {
    agreedNow = true;
    try {
      localStorage.setItem(TERMS_KEY, TERMS_VERSION);
    } catch {}
    if (state.course) $('folders').innerHTML = folderCards(state.course, state.sel, state.open);
    else scan();
  });
}

async function scan({ oneDrive = false } = {}) {
  if (state.busy) return;
  if (!agreed()) return showTerms(); // nothing is read from Canvas before that
  state.busy = true;
  updateBar();
  $('folders').innerHTML = loadingCards();
  // The old course's cards are gone: its selection and pack go with them.
  Object.assign(state, { course: null, sel: null, open: new Set(), packs: null });
  forgetPack();
  try {
    const tab = await findTab({ oneDrive });
    if (ONEDRIVE_URL.test(tab?.url || '')) return await scanSharePoint(tab);
    if (TEAMS_URL.test(tab?.url || '')) {
      $('course').textContent = 'OneDrive and Teams';
      $('code').textContent = '';
      return message(TEAMS_HINT);
    }
    if (!tab) {
      $('course').textContent = oneDrive ? 'OneDrive and Teams' : 'Canvas to AI';
      $('code').textContent = '';
      // Safari shows an extension a tab's address only on websites the student allowed it on.
      // Safari keeps its own list of allowed websites (SAFARI_SITES).
      message(oneDrive ? ONEDRIVE_HINT : `Open a course in Canvas, then press <b>Scan again</b>. For OneDrive and Teams, use <b>⋯ › OneDrive and Teams</b>.${SAVES_FILES ? '' : SAFARI_SITES}`);
      if (SAVES_FILES && !oneDrive) {
        $('folders').insertAdjacentHTML('beforeend', ownSiteForm());
        askForOwnSite();
      }
      return;
    }
    const canvas = await tabCanvas(tab.id);
    const course = await scanCourseInFull(canvas, Number(COURSE_ID.exec(new URL(tab.url).pathname)[1]), { onProgress: (text) => setStatus(text) });
    show(course, canvasFiles(canvas));
  } catch (e) {
    // 403: logged in, but the course is open to its own students only (a
    // course in All Courses may still show visitors its syllabus).
    const why = e.status === 403 ? CLOSED_COURSE : esc(e.message); // error text can quote what Canvas sent: never markup
    message(`${why}<br><button class="text-button" id="retry">Try again</button>`);
    $('retry')?.addEventListener('click', scan);
  } finally {
    state.busy = false;
    updateBar();
  }
}

function show(course, files) {
  Object.assign(state, { course, sel: createSelection(course), open: new Set(), files, packs: createPackBuilder({ files, pdf }), pack: null });
  $('course').textContent = course.name;
  $('code').textContent = course.code;
  $('folders').innerHTML = folderCards(course, state.sel, state.open);
  // Download all of Canvas is for Canvas only. Downloading all of OneDrive
  // would take every lecture video (gigabytes): pick what to download there.
  for (const action of ['all', 'course']) menu.querySelector(`[data-action="${action}"]`)?.toggleAttribute('hidden', course.root === 'OneDrive');
  setStatus('');
}

// A SharePoint tab: OneDrive, or a Teams channel's files opened in SharePoint.
async function scanSharePoint(tab) {
  $('course').textContent = 'OneDrive and Teams';
  $('code').textContent = new URL(tab.url).hostname;
  const od = oneDrive();
  show(await scanOneDrive(od, tab.url, { onProgress: (text) => setStatus(text) }), oneDriveFiles(od));
}

function redraw(folderId) {
  const folder = state.course.folders.find((f) => f.id === folderId);
  document.querySelector(`.card[data-folder="${CSS.escape(folderId)}"]`).outerHTML = folderCard(folder, state.sel, state.open.has(folderId));
}

function updateBar() {
  const n = state.sel?.count() ?? 0;
  $('copy').disabled = state.busy || !n;
  $('more').disabled = state.busy;
  for (const item of $('menu').querySelectorAll('[data-needs]')) item.disabled = item.dataset.needs === 'picks' ? !n : !state.course;
  if (!state.busy) setStatus(state.sel ? pickedLine(state.sel) : '');
}

// A new selection needs a new pack ("Click to copy" was for the old one).
function forgetPack() {
  state.pack = null;
  $('copy').textContent = COPY_LABEL;
}

$('folders').addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) {
    const id = opener.dataset.open;
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    redraw(id);
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick && state.sel && !state.busy) {
    state.sel.toggle(pick.dataset.pick);
    forgetPack();
    redraw(pick.closest('.card').dataset.folder);
    updateBar();
    document.querySelector(`[data-pick="${CSS.escape(pick.dataset.pick)}"]`)?.focus();
  }
});
$('folders').addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('.item[data-pick]')) {
    e.preventDefault();
    e.target.click();
  }
});

// The pack for the current selection, built once per selection.
async function currentPack() {
  if (state.pack) return state.pack;
  state.busy = true;
  updateBar();
  const label = $('copy').textContent;
  try {
    $('progress').hidden = false;
    state.pack = await state.packs.build(state.course, state.sel.picked(), ({ done, total }) => {
      $('copy').textContent = `Preparing ${done} of ${total}…`;
      $('progress').style.transform = `scaleX(${done / total})`;
    });
    return state.pack;
  } finally {
    $('copy').textContent = label;
    $('progress').hidden = true; // gone at once: a fading bar reads as still working
    $('progress').style.transform = 'scaleX(0)';
    state.busy = false;
    updateBar();
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The panel can lose focus during a long conversion; fall back to execCommand.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function afterCopyLine(pack) {
  const n = pack.images.length;
  const lines = [n ? 'Copied the text. Paste it into ChatGPT, Claude or Gemini.' : 'Copied. Paste it into ChatGPT, Claude or Gemini.'];
  if (n) lines.push(`${n} ${n === 1 ? "picture isn't" : "pictures aren't"} in it: to send ${n === 1 ? 'it' : 'them'} too, use <b>⋯ › Save with pictures</b>.`);
  if (pack.skipped.length) lines.push(`${pack.skipped.length} left out (the end of the text says why).`);
  // About 4 characters a token, 650 tokens a page. Past ~120k tokens most AI
  // chats cut the text off or answer from only part of it.
  const pages = Math.round(pack.markdown.length / 4 / 650);
  if (pages > 180) lines.unshift(`<span class="warn">That's very long, about ${pages.toLocaleString('en')} pages. AI chats may read only part of it: pick fewer weeks for better answers.</span>`);
  return lines.join('<br>');
}

$('copy').addEventListener('click', async () => {
  try {
    const pack = await currentPack();
    if (await writeClipboard(pack.markdown)) {
      $('copy').textContent = 'Copied';
      setStatus(afterCopyLine(pack), 'done');
      setTimeout(() => ($('copy').textContent = COPY_LABEL), 2500);
    } else {
      $('copy').textContent = 'Click to copy';
      setStatus('Ready. Click once more to copy.');
    }
  } catch (e) {
    setStatus(`Couldn't prepare it: ${esc(e.message)}`, 'error');
  }
});

// ⋯ menu
const menu = $('menu');
const closeMenu = () => {
  menu.hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
};
$('more').addEventListener('click', () => {
  menu.hidden = !menu.hidden;
  $('more').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => !e.target.closest('#menu, #more') && closeMenu());

// Downloads keep the course's tree as Canvas shows it:
// Canvas/<course>/<NN module>/<section>/<file>, pages as Markdown beside the files.
const rootOf = (course) => course.root ?? 'Canvas';
const folderDir = (course, folder) => `${rootOf(course)}/${safe(course.name)}/${String(course.folders.indexOf(folder) + 1).padStart(2, '0')} ${safe(folder.title.replace(/\s*\/\s*/g, ' - '))}`; // "Week 1/Topic 1" → "Week 1 - Topic 1"
// A file already there is never replaced (it may be the student's own edit, or
// another course of the same name): Chrome adds " (1)" to the new one.
const download = (url, filename) => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
const LOOKUPS = 6; // as the scan: well under Canvas's rate limit
const MAX_ZIP = 500 * 1024 * 1024; // Safari's zip is built in memory

// Where a download's files go. Chrome saves each one into Downloads, in its
// folders. Safari has no downloads API: there the same tree goes into one zip,
// saved to Downloads as <zipName> by save(), up to MAX_ZIP.
async function saver(files, zipName) {
  if (SAVES_FILES) {
    return { fits: () => true, add: (path, src) => download(typeof src === 'string' ? src : URL.createObjectURL(src), path), save: async () => {}, where: (dir) => `Downloads › ${dir}` };
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  let bytes = 0;
  return {
    fits: (size) => bytes + size <= MAX_ZIP,
    async add(path, src) {
      const data = typeof src === 'string' ? await files.bytes(src) : src; // a Canvas download link, or a Blob
      bytes += data.byteLength ?? data.size;
      zip.file(path, data);
    },
    async save() {
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); // files are mostly compressed already
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: zipName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    },
    where: () => `Downloads › ${zipName}`,
  };
}

async function downloadTree(course, files, packs, entries) {
  const out = await saver(files, `${rootOf(course)} - ${safe(course.name)}.zip`);
  const wanted = entries.filter(({ item }) => !item.locked && item.kind !== 'link');
  const place = pathAllocator(); // files and pages share the folders: no name is used twice
  let saved = 0;
  let pages = 0;
  let locked = 0;
  let tooBig = 0;
  // Download links are looked up ahead, LOOKUPS at a time; files are still
  // handed to Chrome (which fetches several at once) in the course's order.
  const limit = limiter(LOOKUPS);
  const jobs = wanted.map((entry) => ({ ...entry, lookup: entry.item.kind === 'page' ? null : limit(() => packs.meta(entry.item)).catch(() => null) }));
  for (const [n, { folder, section, item, lookup }] of jobs.entries()) {
    setStatus(`Downloading ${n + 1} of ${wanted.length}…`);
    const dir = [folderDir(course, folder), section.title && safe(section.title)].filter(Boolean).join('/');
    if (item.kind === 'page') {
      const path = place(dir, `${safe(item.title)}.md`, `page:${item.key}`);
      const md = `# ${item.title}\n\n${htmlToMd(item.html)}\n`;
      await out.add(path, new Blob([md], { type: 'text/markdown' }));
      pages++;
      continue;
    }
    const info = await lookup;
    if (!info?.url || info.locked) {
      locked++;
      continue;
    }
    if (!out.fits(info.size)) {
      tooBig++;
      continue;
    }
    const path = place(dir, safe(info.name), `file:${item.id}`);
    if (!path) continue; // the same file twice in one folder
    await out.add(path, info.url);
    saved++;
  }
  if (!SAVES_FILES && (saved || pages)) {
    setStatus('Saving the zip…');
    await out.save();
  }
  const skipped = entries.length - wanted.length;
  setStatus(
    `${SAVES_FILES ? 'Downloading' : 'Saved'} ${saved} ${saved === 1 ? 'file' : 'files'}${pages ? ` and ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''} to ${esc(out.where(`${rootOf(course)} › ${safe(course.name)}`))}.` +
      (locked ? ` ${locked} ${locked === 1 ? 'is' : 'are'} locked.` : '') +
      (tooBig ? ` ${tooBig} ${tooBig === 1 ? 'was' : 'were'} left out: the zip stops at ${MAX_ZIP / 1024 / 1024} MB, so download fewer weeks at a time.` : '') +
      (skipped ? ` ${skipped} ${skipped === 1 ? 'link or locked item was' : 'links or locked items were'} skipped.` : ''),
    'done',
  );
}

// The ⋯ menu's actions. A scan can start while one runs: each keeps the
// course it began with.
const downloadPicked = ({ course, files, packs, sel }) => downloadTree(course, files, packs, sel.picked());
const downloadCourse = ({ course, files, packs, sel }) => downloadTree(course, files, packs, sel.all());

async function saveWithPictures({ course, files }) {
  const pack = await currentPack();
  const folder = `${rootOf(course)}/${safe(course.name)} - for AI`;
  const out = await saver(files, `${rootOf(course)} - ${safe(course.name)} - for AI.zip`);
  await out.add(`${folder}/course.md`, new Blob([pack.markdown], { type: 'text/markdown' }));
  for (const img of pack.images) await out.add(`${folder}/images/${img.name}`, img.url ?? img.blob);
  await out.save();
  setStatus(`Saved to ${esc(out.where(folder.replace('/', ' › ')))}. ${SAVES_FILES ? '' : 'Open the zip, then '}Drag <b>course.md</b> and the <b>images</b> folder into the chat.`, 'done');
}

function clearPicks({ course, sel }) {
  sel.clear();
  forgetPack();
  $('folders').innerHTML = folderCards(course, sel, state.open);
  updateBar();
}

const openExport = exportFlow({
  area: $('folders'),
  bar: $('progress'),
  setBusy(busy) {
    state.busy = busy;
    updateBar();
  },
  close: () => (state.course ? ($('folders').innerHTML = folderCards(state.course, state.sel, state.open)) : scan()),
});
// ⋯ › OneDrive and Teams: Chrome asks the student, once, to let the extension
// read SharePoint (it must be asked from the click itself, before any wait).
async function openOneDrive() {
  if (!(await chrome.permissions.request(SHAREPOINT))) return setStatus('OneDrive and Teams need that permission. Nothing was read.');
  await scan({ oneDrive: true });
}
const downloadAll = () => (agreed() ? openExport() : showTerms());
if (!SAVES_FILES) menu.querySelector('[data-action="all"]').remove(); // Chrome first: Safari would need its own zip handling

const ACTIONS = { onedrive: openOneDrive, picked: downloadPicked, course: downloadCourse, all: downloadAll, save: saveWithPictures, clear: clearPicks, terms: showTerms };
menu.addEventListener('click', async (e) => {
  const action = ACTIONS[e.target.closest('[data-action]')?.dataset.action];
  if (!action) return;
  closeMenu();
  try {
    await action({ ...state });
  } catch (err) {
    setStatus(`That didn't work: ${esc(err.message)}`, 'error');
  }
});

$('rescan').addEventListener('click', scan);
scan();
