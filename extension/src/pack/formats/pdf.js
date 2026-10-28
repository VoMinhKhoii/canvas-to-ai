// PDF → Markdown: text through pdf-layout.js; pages that are mostly a picture
// (diagrams, scans) are rendered and added as images.
import { pagesToMd } from './pdf-layout.js';

const MAX_RENDERED_PAGES = 40;

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

  const assets = new Map();
  const out = [];
  for (const [i, { md, bodyChars }] of pagesToMd(contents).entries()) {
    let pageMd = md;
    if (bodyChars < 80 && assets.size < MAX_RENDERED_PAGES) {
      const blob = await renderIfPicture(lib, pdf.renderPage, doc, i + 1, Boolean(md));
      if (blob) {
        const name = `${fileId}-p${i + 1}.jpg`;
        assets.set(name, { blob });
        pageMd = [md, `![](images/${name})`].filter(Boolean).join('\n\n'); // keep the (short) text too
      }
    }
    if (pageMd) out.push(`[p.${i + 1}]\n${pageMd}`);
  }
  await task.destroy();
  return { md: out.join('\n\n'), assets };
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
