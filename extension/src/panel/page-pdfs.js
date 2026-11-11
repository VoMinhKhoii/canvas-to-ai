// An Export's pages saved as PDFs (pack/page-pdf.js), in the panel: the
// pictures a page shows are fetched from Canvas, then pdfmake writes the
// file. pdfmake and its font load the first time a page is saved.
//
//   const pdf = pagePdfs(files);
//   const blob = await pdf({ title, html });
import { pageDoc, pictureData } from '../pack/page-pdf.js';
import { isImage } from '../pack/formats/index.js';
import { stopsTheRun } from '../canvas/stops.js';
import { limiter } from '../limit.js';

const PICTURES_AT_ONCE = 3;

let loaded;
const pdfmake = () => (loaded ??= (async () => {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake.min.js'), import('pdfmake/build/vfs_fonts.js')]);
  pdfMake.addVirtualFileSystem(vfs);
  pdfMake.setUrlAccessPolicy(() => false); // the pictures are in the document already: nothing is fetched
  return pdfMake;
})());

export function pagePdfs(files) {
  const limit = limiter(PICTURES_AT_ONCE);
  // A picture shown in a page is a course file, fetched by its download link.
  async function picture(src) {
    const id = /\/files\/(\d+)/.exec(src)?.[1];
    if (!id) return null; // from another site: its alt text stays
    const info = await files.meta(id);
    if (!info?.url || info.locked || !isImage(info.name)) return null;
    return pictureData(await files.bytes(info.url));
  }
  return async function pdf({ title, html }) {
    const srcs = new Set([...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('img')].map((img) => img.getAttribute('src')).filter(Boolean));
    const pictures = new Map();
    await Promise.all([...srcs].map((src) => limit(async () => {
      try {
        const found = await picture(src);
        if (found) pictures.set(src, found);
      } catch (e) {
        if (stopsTheRun(e)) throw e; // the page is saved again later, pictures and all
      }
    })));
    const make = await pdfmake();
    try {
      return await make.createPdf(pageDoc(title, html, { pictures })).getBlob();
    } catch {
      // A style or a picture pdfmake could not take: the page's text, plainly.
      return make.createPdf(pageDoc(title, html, { plain: true })).getBlob();
    }
  };
}
