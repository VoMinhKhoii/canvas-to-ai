// Saves an Export's entries with chrome.downloads and reports when each one
// has really finished, so only a few are ever being written at a time. The
// browser streams each file to disk: none of it passes through memory here.
//
// An export has a dated folder of its own, so 'overwrite' can only replace a
// half-saved file from the same export, never the student's own.
const SAVES_AGAIN = /^(NETWORK_|FILE_TRANSIENT)/;
const ATTEMPTS = 5; // waits of 5, 10, 15 and 20 s between them: a short drop is waited out
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Chrome's warnings that wait for the student to click Keep (or to agree to
// a scan). Its other danger values are a scan still running (asyncScanning)
// or a verdict (safe, deepScannedSafe…): those are waited out like any download.
const WAITS_FOR_A_CLICK = ['file', 'url', 'content', 'uncommon', 'host', 'unwanted', 'accountCompromise', 'promptForScanning', 'promptForLocalPasswordScanning'];
const HELD = 'HELD_AS_HARMFUL';
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

// loggedIn(): whether the Canvas login still holds. A file link opened
// without it lands on Canvas's login page, which would be saved in place of
// the file: a web page where a PDF was expected is checked against it.
export function chromeSaver(downloads, root, signal, { loggedIn = async () => true, online = () => navigator.onLine, sleep = wait } = {}) {
  const waiting = new Map(); // download id → { finish, fail }
  const settle = (id, change) => {
    const job = waiting.get(id);
    if (!job) return;
    if (change.state === 'complete') job.finish();
    else if (change.state === 'interrupted') job.fail(change.error ?? 'FAILED');
    // Chrome holds back a file type it thinks may be harmful until the student
    // clicks Keep: the run must not wait on that.
    else if (WAITS_FOR_A_CLICK.includes(change.danger)) job.fail(HELD);
  };
  const listener = (d) => settle(d.id, { state: d.state?.current, error: d.error?.current, danger: d.danger?.current });
  downloads.onChanged.addListener(listener);
  const cancelAll = () => [...waiting.keys()].forEach((id) => downloads.cancel(id).catch(() => {}));
  signal.addEventListener('abort', cancelAll);
  const notThePage = (d, filename) => d?.mime?.startsWith('text/html') && !/\.html?$/i.test(filename);

  async function once(url, filename) {
    const id = await downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    try {
      await new Promise((finish, fail) => {
        waiting.set(id, { finish, fail });
        if (signal.aborted) downloads.cancel(id).catch(() => {});
        // It may have finished before the listener knew its id.
        downloads.search({ id }).then(([d]) => d && settle(id, { state: d.state, error: d.error, danger: d.danger }));
      });
    } catch (code) {
      if (code === HELD) await downloads.cancel(id).catch(() => {}); // not left waiting in Chrome's downloads
      throw code;
    } finally {
      waiting.delete(id);
    }
    return id;
  }

  return {
    async save(entry) {
      const blob = entry.blob && URL.createObjectURL(entry.blob); // made in the panel, not a Canvas link
      const filename = `${root}/${entry.path}`;
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const id = await once(blob ?? entry.url, filename);
            if (!blob && notThePage((await downloads.search({ id }))[0], filename) && !(await loggedIn())) {
              await downloads.removeFile(id).catch(() => {});
              downloads.erase({ id }).catch(() => {});
              throw fatal('Your Canvas login ended');
            }
            downloads.erase({ id }).catch(() => {}); // the file stays; thousands of history rows don't
            return;
          } catch (code) {
            if (typeof code !== 'string') throw code; // ours, or chrome.downloads refused it outright (an invalid name)
            if (code === HELD) throw new Error('Chrome held it back as possibly harmful: download it from Canvas yourself');
            if (code === 'FILE_NO_SPACE') throw fatal('Your disk is full');
            if (signal.aborted) throw new Error(code);
            if (SAVES_AGAIN.test(code) && attempt < ATTEMPTS) {
              await sleep(5000 * attempt);
              continue;
            }
            // The rest would fail the same way: stop, and let the student continue later.
            if (code.startsWith('NETWORK_') && !online()) throw fatal('The internet connection dropped');
            throw new Error(code);
          }
        }
      } finally {
        if (blob) URL.revokeObjectURL(blob);
      }
    },
    // Before an export continues: what Chrome was still doing in its folder
    // when the panel closed or the browser quit. Downloads that finished are
    // counted as saved (their paths are returned); unfinished ones are
    // cancelled, to be saved again, so no half-written file is left behind.
    async tidy() {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inFolder = new RegExp(`[\\\\/]${escaped}[\\\\/](.+)$`);
      const finished = [];
      for (const d of await downloads.search({ filenameRegex: `[\\\\/]${escaped}[\\\\/]` })) {
        const path = inFolder.exec(d.filename)?.[1]?.replaceAll('\\', '/');
        // A web page where a file was expected is not counted: saved again, it
        // is replaced by the file, or found to be Canvas's login page.
        if (d.state === 'complete' && d.exists !== false && path && !notThePage(d, path)) finished.push(path);
        else if (d.state !== 'complete') await downloads.cancel(d.id).catch(() => {});
        await downloads.erase({ id: d.id }).catch(() => {});
      }
      return finished;
    },
    close() {
      downloads.onChanged.removeListener(listener);
      signal.removeEventListener('abort', cancelAll);
    },
  };
}
