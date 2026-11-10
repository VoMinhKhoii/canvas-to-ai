// A lecturer's notes on a submitted file (highlights, comments, drawings)
// live in Canvadocs, Canvas's document viewer, not in Canvas itself. A
// submitted file's preview_url opens a Canvadocs session for the student;
// the session lists its notes and, asked to, builds the file as a PDF with
// them on it (the viewer's "Download annotated PDF").
//
//   const docs = canvadocs('https://school.instructure.com');
//   await docs.annotations(previewUrl); // → how many notes
//   await docs.annotatedPdf(previewUrl); // → a link to that PDF, for the browser to download
//
// Run from the panel: the session lives on a Canvadocs host, not the Canvas
// site, and is opened with the student's Canvas login (cookies).
import { limiter } from '../limit.js';

const PARALLEL = 2;
const READY_TRIES = 60; // every 2 s: two minutes for Canvadocs to build one
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function canvadocs(site, { fetch: send = (...a) => fetch(...a), sleep = wait } = {}) {
  const limit = limiter(PARALLEL);
  // fetch fails outright only when the connection does: that stops the run (stops.js).
  const get = (url, options) => send(url, options).catch(() => {
    throw Object.assign(new Error('Lost the connection to Canvas. Check your internet, then try again.'), { offline: true });
  });
  // The session's address, e.g. https://canvadocs-syd.instructure.com/1/sessions/<id>.
  async function session(previewUrl) {
    const res = await get(new URL(previewUrl, site), { credentials: 'include' });
    const landed = new URL(res.url);
    const path = /^(\/1\/sessions\/[^/]+)\/view$/.exec(landed.pathname)?.[1];
    if (!res.ok || landed.protocol !== 'https:' || !landed.hostname.endsWith('.instructure.com') || !path) throw new Error('Canvas did not open its document viewer');
    return landed.origin + path;
  }
  return {
    annotations: (previewUrl) => limit(async () => {
      const res = await get(`${await session(previewUrl)}/annotations`);
      if (!res.ok) throw new Error('Canvas did not list the notes on it');
      return (await res.json()).data?.length ?? 0;
    }),
    annotatedPdf: (previewUrl) => limit(async () => {
      const base = await session(previewUrl);
      const asked = await get(`${base}/annotated.pdf`, { method: 'POST' });
      if (!asked.ok) throw new Error('Canvas would not make the annotated copy');
      for (let i = 0; i < READY_TRIES; i++) {
        const ready = await get(`${base}/annotated.pdf/is_ready`);
        if ((await ready.json().catch(() => ({}))).ready) return `${base}/annotated.pdf`;
        await sleep(2000);
      }
      throw new Error('Canvas took too long to make the annotated copy');
    }),
  };
}
