// An Export's pages saved as PDFs (pack/page-pdf.js), in the panel: the
// pictures a page shows are fetched from Canvas, then pdfmake writes the
// file. pdfmake and its font load the first time a page is saved.
//
//   const pdf = pagePdfs(files, { base, signal, loggedIn });
//   const blob = await pdf({ title, html });
//
// base: the Canvas site, for the page's links. loggedIn(): whether the
// Canvas login still holds, asked when a picture could not be had: a page
// whose pictures were lost to an ended login is not saved without them.
import { pageDoc, pictureData } from '../pack/page-pdf.js';
import { isImage } from '../pack/formats/index.js';
import { stopped, stopsTheRun } from '../canvas/stops.js';
import { limiter } from '../limit.js';

const PICTURES_AT_ONCE = 3;

let loaded;
const pdfmake = () => (loaded ??= (async () => {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake.min.js'), import('pdfmake/build/vfs_fonts.js')]);
  pdfMake.addVirtualFileSystem(vfs);
  pdfMake.setUrlAccessPolicy(() => false); // the pictures are in the document already: nothing is fetched
  return pdfMake;
})());

export function pagePdfs(files, { base, signal, loggedIn = async () => true } = {}) {
  const limit = limiter(PICTURES_AT_ONCE);
  // A picture shown in a page is a course file, fetched by its download link.
  // Resolves to null for one a PDF goes without (from another site, locked,
  // a GIF); throws when one that should be there could not be had.
  async function picture(src) {
    const id = /\/files\/(\d+)/.exec(src)?.[1];
    if (!id) return null; // its alt text stays
    const info = await files.meta(id);
    if (!info?.url || info.locked || !isImage(info.name)) return null;
    const found = pictureData(await files.bytes(info.url, { signal }));
    if (!found && /\.(png|jpe?g)$/i.test(info.name)) throw new Error('not a picture'); // a login page, likely
    return found;
  }
  return async function pdf({ title, html }) {
    const srcs = new Set([...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('img')].map((img) => img.getAttribute('src')).filter(Boolean));
    const pictures = new Map();
    let missed = false;
    await Promise.all([...srcs].map((src) => limit(async () => {
      if (signal?.aborted) return;
      try {
        const found = await picture(src);
        if (found) pictures.set(src, found);
      } catch (e) {
        if (stopsTheRun(e)) throw e; // the page is saved again later, pictures and all
        missed = true;
      }
    })));
    if (signal?.aborted) throw stopped();
    if (missed && !(await loggedIn())) throw Object.assign(new Error('Your Canvas login ended'), { loggedOut: true });
    const make = await pdfmake();
    try {
      return await make.createPdf(pageDoc(title, html, { pictures, base })).getBlob();
    } catch {
      // A style or a picture pdfmake could not take: the page's text, plainly.
      return make.createPdf(pageDoc(title, html, { base, plain: true })).getBlob();
    }
  };
}
