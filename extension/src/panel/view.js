// What the side panel draws, as HTML strings: the folder cards, and the words
// a student reads. No state lives here; panel.js decides what to show.
import { sectionId } from './selection.js';
import { isReadable } from '../pack/formats/index.js';
import { extOf } from '../pack/names.js';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const ICONS = {
  chevron: '<path d="M6 4l4 4-4 4"/>',
  pdf: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  slides: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M8 11v2.5M5.5 13.5h5"/>',
  sheet: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.5h11M2.5 10h11M6.5 2.5v11"/>',
  code: '<path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3"/>',
  archive: '<rect x="2.5" y="3" width="11" height="10.5" rx="1"/><path d="M2.5 6h11M7 8.5h2"/>',
  video: '<rect x="2" y="3.5" width="9" height="9" rx="1.5"/><path d="M11 7l3-2v6l-3-2"/>',
  link: '<path d="M7 9a2.8 2.8 0 0 0 4 0l1.8-1.8a2.8 2.8 0 0 0-4-4L8 4"/><path d="M9 7a2.8 2.8 0 0 0-4 0L3.2 8.8a2.8 2.8 0 0 0 4 4L8 12"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M14 11l-3.5-3.5L4 13"/>',
  page: '<path d="M4 2.5h8v11H4z"/><path d="M6 6h4M6 8.5h4M6 11h2.5"/>',
  doc: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M6 8h4M6 10.5h4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  check: '<path d="M4 8.5l2.5 2.5L12 5.5"/>',
};
export const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

const KIND_BY_EXT = [
  [/^pdf$/, 'pdf'], [/^(pptx?|pps|pot|odp|key)$/, 'slides'], [/^(xlsx?|xlsm|xlsb|ods|csv|tsv|numbers)$/, 'sheet'],
  [/^(docx?|dotx?|odt|rtf|txt|md|epub|pages|vtt|srt)$/, 'doc'], [/^(zip|rar|7z|tar|gz)$/, 'archive'],
  [/^(png|jpe?g|gif|webp|svg|heic)$/, 'image'], [/^(mp4|mov|m4v|avi|mkv|webm|mp3|m4a|wav)$/, 'video'],
];
function itemIcon(item) {
  if (item.kind === 'link') return 'link';
  if (item.kind === 'page') return 'page';
  const ext = extOf(item.fileName);
  return KIND_BY_EXT.find(([re]) => re.test(ext))?.[1] ?? 'code';
}

// "Week 1/Topic 1 - Introduction to …" → { name: "Week 1", topic: "Introduction to …" }.
export function folderName(title) {
  const m = /^(week\s*\d+)\s*(?:[/:\-–|]\s*(?:topic\s*\d+\s*[-–:]?\s*)?)?(.*)$/i.exec(title);
  return m ? { name: m[1].replace(/\s+/g, ' ').replace(/^week/i, 'Week'), topic: m[2].trim() } : { name: title, topic: '' };
}
// "In-Class" → "In-class"; sub-headers are typed by hand and vary.
const sectionName = (title) => title.replace(/-([A-Z])(?=[a-z])/g, (_, c) => `-${c.toLowerCase()}`);
// The icon already says what kind of file it is.
const itemName = (item) => (item.kind === 'file' ? item.title.replace(/\.(pdf|pptx?|docx?|xlsx?|csv|zip|html?|ipynb|png|jpe?g|txt|md)$/i, '') : item.title);

function circle(state, label, id, size = '') {
  const checked = { on: 'true', off: 'false', some: 'mixed' }[state];
  return `<button class="pick ${size} ${state}" role="checkbox" aria-checked="${checked}" aria-label="${esc(label)}" data-pick="${esc(id)}">${state === 'on' ? icon('check', 'tick') : ''}</button>`;
}

function itemRow(item, sel) {
  const on = sel.state(item.key) === 'on';
  const note = item.locked
    ? `<span class="note">${icon('lock', 'ico small')} ${esc(item.locked)}</span>`
    : item.kind === 'file' && !isReadable(item.fileName)
      ? '<span class="note">Download only: the AI can\'t read this</span>'
      : '';
  const label = `${on ? 'Unpick' : 'Pick'} ${itemName(item)}`;
  return `<div class="item${on ? ' on' : ''}${item.locked ? ' locked' : ''}" ${item.locked ? '' : `role="checkbox" aria-checked="${on}" aria-label="${esc(label)}" tabindex="0" data-pick="${esc(item.key)}"`}>
    ${icon(itemIcon(item), 'ico kind')}<span class="text"><span class="name">${esc(itemName(item))}</span>${note}</span>
    ${item.locked ? '' : `<span class="pick small ${on ? 'on' : 'off'}" aria-hidden="true">${on ? icon('check', 'tick') : ''}</span>`}
  </div>`;
}

