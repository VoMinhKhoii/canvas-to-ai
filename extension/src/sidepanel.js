import { collectCourse } from './collect.js';
import { buildMarkdown, safe } from './convert.js';

const $ = (id) => document.getElementById(id);
const COURSE_URL = /^https:\/\/[^/]+\.instructure\.com\/courses\/(\d+)/;

let course = null; // { courseName, groups: [{ title, items }] }
let selected = new Set(); // keys "groupIndex:itemIndex"
let busy = false;
let markdown = null; // { key, md } for the last built selection

const setStatus = (text) => ($('status').textContent = text);

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function* entries() {
  for (const [gi, group] of (course?.groups || []).entries()) {
    for (const [ii, item] of group.items.entries()) yield { key: `${gi}:${ii}`, gi, group, item };
  }
}
const selectable = (item) => !(item.kind === 'file' && item.unavailable);
const selectedEntries = () => [...entries()].filter((e) => selected.has(e.key));

// The course tab: the active tab if it's a Canvas course, else the most recently used one.
async function findCourseTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (COURSE_URL.test(active?.url || '')) return active;
  const tabs = await chrome.tabs.query({ url: 'https://*.instructure.com/courses/*' });
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function setBusy(value) {
  busy = value;
  updateUI();
  $('rescan').disabled = value;
}

async function scan() {
  if (busy) return;
  setBusy(true);
  try {
    const tab = await findCourseTab();
    if (!tab) {
      course = null;
      render();
      setStatus('No Canvas course tab found. Open a course on *.instructure.com.');
      return;
    }
    const courseId = COURSE_URL.exec(tab.url)[1];
    setStatus('Scanning course…');
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectCourse,
      args: [courseId],
    });
    if (!result) throw new Error('Scan failed. Are you logged in to Canvas in that tab?');
    course = result;
    selected = new Set();
    markdown = null;
    render();
    const files = [...entries()].filter((e) => e.item.kind === 'file').length;
    setStatus(`Found ${files} files and ${[...entries()].length - files} pages/announcements.`);
  } catch (e) {
    setStatus(e.message);
  } finally {
    setBusy(false);
  }
}

function render() {
  const list = $('list');
  list.replaceChildren();
  $('course').textContent = course?.courseName || 'Canvas to AI';
  if (!course?.groups.length) {
    list.innerHTML = `<p class="empty">${course ? 'No files found in this course.' : 'Open a Canvas course, then click Rescan.'}</p>`;
    updateUI();
    return;
  }

  for (const [gi, group] of course.groups.entries()) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    const groupBox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    groupBox.dataset.group = gi;
    summary.append(groupBox, span('name', group.title), span('count', String(group.items.length)));
    details.append(summary);

    for (const [ii, item] of group.items.entries()) {
      const row = document.createElement('label');
      row.className = 'row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
      box.dataset.key = `${gi}:${ii}`;
      let meta;
      if (item.kind === 'text') meta = 'text';
      else if (item.unavailable) meta = item.unavailable;
      else meta = humanSize(item.size);
      if (!selectable(item)) {
        box.disabled = true;
        row.classList.add('off');
      }
      const name = span('name', item.kind === 'text' ? item.title : item.name);
      name.title = name.textContent;
      row.append(box, span('icon', item.kind === 'text' ? '📝' : '📄'), name, span('meta', meta));
      details.append(row);
    }
    list.append(details);
  }
  updateUI();
}

function span(className, text) {
  return Object.assign(document.createElement('span'), { className, textContent: text });
}

