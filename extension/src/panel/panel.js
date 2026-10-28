// The side panel: finds the Canvas course tab, scans the course, keeps the
// selection, and runs Copy for AI, Download and Save with pictures.
import { scanCourse } from '../canvas/scan.js';
import { tabCanvas, canvasFiles } from '../canvas/tab-adapter.js';
import { createPackBuilder } from '../pack/build.js';
import { safe } from '../pack/names.js';
import { createSelection } from './selection.js';
import { folderCards, oneCard, pickedLine, loadingCards, folderName } from './view.js';

const $ = (id) => document.getElementById(id);
const COURSE_URL = /^https:\/\/[^/]+\.instructure\.com\/courses\/(\d+)/;

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

const state = { course: null, sel: null, open: new Set(), packs: null, busy: false, pack: null };

// The course tab: the active tab if it is a Canvas course, else the most recently used one.
async function findCourseTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (COURSE_URL.test(active?.url || '')) return active;
  const tabs = await chrome.tabs.query({ url: 'https://*.instructure.com/courses/*' });
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function setStatus(html, tone = '') {
  $('status').innerHTML = html;
  $('status').dataset.tone = tone;
}

function message(html) {
  $('folders').innerHTML = `<p class="message">${html}</p>`;
}

async function scan() {
  if (state.busy) return;
  state.busy = true;
  updateBar();
  $('folders').innerHTML = loadingCards();
  // The old course's cards are gone: its selection and pack go with them.
  Object.assign(state, { course: null, sel: null, open: new Set(), packs: null });
  forgetPack();
  try {
    const tab = await findCourseTab();
    if (!tab) {
      $('course').textContent = 'Canvas to AI';
      $('code').textContent = '';
      message('Open a course in Canvas, then press <b>Scan again</b>.');
      return;
    }
    const canvas = await tabCanvas(tab.id);
    const course = await scanCourse(canvas, COURSE_URL.exec(tab.url)[1], { onProgress: (text) => setStatus(text) });
    Object.assign(state, { course, sel: createSelection(course), open: new Set(), packs: createPackBuilder({ files: canvasFiles(canvas), pdf }), pack: null });
    $('course').textContent = course.name;
    $('code').textContent = course.code;
    $('folders').innerHTML = folderCards(course, state.sel, state.open);
    setStatus('');
  } catch (e) {
    message(`${e.message}<br><button class="text-button" id="retry">Try again</button>`);
    $('retry')?.addEventListener('click', scan);
  } finally {
    state.busy = false;
    updateBar();
  }
}

function redraw(folderId) {
  const folder = state.course.folders.find((f) => f.id === folderId);
  document.querySelector(`.card[data-folder="${CSS.escape(folderId)}"]`).outerHTML = oneCard(folder, state.sel, state.open.has(folderId));
}

function updateBar() {
  const n = state.sel?.count() ?? 0;
  $('copy').disabled = state.busy || !n;
  $('more').disabled = state.busy || !n;
  if (!state.busy) setStatus(state.sel ? pickedLine(state.sel) : '');
}

// A new selection needs a new pack ("Click to copy" was for the old one).
function forgetPack() {
  state.pack = null;
  $('copy').textContent = 'Copy for AI';
}

// The card a node (folder, section or item) belongs to.
const folderOf = (id) => id.split(/[#:]/)[0];

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
    redraw(folderOf(pick.dataset.pick));
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
  const lines = ['Copied. Paste it into ChatGPT, Claude or Gemini.'];
  if (pack.images.length) lines.push(`${pack.images.length} ${pack.images.length === 1 ? 'picture needs' : 'pictures need'} <b>⋯ › Save with pictures</b>.`);
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
      setTimeout(() => ($('copy').textContent = 'Copy for AI'), 2500);
    } else {
      $('copy').textContent = 'Click to copy';
      setStatus('Ready. Click once more to copy.');
    }
  } catch (e) {
    setStatus(`Couldn't prepare it: ${e.message}`, 'error');
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

const folderPath = (folder) => `Canvas/${safe(state.course.name)}/${String(state.course.folders.indexOf(folder) + 1).padStart(2, '0')} ${safe(folderName(folder.title).name)}`;
const download = (url, filename) => chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });

menu.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  closeMenu();
  try {
    if (action === 'download') {
      const files = state.sel.picked().filter(({ item }) => item.kind === 'file' && !item.locked);
      let started = 0;
      for (const { folder, item } of files) {
        const info = await state.packs.meta(item.id);
        if (info.locked) continue;
        await download(info.url, `${folderPath(folder)}/${safe(info.name)}`);
        started++;
      }
      const rest = state.sel.count() - files.length;
      const locked = files.length - started;
      setStatus(
        `Downloading ${started} files to Downloads › Canvas.` +
          (rest ? ` Pages and links aren't files, so ${rest} ${rest === 1 ? 'was' : 'were'} skipped.` : '') +
          (locked ? ` ${locked} ${locked === 1 ? 'is' : 'are'} locked.` : ''),
        'done',
      );
    }
    if (action === 'save') {
      const pack = await currentPack();
      const folder = `Canvas/${safe(state.course.name)} - for AI`;
      await download(URL.createObjectURL(new Blob([pack.markdown], { type: 'text/markdown' })), `${folder}/course.md`);
      for (const img of pack.images) await download(img.url ?? URL.createObjectURL(img.blob), `${folder}/images/${img.name}`);
      setStatus(`Saved to Downloads › ${folder}. Drag <b>course.md</b> and the <b>images</b> folder into the chat.`, 'done');
    }
    if (action === 'clear') {
      state.sel.clear();
      forgetPack();
      $('folders').innerHTML = folderCards(state.course, state.sel, state.open);
      updateBar();
    }
  } catch (err) {
    setStatus(`That didn't work: ${err.message}`, 'error');
  }
});

$('rescan').addEventListener('click', scan);
scan();
