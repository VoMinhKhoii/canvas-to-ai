// Where an Export that has not finished is kept, so it can continue after
// the panel closes, the browser quits or the computer restarts, without
// reading Canvas or saving files again. IndexedDB: a plan holds every page's
// text, more than localStorage takes.
//
//   'run'          { root, picked, options, planned, started, big }
//   'inbox'        the messages, read once
//   'course:<id>'  each course's part of the plan, as it is read
//   'plan'         the whole plan, once the size check is done
//   'saved'        the paths already on disk
const DB = 'canvas-to-ai-export';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, work) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = work(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const exportStore = {
  get: (key) => tx('readonly', (s) => s.get(key)),
  put: (key, value) => tx('readwrite', (s) => s.put(value, key)),
  // Every course part read so far, by course id.
  async courses() {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    const out = {};
    for (const key of keys.filter((k) => k.startsWith('course:'))) out[key.slice(7)] = await this.get(key);
    return out;
  },
  clear: () => tx('readwrite', (s) => s.clear()),
};
