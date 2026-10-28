// PDF → Markdown: text through pdf-layout.js; pages that are mostly a picture
// (diagrams, scans) are rendered and added as images.
import { pagesToMd } from './pdf-layout.js';
import { imageName, imageRef } from '../names.js';

const MAX_RENDERED_PAGES = 40;

// Some PDFs embed fonts without a map from glyphs to letters: their text comes
// out as control characters and shifted letters ("WKH" for "the"). Such a page
// is sent as a picture instead of its scrambled text.
export function scrambled({ items }) {
  const text = items.map((it) => it.str ?? '').join('').replace(/\s/g, '');
  return text.length >= 20 && (text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/g)?.length ?? 0) / text.length > 0.1;
}

// A page with little text but real drawings (diagram, screenshot, scan) is worth
// sending as a picture. Slide templates draw ~2 images on every page, so plain
// title slides stay text; a page with no text at all but any image is a scan.
async function isPicturePage(pdfjs, page, hasText) {
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
  let images = 0;
  let paths = 0;
  for (const fn of (await page.getOperatorList()).fnArray) {
    if (imageOps.has(fn)) images++;
    else if (fn === pdfjs.OPS.constructPath) paths++;
  }
  return images >= 3 || paths >= 40 || (images > 0 && !hasText);
}

// bytes: ArrayBuffer. pdf: { load() → pdf.js, renderPage(page) → Blob | null },
// the pdf.js build and the page renderer for this environment (the browser
// build with a canvas in the extension, the legacy build in Node).
// Returns { md, assets: Map(name → { blob }) }.
export async function pdfToMd(bytes, { fileId, pdf }) {
  const lib = await pdf.load();
  // pdf.js hands the buffer to its worker, which empties it: give it a copy.
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const contents = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    contents.push({ ...(await page.getTextContent()), view: page.view });
  }

  for (const c of contents) if (scrambled(c)) Object.assign(c, { items: [], scrambled: true }); // left out of the layout

  const assets = new Map();
  const out = [];
  for (const [i, { md, bodyChars }] of pagesToMd(contents).entries()) {
    let pageMd = md;
    const name = imageName(`${fileId}-p${i + 1}.jpg`);
    if (contents[i].scrambled) {
      const blob = assets.size < MAX_RENDERED_PAGES ? await render(pdf.renderPage, doc, i + 1) : null;
      if (blob) assets.set(name, { blob });
      pageMd = blob ? `_(this page's text is scrambled in the file, so it is sent as a picture)_\n\n${imageRef(name)}` : "_(this page's text is scrambled in the file and can't be read)_";
    } else if (bodyChars < 80 && assets.size < MAX_RENDERED_PAGES) {
      const blob = await renderIfPicture(lib, pdf.renderPage, doc, i + 1, Boolean(md));
      if (blob) {
        assets.set(name, { blob });
        pageMd = [md, imageRef(name)].filter(Boolean).join('\n\n'); // keep the (short) text too
      }
    }
    if (pageMd) out.push(`[p.${i + 1}]\n${pageMd}`);
  }
  await task.destroy();
  return { md: out.join('\n\n'), assets };
}

// JPEG of page n, or null if it can't be drawn.
async function render(renderPage, doc, n) {
  try {
    return await renderPage(await doc.getPage(n));
  } catch {
    return null;
  }
}

// JPEG of page n if it is a picture page, else null. Any failure also gives
// null, so the page keeps its text version.
async function renderIfPicture(lib, renderPage, doc, n, hasText) {
  try {
    const page = await doc.getPage(n);
    return (await isPicturePage(lib, page, hasText)) ? await renderPage(page) : null;
  } catch {
    return null;
  }
}