function updateUI() {
  for (const box of document.querySelectorAll('input[data-key]')) box.checked = selected.has(box.dataset.key);
  for (const box of document.querySelectorAll('input[data-group]')) {
    const keys = course.groups[box.dataset.group].items.map((item, ii) => selectable(item) && `${box.dataset.group}:${ii}`).filter(Boolean);
    const n = keys.filter((k) => selected.has(k)).length;
    box.checked = n > 0 && n === keys.length;
    box.indeterminate = n > 0 && n < keys.length;
    box.disabled = keys.length === 0;
  }

  const chosen = selectedEntries();
  const files = chosen.filter((e) => e.item.kind === 'file');
  const bytes = files.reduce((sum, e) => sum + e.item.size, 0);
  $('summary').textContent = chosen.length ? `${chosen.length} selected · ${humanSize(bytes)}` : '';
  $('download').disabled = busy || !files.length;
  $('copy').disabled = $('save').disabled = busy || !chosen.length;
  $('all').disabled = $('none').disabled = busy || !course;
  if (markdown && markdown.key !== selectionKey()) {
    markdown = null;
    $('copy').textContent = 'Copy as Markdown';
  }
}

const selectionKey = () => [...selected].sort().join(',');

$('list').addEventListener('change', (e) => {
  const { key, group } = e.target.dataset;
  if (key) e.target.checked ? selected.add(key) : selected.delete(key);
  if (group !== undefined) {
    for (const [ii, item] of course.groups[group].items.entries()) {
      if (!selectable(item)) continue;
      e.target.checked ? selected.add(`${group}:${ii}`) : selected.delete(`${group}:${ii}`);
    }
  }
  updateUI();
});

$('all').addEventListener('click', () => {
  selected = new Set([...entries()].filter((e) => selectable(e.item)).map((e) => e.key));
  updateUI();
});
$('none').addEventListener('click', () => {
  selected = new Set();
  updateUI();
});
$('rescan').addEventListener('click', scan);

$('download').addEventListener('click', async () => {
  const files = selectedEntries().filter((e) => e.item.kind === 'file');
  for (const { gi, group, item } of files) {
    await chrome.downloads.download({
      url: item.url,
      filename: `Canvas/${safe(course.courseName)}/${String(gi + 1).padStart(2, '0')} ${safe(group.title)}/${safe(item.name)}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  }
  const texts = selectedEntries().length - files.length;
  setStatus(`Started ${files.length} downloads into Downloads/Canvas/.${texts ? ` (${texts} text items are copy-only.)` : ''}`);
});

async function getMarkdown() {
  const key = selectionKey();
  if (markdown?.key === key) return markdown;
  setBusy(true);
  try {
    const chosen = selectedEntries().map((e) => ({ group: e.group.title, item: e.item }));
    const { md, skipped, images } = await buildMarkdown(course, chosen, setStatus);
    markdown = { key, md, skipped, images };
    return markdown;
  } finally {
    setBusy(false);
  }
}

function describe({ md, skipped, images }) {
  const tokens = Math.round(md.length / 4).toLocaleString();
  return [
    `~${tokens} tokens`,
    images.length && `${images.length} images`,
    skipped && `${skipped} files not converted (listed at the end)`,
  ].filter(Boolean).join(' · ');
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

$('copy').addEventListener('click', async () => {
  try {
    const result = await getMarkdown();
    if (await writeClipboard(result.md)) {
      setStatus(`Copied ${describe(result)}${result.images.length ? '. Use Save to get the images.' : ''}`);
      $('copy').textContent = 'Copy as Markdown';
    } else {
      setStatus(`Ready: ${describe(result)}. Click again to copy.`);
      $('copy').textContent = 'Click to copy';
    }
  } catch (e) {
    setStatus(`Failed: ${e.message}`);
  }
});

$('save').addEventListener('click', async () => {
  try {
    const result = await getMarkdown();
    const folder = `Canvas/${safe(course.courseName)} - AI`;
    const save = (url, filename) => chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    await save(URL.createObjectURL(new Blob([result.md], { type: 'text/markdown' })), `${folder}/course.md`);
    for (const img of result.images) await save(img.url || URL.createObjectURL(img.blob), `${folder}/images/${img.name}`);
    setStatus(`Saved Downloads/${folder}/ · ${describe(result)}`);
  } catch (e) {
    setStatus(`Failed: ${e.message}`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'progress') setStatus(msg.text);
});

scan();