export function folderCard(folder, sel, open) {
  const { name, topic } = folderName(folder.title);
  const state = sel.state(folder.id);
  const pickable = sel.size(folder.id) > 0;
  const picked = sel.pickedIn(folder.id);
  const body = open
    ? `<div class="body">${folder.sections
        .map((section, i) => {
          const head = section.title
            ? `<div class="section"><span>${esc(sectionName(section.title))}</span>${sel.size(sectionId(folder, i)) ? circle(sel.state(sectionId(folder, i)), `Pick all of ${sectionName(section.title)}`, sectionId(folder, i), 'small') : ''}</div>`
            : '';
          return head + section.items.map((item) => itemRow(item, sel)).join('');
        })
        .join('')}</div>`
    : '';
  return `<section class="card${open ? ' open' : ''}" data-folder="${esc(folder.id)}">
    <div class="head">
      <button class="opener" aria-expanded="${open}" data-open="${esc(folder.id)}">${icon('chevron', 'ico chev')}
        <span class="title"><span class="name">${esc(name)}</span>${topic ? `<span class="topic">${esc(topic)}</span>` : ''}</span>
      </button>
      ${picked && state !== 'on' ? `<span class="count">${picked} picked</span>` : ''}
      ${pickable ? circle(state, `Pick all of ${name}`, folder.id) : ''}
    </div>${body}
  </section>`;
}

export const folderCards = (course, sel, openIds) => course.folders.map((f) => folderCard(f, sel, openIds.has(f.id))).join('');

// "5 picked from Week 1", "12 picked from 3 weeks".
export function pickedLine(sel) {
  const picked = sel.picked();
  if (!picked.length) return 'Pick a week, or open one to choose files.';
  const folders = [...new Set(picked.map((p) => p.folder))];
  const where = folders.length === 1 ? folderName(folders[0].title).name : `${folders.length} ${folders.every((f) => /^week/i.test(f.title)) ? 'weeks' : 'folders'}`;
  return `<b>${picked.length} picked</b> from ${esc(where)}`;
}

// Shown once before the panel reads anything, and again from ⋯ › AI use and terms.
export const termsCard = (button) => `<section class="card terms">
    <h2>Before you start</h2>
    <ul>
      <li>Course materials belong to your school and your lecturers. Use them for your own study, and don't share them publicly.</li>
      <li>Some courses and assessments don't allow AI tools. Check each course's rules before you paste anything into an AI chat.</li>
      <li>Canvas to AI reads your course on this computer and sends nothing anywhere. What you paste into ChatGPT, Claude or Gemini goes to that company, under its terms: check whether it uses your chats for training.</li>
      <li><b>Copy text for AI</b> copies text only. Pictures need <b>⋯ › Save with pictures</b>.</li>
      <li><b>Download all of Canvas</b> can include messages and classmates' discussion posts, if you turn those on. Other people wrote them, so keep them private.</li>
      <li>Canvas to AI isn't made or endorsed by Instructure or your school.</li>
    </ul>
    <button class="primary" id="agree">${esc(button)}</button>
  </section>`;

// A Canvas on the school's own address (canvas.school.edu) needs the
// student's OK once: Chrome asks, then the panel checks it is Canvas.
export const ownSiteForm = () => `<form id="own-site" class="own-site">
  <label for="own-site-url">Is your Canvas on your school's own address? Type it here:</label>
  <input id="own-site-url" type="text" inputmode="url" placeholder="canvas.school.edu" autocomplete="off" spellcheck="false" />
  <button class="text-button" type="submit">Allow Canvas to AI there</button>
  <p id="own-site-note" role="status"></p>
</form>`;

export const loadingCards = () => Array.from({ length: 5 }, () => '<div class="card ghost"><span></span><span></span></div>').join('');

