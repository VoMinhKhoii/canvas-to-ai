// Download all of Canvas, in the panel: pick courses → see the size → save.
//
// An export takes long enough for anything to happen midway: the panel
// closes, the browser quits, the Wi-Fi drops, the Canvas login ends. So the
// run is kept as it goes (export-store.js), and coming back to it continues
// it: courses already read are not read again, files already saved are not
// saved again.
import { tabCanvas, canvasFiles } from '../canvas/tab-adapter.js';
import { steady } from '../canvas/steady.js';
import { canvadocs } from '../canvas/canvadocs.js';
import { listCourses, planExport, planTotals, runExport } from '../export.js';
import { chromeSaver } from './chrome-saver.js';
import { exportStore } from './export-store.js';
import { exportPicker, exportRunning, exportSummary, exportFinished, exportProblem, exportResume } from './view.js';

const $ = (id) => document.getElementById(id);
const CANVAS_URL = /^https:\/\/[^/]+\.instructure\.com\//;
const REMEMBER_EVERY = 20; // saves; a few redone after a crash cost nothing

const newRoot = () => `Canvas export ${new Date().toISOString().slice(0, 10)} ${Date.now().toString(36)}`;
const latest = (tabs) => tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.active - a.active)[0];

// Any Canvas tab will do: the course list is not tied to one course.
async function findCanvasTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (CANVAS_URL.test(active?.url || '')) return active;
  return latest(await chrome.tabs.query({ url: 'https://*.instructure.com/*' }));
}
// Another tab of the same Canvas site, when the one in use closes.
const findSiteTab = async (site) => latest(await chrome.tabs.query({ url: `${site}/*` }));

export function exportFlow({ area, bar, setBusy, close }) {
  let canvas;
  let files;
  let courses;
  let site;
  let docs;

  function draw(html, buttons = {}) {
    area.innerHTML = html;
    for (const [id, action] of Object.entries(buttons)) $(id)?.addEventListener('click', action);
  }
  async function busy(job) {
    setBusy(true);
    try {
      await job();
    } catch (e) {
      draw(exportProblem(e.message), { 'export-again': open, 'export-close': close });
    } finally {
      bar.hidden = true;
      setBusy(false);
    }
  }
  const stopper = () => {
    const controller = new AbortController();
    return { signal: controller.signal, stop: () => controller.abort() };
  };

  const showPicker = () => draw(exportPicker(courses), { 'export-check': check, 'export-close': close });

  function check() {
    const picked = courses.filter((c) => area.querySelector(`[data-course="${c.id}"]`).checked);
    if (!picked.length) return;
    const run = { site, root: newRoot(), picked, options: { replies: $('export-replies').checked, messages: $('export-messages').checked }, planned: false, started: false, big: false };
    busy(async () => {
      await exportStore.clear();
      await exportStore.put('run', run);
      await plan(run);
    });
  }

  // The size check, carrying on from what an earlier one read.
  async function plan(run) {
    const { signal, stop } = stopper();
    draw(exportRunning('Looking through your courses…'), { 'export-stop': stop });
    const known = { inbox: await exportStore.get('inbox'), groups: await exportStore.get('groups'), courses: await exportStore.courses() };
    const picked = new Set(run.picked.map((c) => c.id));
    const result = await planExport(canvas, files, run.picked, {
      ...run.options,
      otherCourses: courses.filter((c) => !picked.has(c.id)),
      docs,
      known,
      keep: exportStore.put,
      signal,
      onProgress: (text) => ($('export-line').textContent = text),
    });
    if (signal.aborted) return resume(run);
    await exportStore.put('plan', result);
    await exportStore.put('run', { ...run, planned: true });
    await summary(result, { ...run, planned: true });
  }

  async function summary(result, run) {
    const totals = planTotals(result);
    // The browser's estimate of room for one site: it shrinks as the disk fills, so only a hint.
    const { quota = Infinity, usage = 0 } = (await navigator.storage?.estimate?.().catch(() => null)) ?? {};
    draw(exportSummary(totals, result.notSaved.length, { tight: totals.bytes - totals.bigBytes > quota - usage }), {
      'export-go': () => busy(() => save(result, { ...run, started: true, big: Boolean($('export-big')?.checked) })),
      'export-back': showPicker,
    });
  }

  async function save(result, run) {
    const { signal, stop } = stopper();
    const where = `Downloads › ${run.root}`;
    draw(exportRunning(`Saving to ${where}…`), { 'export-stop': stop });
    await exportStore.put('run', run);
    const loggedIn = () => canvas.get('/api/v1/users/self').then(() => true, (e) => e.status !== 401);
    const saver = chromeSaver(chrome.downloads, run.root, signal, { loggedIn });
    const done = new Set((await exportStore.get('saved')) ?? []);
    for (const path of await saver.tidy()) done.add(path);
    const remember = () => exportStore.put('saved', [...done]);
    // An annotated copy is made now, from a fresh link: the one read during
    // the size check may be a day old.
    const ready = async (entry) => {
      if (!entry.annotated) return entry;
      const { course, assignment, attachment } = entry.annotated;
      const { data } = await canvas.get(`/api/v1/courses/${course}/assignments/${assignment}/submissions/self`);
      const file = (data.attachments ?? []).find((a) => a.id === attachment);
      if (!file?.preview_url) throw new Error('Canvas no longer shows this file');
      return { ...entry, url: await docs.annotatedPdf(file.preview_url) };
    };
    bar.hidden = false;
    try {
      const outcome = await runExport(result, {
        save: async (entry) => saver.save(await ready(entry)),
        done,
        signal,
        big: run.big,
        onProgress(n, total) {
          $('export-line').textContent = `Saving ${n.toLocaleString('en')} of ${total.toLocaleString('en')}…`;
          bar.style.transform = `scaleX(${n / total})`;
          if (n % REMEMBER_EVERY === 0) remember();
        },
      });
      // Kept until every file is saved: what failed can be tried again.
      if (outcome.stopped || outcome.failed.length) await remember();
      else await exportStore.clear();
      draw(exportFinished(outcome, where), { 'export-again': () => busy(() => save(result, run)), 'export-close': close });
    } finally {
      saver.close();
      bar.style.transform = 'scaleX(0)';
    }
  }

  async function resume(run) {
    const result = run.planned ? await exportStore.get('plan') : null;
    draw(exportResume({
      ...run,
      courses: run.picked.length,
      read: Object.keys(await exportStore.courses()).length,
      total: result?.entries.length ?? 0,
      saved: ((await exportStore.get('saved')) ?? []).length,
    }), {
      'export-continue': () => busy(() => (!run.planned ? plan(run) : run.started ? save(result, run) : summary(result, run))),
      'export-over': () => busy(async () => {
        await exportStore.clear();
        showPicker();
      }),
      'export-close': close,
    });
  }

  const open = () => busy(async () => {
    const tab = await findCanvasTab();
    if (!tab) throw new Error('Open Canvas in a tab first, then try again.');
    site = new URL(tab.url).origin;
    docs = canvadocs(site);
    canvas = steady(await tabCanvas(tab.id, { findTab: findSiteTab }));
    files = canvasFiles(canvas);
    courses = await listCourses(canvas);
    const run = await exportStore.get('run');
    if (run?.site === site) return resume(run);
    showPicker();
  });
  return open;
}
