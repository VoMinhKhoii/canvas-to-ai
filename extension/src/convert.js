// Turns selected Canvas items into one compact Markdown document plus the
// images it references (saved next to it as images/<name>).
import * as pdfjs from 'pdfjs-dist';
import { pagesToMd } from './pdf-layout.js';
import { htmlToMd } from './html-to-md.js';
import { pptxToMd, docxToMd } from './ooxml.js';
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf, imageName } from './names.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const MAX_BYTES = 60 * 1024 * 1024;
const CODE_EXTS = new Set([
  'csv', 'json', 'yml', 'yaml', 'xml', 'sql', 'sh', 'java', 'js', 'jsx', 'ts', 'tsx',
  'py', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'php', 'kt', 'swift', 'rs', 'css', 'scss', 'r', 'm',
]);

const IMAGE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
const MAX_RENDERED_PAGES = 40;

// A page with little text but real drawings (diagram, screenshot, scan) is worth
// sending as a picture. Slide templates draw ~2 images on every page, so plain
// title slides stay text; a page with no text at all but any image is a scan.
async function isPicturePage(page, hasText) {
  let images = 0;
  let paths = 0;
  for (const fn of (await page.getOperatorList()).fnArray) {
    if (IMAGE_OPS.has(fn)) images++;
    else if (fn === pdfjs.OPS.constructPath) paths++;
  }
  return images >= 3 || paths >= 40 || (images > 0 && !hasText);
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1280 / base.width) });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
  await page.render({ canvas, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75)); // null if the canvas is too big
}

// JPEG of page n if it is a picture page, else null. Any failure also gives
// null, so the page keeps its text version.
async function renderIfPicture(doc, n, hasText) {
  try {
    const page = await doc.getPage(n);
    return (await isPicturePage(page, hasText)) ? await renderPage(page) : null;
  } catch {
    return null;
  }
}

async function pdfToMd(buf, fileId, images) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false });
  const doc = await task.promise;
  const contents = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    contents.push({ ...(await page.getTextContent()), height: page.view[3] - page.view[1] });
  }

  const out = [];
  let rendered = 0;
  for (const [i, { md, bodyChars }] of pagesToMd(contents).entries()) {
    const blob = bodyChars < 80 && rendered < MAX_RENDERED_PAGES ? await renderIfPicture(doc, i + 1, Boolean(md)) : null;
    let pageMd = md;
    if (blob) {
      const name = `${fileId}-p${i + 1}.jpg`;
      images.set(name, { blob });
      rendered++;
      pageMd = [md, `![](images/${name})`].filter(Boolean).join('\n\n'); // keep the (short) text too
    }
    if (pageMd) out.push(`[p.${i + 1}]\n${pageMd}`);
  }
  await task.destroy();
  return out.join('\n\n');
}

function notebookToMd(text) {
  const nb = JSON.parse(text);
  const lang = nb.metadata?.kernelspec?.language || 'python';
  return nb.cells
    .map((c) => {
      const src = (Array.isArray(c.source) ? c.source.join('') : c.source).trim();
      if (!src) return '';
      return c.cell_type === 'code' ? `\`\`\`${lang}\n${src}\n\`\`\`` : src;
    })
    .filter(Boolean)
    .join('\n\n');
}

// By extension. Binary converters get an ArrayBuffer and may add images;
// the others get the file's text.
const CONVERTERS = {
  pdf: { binary: true, convert: pdfToMd },
  pptx: { binary: true, convert: pptxToMd },
  docx: { binary: true, convert: docxToMd },
  html: { convert: (text) => htmlToMd(text) },
  htm: { convert: (text) => htmlToMd(text) },
  ipynb: { convert: notebookToMd },
  md: { convert: (text) => text.trim() },
  txt: { convert: (text) => text.trim() },
};
const converterFor = (ext) =>
  CONVERTERS[ext] ?? (CODE_EXTS.has(ext) ? { convert: (text) => `\`\`\`${ext}\n${text.trim()}\n\`\`\`` } : null);

// Returns { md, images } for one file, or throws Error(reason) if it can't be converted.
async function fileToMd(file) {
  const ext = extOf(file.name);
  const converter = converterFor(ext);
  if (!converter) throw new Error(ext ? `.${ext} not supported` : 'unknown type');
  if (file.size > MAX_BYTES) throw new Error('too large');

  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const images = new Map();
  const input = converter.binary ? await res.arrayBuffer() : await res.text();
  return { md: await converter.convert(input, file.id, images), images };
}

const cache = new Map(); // file id → Promise<{ md, images }>

// selected: array of { group, item } in display order.
// Returns { md, skipped, images: [{ name, url } | { name, blob }] }.
export async function buildMarkdown(course, selected, onProgress) {
  const parts = [`# ${course.courseName}`];
  const images = new Map(); // name → { url } | { blob } | null (too small)
  const skipped = [];
  const seen = new Set();
  let lastGroup = null;

  const filesById = new Map();
  for (const g of course.groups) for (const it of g.items) if (it.kind === 'file') filesById.set(it.id, it);
  const canvasImage = (f) => {
    const name = imageName(`${f.id}-${f.name}`);
    images.set(name, { url: f.url });
    return `![](images/${name})`;
  };
  // Images inside Canvas pages and announcements link to course files by id.
  const pageImage = (node) => {
    const id = /\/files\/(\d+)/.exec(node.getAttribute('src') || '')?.[1];
    const f = id && filesById.get(Number(id));
    if (!f || f.unavailable || !IMAGE_EXTS.has(extOf(f.name)) || f.size < MIN_IMAGE_BYTES) return '';
    return canvasImage(f);
  };

  for (const [n, { group, item }] of selected.entries()) {
    if (group !== lastGroup) {
      parts.push(`## ${group}`);
      lastGroup = group;
    }
    if (item.kind === 'text') {
      parts.push(`### ${item.title}\n${htmlToMd(item.html, pageImage)}`);
      continue;
    }
    if (seen.has(item.id)) {
      parts.push(`### ${item.name}\n_(same file as above)_`);
      continue;
    }
    seen.add(item.id);
    if (IMAGE_EXTS.has(extOf(item.name))) {
      parts.push(`### ${item.name}\n${canvasImage(item)}`);
      continue;
    }
    onProgress?.(`Converting ${n + 1}/${selected.length}: ${item.name}`);
    if (!cache.has(item.id)) cache.set(item.id, fileToMd(item));
    try {
      const result = await cache.get(item.id);
      for (const [name, src] of result.images) images.set(name, src);
      parts.push(`### ${item.name}\n${result.md || '_(no text found)_'}`);
    } catch (e) {
      cache.delete(item.id);
      skipped.push(`- ${item.name} (${e.message})`);
    }
  }
  if (skipped.length) parts.push(`## Not included\n${skipped.join('\n')}`);
  const md = parts.join('\n\n') + '\n';
  return {
    md,
    skipped: skipped.length,
    // Only images the Markdown still references (template logos were filtered out).
    images: [...images].filter(([name, src]) => src && md.includes(`images/${name})`)).map(([name, src]) => ({ name, ...src })),
  };
}
