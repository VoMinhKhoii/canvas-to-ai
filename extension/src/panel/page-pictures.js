// The pictures an Export's page shows, for its PDF (pack/page-pdf.js): each
// is a course file, fetched from Canvas by its download link.
//
//   const pictures = pagePictures(files, { base, signal, loggedIn });
//   const shown = await pictures(html); // src → pictureData()
//
// base: the Canvas site; a picture on another site is not one of its files.
// loggedIn(): whether the Canvas login still holds, asked when a picture
// could not be had: a page whose pictures were lost to an ended login is not
// saved without them.
import { PDF_PICTURE_EXTS, pictureData } from '../pack/page-shown.js';
import { extOf } from '../pack/names.js';
import { isImage } from '../pack/formats/index.js';
import { loggedOut, stopped, stopsTheRun } from '../canvas/stops.js';
import { limiter } from '../limit.js';

const AT_ONCE = 3;

export function pagePictures(files, { base, signal, loggedIn = async () => true } = {}) {
  const limit = limiter(AT_ONCE);
  const site = base ? new URL(base).origin : 'https://canvas.invalid'; // no base: only links without a site are its own
  const onSite = (src) => {
    try {
      return new URL(src, site).origin === site;
    } catch {
      return false;
    }
  };
  // Null for one a PDF goes without (from another site, locked, a GIF);
  // throws when one that should be there could not be had.
  async function picture(src) {
    const id = onSite(src) && /\/files\/(\d+)/.exec(src)?.[1];
    if (!id) return null; // from another site, or not a file: its alt text stays
    const info = await files.meta(id);
    if (!info?.url || info.locked || !isImage(info.name)) return null;
    const found = pictureData(await files.bytes(info.url, { signal }));
    if (!found && PDF_PICTURE_EXTS.has(extOf(info.name))) throw new Error('not a picture'); // a login page, likely
    return found;
  }
  return async function pictures(html) {
    const srcs = new Set([...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('img')].map((img) => img.getAttribute('src')).filter(Boolean));
    const shown = new Map();
    let missed = false;
    await Promise.all([...srcs].map((src) => limit(async () => {
      try {
        const found = await picture(src);
        if (found) shown.set(src, found);
      } catch (e) {
        if (signal?.aborted) throw stopped();
        if (stopsTheRun(e)) throw e; // the page is saved again later, pictures and all
        missed = true;
      }
    })));
    if (signal?.aborted) throw stopped(); // also a page whose pictures all finished as Stop was pressed
    if (missed && !(await loggedIn())) throw loggedOut();
    return shown;
  };
}