// Download all of Canvas: the cards of the export, one per step.
export function fileSize(bytes) {
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1073741824) return `${Math.round(bytes / 1048576)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
const plural = (n, word) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

const courseRow = (c) => `<label class="row"><input type="checkbox" data-course="${esc(c.id)}" checked>
    <span class="text"><span class="name">${esc(c.name)}</span><span class="note">${esc([c.code, c.term].filter(Boolean).join(' · '))}</span></span></label>`;
const courseGroup = (title, list) => (list.length ? `<h3>${title}</h3>${list.map(courseRow).join('')}` : '');

export const exportPicker = (courses) => `<section class="card terms export">
    <h2>Download all of Canvas</h2>
    <p>Each course gets its own folder. Nothing is saved until you've seen the total size.</p>
    ${courseGroup('Current courses', courses.filter((c) => !c.past))}
    ${courseGroup('Past courses', courses.filter((c) => c.past))}
    ${courses.length ? '' : '<p>Canvas lists no courses for you.</p>'}
    <h3>Also include</h3>
    <label class="row"><input type="checkbox" id="export-replies"><span class="text"><span class="name">Discussion replies</span><span class="note">Includes what classmates posted</span></span></label>
    <label class="row"><input type="checkbox" id="export-messages"><span class="text"><span class="name">Inbox messages</span><span class="note">Includes what other people wrote to you. Unread messages stay unread</span></span></label>
    <div class="buttons"><button class="primary" id="export-check"${courses.length ? '' : ' disabled'}>Check the size</button><button class="text-button" id="export-close">Back</button></div>
  </section>`;

export const exportRunning = (line) => `<section class="card terms export">
    <h2>Download all of Canvas</h2>
    <p id="export-line" role="status">${esc(line)}</p>
    <p class="note">Keep this panel and your Canvas tab open.</p>
    <div class="buttons"><button class="text-button" id="export-stop">Stop</button></div>
  </section>`;

export function exportSummary(totals, notSaved, { tight }) {
  const size = totals.bytes - totals.bigBytes;
  return `<section class="card terms export">
    <h2>Ready to download</h2>
    <p><b>${fileSize(size)}</b>: ${plural(totals.files - totals.bigFiles, 'file')} and ${plural(totals.pages, 'page')}.</p>
    ${notSaved ? `<p class="note">${plural(notSaved, 'item')} can't be saved (locked or closed). The report in the folder lists them.</p>` : ''}
    ${totals.bigFiles ? `<label class="row"><input type="checkbox" id="export-big"><span class="text"><span class="name">Include ${plural(totals.bigFiles, 'file')} over 200 MB</span><span class="note">${fileSize(totals.bigBytes)} more</span></span></label>` : ''}
    ${tight ? '<p class="warn">This computer may not have enough free space. If the disk fills up, the download stops by itself.</p>' : ''}
    <div class="buttons"><button class="primary" id="export-go">Download</button><button class="text-button" id="export-back">Back</button></div>
  </section>`;
}

export function exportFinished({ stopped, fatal, failed, leftOut, saved }, where) {
  const head = fatal ? `${esc(fatal.message)}, so the download stopped.` : stopped ? 'Stopped.' : 'Done.';
  const next = stopped
    ? `Everything saved so far is kept. ${/login/.test(fatal?.message) ? 'Log in to Canvas again in your Canvas tab, then press' : 'Press'} <b>Continue</b> to carry on from here, now or later.`
    : '<b>Export report.md</b> in that folder lists anything missing.';
  const again = stopped ? 'Continue' : failed.length ? 'Try them again' : '';
  return `<section class="card terms export">
    <h2>${head}</h2>
    <p>${plural(saved, 'item')} saved in <b>${esc(where)}</b>.</p>
    ${failed.length && !stopped ? `<p class="warn">${plural(failed.length, 'item')} could not be saved.</p>` : ''}
    ${leftOut.length && !stopped ? `<p class="note">${plural(leftOut.length, 'file')} over 200 MB left out.</p>` : ''}
    <p>${next}</p>
    <div class="buttons">${again ? `<button class="primary" id="export-again">${again}</button><button class="text-button" id="export-close">Close</button>` : '<button class="primary" id="export-close">Close</button>'}</div>
  </section>`;
}

// An export that did not finish, found when the student comes back to it.
export function exportResume({ planned, started, saved, total, read, courses, root }) {
  const where = !planned
    ? `Its size check had read ${read.toLocaleString('en')} of ${plural(courses, 'course')}.`
    : started
      ? `${saved.toLocaleString('en')} of ${plural(total, 'item')} are saved in <b>Downloads › ${esc(root)}</b>.`
      : 'Its size check is done; nothing is saved yet.';
  return `<section class="card terms export">
    <h2>Your last export didn't finish</h2>
    <p>${where} It carries on from there${planned ? '' : ', and nothing is saved before you see the size'}.</p>
    <div class="buttons"><button class="primary" id="export-continue">Continue</button><button class="text-button" id="export-over">Start over</button><button class="text-button" id="export-close">Back</button></div>
  </section>`;
}

export const exportProblem = (text) => `<section class="card terms export">
    <h2>That didn't work</h2>
    <p>${esc(text)}</p>
    <p class="note">Nothing read or saved so far is lost.</p>
    <div class="buttons"><button class="primary" id="export-again">Try again</button><button class="text-button" id="export-close">Close</button></div>
  </section>`;
