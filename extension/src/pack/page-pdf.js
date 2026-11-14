// A Canvas page as a PDF, for Download all: an export is kept to be read, so
// its pages are saved as PDFs a student can open, not as Markdown. Loaded
// with pdfmake when the first page is saved (page-shown.js is what the plan
// needs).
//
//   const blob = await renderPdf(title, html, { pictures, base });
//   const doc = pageDoc(title, html, { pictures, base }); // the pdfmake document
import htmlToPdfmake from 'html-to-pdfmake';
import { drawable, flatten, pageBody } from './page-shown.js';

const WIDTH = 595.28 - 2 * 56; // A4, less the margins
const HEIGHT = 600; // a picture leaves room for a line or two on its page
const PX = 0.75; // points to a CSS pixel

// plain: see flatten(); pictures are then left out.
export function pageDoc(title, html, { pictures, base, plain = false } = {}) {
  const { body, sizes } = pageBody(html ?? '', { pictures: plain ? undefined : pictures, base });
  if (plain) flatten(body);
  const content = htmlToPdfmake(body.innerHTML, { window: globalThis, removeExtraBlanks: true, ignoreStyles: ['font-family'], replaceText: drawable, defaultStyles: { a: { color: '#1a5fb4', decoration: 'underline' } } });
  fit(content, sizes);
  return {
    info: { title: drawable(title) },
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 56],
    content: [{ text: drawable(title), style: 'title' }, ...[content].flat()],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 },
    styles: { title: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] } },
  };
}

// Every picture at its own size, but no wider than the page nor taller than
// most of it.
function fit(node, sizes) {
  if (Array.isArray(node)) return node.forEach((n) => fit(n, sizes));
  if (!node || typeof node !== 'object') return;
  if (node.image) {
    const { width, height } = sizes.get(node.image);
    delete node.width;
    delete node.height;
    node.fit = [Math.min(WIDTH, width * PX), Math.min(HEIGHT, height * PX)];
  }
  for (const key of ['stack', 'text', 'ul', 'ol', 'columns']) fit(node[key], sizes);
  if (node.table?.body) node.table.body.forEach((row) => fit(row, sizes));
}

let loaded;
const pdfmake = () => (loaded ??= (async () => {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake.min.js'), import('pdfmake/build/vfs_fonts.js')]);
  pdfMake.addVirtualFileSystem(vfs);
  pdfMake.setUrlAccessPolicy(() => false); // the pictures are in the document already: nothing is fetched
  return pdfMake;
})());

export async function renderPdf(title, html, { pictures, base } = {}) {
  const make = await pdfmake();
  try {
    return await make.createPdf(pageDoc(title, html, { pictures, base })).getBlob();
  } catch {
    // A style or a picture pdfmake could not take: the page's text, plainly.
    return make.createPdf(pageDoc(title, html, { base, plain: true })).getBlob();
  }
}
