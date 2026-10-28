// Turns selected Canvas items into one compact Markdown document plus the
// images it references (saved next to it as images/<name>).
import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';
import { pagesToMd } from './pdf-layout.js';
import { htmlToMd } from './html-to-md.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const MAX_BYTES = 60 * 1024 * 1024;
const MIN_IMAGE_BYTES = 8 * 1024; // smaller embedded images are icons, bullets, logos
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const CODE_EXTS = new Set([
  'txt', 'md', 'csv', 'json', 'yml', 'yaml', 'xml', 'sql', 'sh', 'java', 'js', 'jsx', 'ts', 'tsx',
  'py', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'php', 'kt', 'swift', 'rs', 'css', 'scss', 'r', 'm',
]);

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
// Image files are referenced as ![](images/<name>); a name made only of these
// characters can't break the link or the reference lookup in buildMarkdown.
const imageName = (s) => s.replace(/[^\w.-]+/g, '_');
export const safe = (s) => s.replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'untitled';

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
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
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
    let pageMd = md;
    if (bodyChars < 80 && rendered < MAX_RENDERED_PAGES) {
      try {
        const page = await doc.getPage(i + 1);
        const blob = (await isPicturePage(page, Boolean(md))) && (await renderPage(page)); // toBlob gives null if the canvas is too big
        if (blob) {
          const name = `${fileId}-p${i + 1}.jpg`;
          images.set(name, { blob });
          rendered++;
          pageMd = [md, `![](images/${name})`].filter(Boolean).join('\n\n'); // keep the (short) text too
        }
      } catch {
        // keep the text version of this page
      }
    }
    if (pageMd) out.push(`[p.${i + 1}]\n${pageMd}`);
  }
  await task.destroy();
  return out.join('\n\n');
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const textOf = (el, tag) => [...el.getElementsByTagName(tag)].map((t) => t.textContent).join('');
// Text of one DrawingML paragraph; <a:br/> line breaks become spaces.
const paraText = (p) =>
  [...p.getElementsByTagName('*')]
    .map((e) => (e.tagName === 'a:t' ? e.textContent : e.tagName === 'a:br' ? ' ' : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
const paragraphs = (el) => [...el.getElementsByTagName('a:p')].map(paraText).filter(Boolean);

// Body placeholders are bulleted unless turned off; plain text boxes only when they ask for it.
function isBullet(sp, p) {
  const pPr = p.getElementsByTagName('a:pPr')[0];
  if (pPr?.getElementsByTagName('a:buNone').length) return false;
  return Boolean(sp.getElementsByTagName('p:ph').length || pPr?.getElementsByTagName('a:buChar').length || pPr?.getElementsByTagName('a:buAutoNum').length);
}

// Resolve a relationship target ("slides/slide1.xml", "../media/x.png", "/ppt/...") against a folder.
function resolve(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/');
  for (const seg of target.split('/')) seg === '..' ? parts.pop() : parts.push(seg);
  return parts.join('/');
}

async function rels(zip, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'));
  const f = zip.file(`${dir}/_rels/${partPath.split('/').pop()}.rels`);
  if (!f) return [];
  return [...xml(await f.async('string')).getElementsByTagName('Relationship')].map((r) => ({
    id: r.getAttribute('Id'),
    type: r.getAttribute('Type'),
    path: r.getAttribute('TargetMode') === 'External' ? null : resolve(dir, r.getAttribute('Target')),
  }));
}

// Pictures placed in an OOXML element (slide, paragraph) as [{ id, md }], id being
// the relationship id. Images go into `images` as "<fileId>-<media name>";
// too-small ones are stored as null and skipped.
async function embeddedImages(zip, el, partRels, fileId, images) {
  const out = [];
  const ids = new Set([...el.getElementsByTagName('a:blip')].map((b) => b.getAttribute('r:embed')).filter(Boolean));
  for (const id of ids) {
    const path = partRels.find((r) => r.id === id)?.path;
    if (!path || !IMAGE_EXTS.has(extOf(path))) continue;
    const name = imageName(`${fileId}-${path.split('/').pop()}`);
    if (!images.has(name)) {
      const data = await zip.file(path)?.async('uint8array');
      const type = `image/${extOf(path).replace('jpg', 'jpeg')}`;
      images.set(name, data && data.length >= MIN_IMAGE_BYTES ? { blob: new Blob([data], { type }) } : null);
    }
    if (images.get(name)) out.push({ id, md: `![](images/${name})` });
  }
  return out;
}

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'ftr', 'dt']); // slide number, footer, date

// Top-left corner of a shape, for reading order.
function position(sp) {
  const off = sp.getElementsByTagName('a:off')[0];
  return off ? [Number(off.getAttribute('y')), Number(off.getAttribute('x'))] : [0, 0];
}

async function pptxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const pres = xml(await zip.file('ppt/presentation.xml').async('string'));
  const presRels = await rels(zip, 'ppt/presentation.xml');
  const sldSz = pres.getElementsByTagName('p:sldSz')[0];
  const slideArea = Number(sldSz?.getAttribute('cx') || 12192000) * Number(sldSz?.getAttribute('cy') || 6858000);
  const slidePaths = [...pres.getElementsByTagName('p:sldId')].map(
    (s) => presRels.find((r) => r.id === s.getAttribute('r:id')).path,
  );

  const slides = [];
  for (const [i, path] of slidePaths.entries()) {
    const slide = xml(await zip.file(path).async('string'));
    if (slide.documentElement.getAttribute('show') === '0') continue; // hidden slide
    let title = '';
    const body = [];
    // Shapes are stored in z-order; read them top-to-bottom, left-to-right instead.
    const shapes = [...slide.getElementsByTagName('p:sp')].sort((a, b) => {
      const [ay, ax] = position(a);
      const [by, bx] = position(b);
      return ay - by || ax - bx;
    });
    for (const sp of shapes) {
      const type = sp.getElementsByTagName('p:ph')[0]?.getAttribute('type');
      if (SKIP_PLACEHOLDERS.has(type)) continue;
      if (!title && (type === 'title' || type === 'ctrTitle')) {
        title = paragraphs(sp).join(' ');
        continue;
      }
      for (const p of sp.getElementsByTagName('a:p')) {
        const text = paraText(p).replace(/^(?:[•▪●]\s*|-\s+)/, ''); // typed bullet, not a minus sign
        if (!text || /^\[\d+\]$/.test(text)) continue; // empty or a lone citation marker
        const level = Number(p.getElementsByTagName('a:pPr')[0]?.getAttribute('lvl') || 0);
        const md = isBullet(sp, p) ? `${'  '.repeat(Math.min(level, 3))}- ${text}` : text;
        body.push({ md, template: !sp.getElementsByTagName('p:ph').length }); // free text box, may be a typed-in footer
      }
    }
    for (const tbl of slide.getElementsByTagName('a:tbl')) {
      const rows = [...tbl.getElementsByTagName('a:tr')].map(
        (tr) => `| ${[...tr.getElementsByTagName('a:tc')].map((tc) => paragraphs(tc).join(' ')).join(' | ')} |`,
      );
      if (rows.length) body.push(...[rows[0], rows[0].replace(/[^|]+/g, ' --- '), ...rows.slice(1)].map((md) => ({ md, template: false })));
    }
    const slideRels = await rels(zip, path);
    // Small pictures (< 10% of the slide) and background fills may be template logos.
    const small = new Set();
    for (const blip of slide.getElementsByTagName('a:blip')) {
      let pic = blip;
      while (pic && pic.tagName !== 'p:pic') pic = pic.parentNode;
      const ext = pic?.getElementsByTagName('a:xfrm')[0]?.getElementsByTagName('a:ext')[0];
      const area = ext ? (Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy'))) / slideArea : 0;
      if (area < 0.1) small.add(blip.getAttribute('r:embed'));
    }
    const pictures = (await embeddedImages(zip, slide, slideRels, fileId, images)).map((img) => ({ md: img.md, template: small.has(img.id) }));

    const notesPath = slideRels.find((r) => r.type.endsWith('/notesSlide'))?.path;
    let notes = '';
    if (notesPath) {
      const notesDoc = xml(await zip.file(notesPath).async('string'));
      const bodySp = [...notesDoc.getElementsByTagName('p:sp')].find(
        (sp) => sp.getElementsByTagName('p:ph')[0]?.getAttribute('type') === 'body',
      );
      notes = bodySp ? paragraphs(bodySp).join(' ') : '';
    }
    slides.push({ number: i + 1, title, body, pictures, notes: /^\d*$/.test(notes) ? '' : notes });
  }

  // Template noise, only among template candidates (free text boxes, small
  // pictures): text on most slides (typed-in footers), pictures on 3+ slides
  // (logos). Placeholder text, tables and large pictures are always kept.
  const count = new Map();
  for (const s of slides) for (const md of new Set([...s.body, ...s.pictures].map((l) => l.md))) count.set(md, (count.get(md) || 0) + 1);
  const isNoise = (l) =>
    l.template && (l.md.startsWith('![') ? count.get(l.md) >= 3 : slides.length >= 4 && count.get(l.md) > slides.length / 2);

  return slides
    .map((s) => {
      const lines = [...s.body, ...s.pictures].filter((l) => !isNoise(l)).map((l) => l.md);
      if (!s.title && !lines.length && !s.notes) return '';
      return [`#### Slide ${s.number}${s.title ? `: ${s.title}` : ''}`, ...lines, s.notes && `> Notes: ${s.notes}`].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

async function docxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const body = xml(await zip.file('word/document.xml').async('string')).getElementsByTagName('w:body')[0];
  const docRels = await rels(zip, 'word/document.xml');
  const out = [];
  for (const el of body.children) {
    if (el.tagName === 'w:p') {
      out.push(...(await embeddedImages(zip, el, docRels, fileId, images)).map((img) => img.md));
      const text = textOf(el, 'w:t').trim();
      if (!text) continue;
      const style = el.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') || '';
      const level = /^heading\s?(\d)/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? '1' : null);
      if (level) out.push(`${'#'.repeat(Math.min(6, Number(level) + 3))} ${text}`);
      else if (el.getElementsByTagName('w:numPr').length) out.push(`- ${text}`);
      else out.push(text);
    } else if (el.tagName === 'w:tbl') {
      const rows = [...el.getElementsByTagName('w:tr')].map(
        (tr) => `| ${[...tr.getElementsByTagName('w:tc')].map((tc) => textOf(tc, 'w:t').trim()).join(' | ')} |`,
      );
      if (rows.length) out.push([rows[0], rows[0].replace(/[^|]+/g, ' --- '), ...rows.slice(1)].join('\n'));
    }
  }
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

// Returns { md, images } for one file, or throws Error(reason) if it can't be converted.
async function fileToMd(file) {
  const ext = extOf(file.name);
  const known = ['pdf', 'pptx', 'docx', 'html', 'htm', 'ipynb'].includes(ext) || CODE_EXTS.has(ext);
  if (!known) throw new Error(ext ? `.${ext} not supported` : 'unknown type');
  if (file.size > MAX_BYTES) throw new Error('too large');

  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const images = new Map();
  let md;
  if (ext === 'pdf') md = await pdfToMd(await res.arrayBuffer(), file.id, images);
  else if (ext === 'pptx') md = await pptxToMd(await res.arrayBuffer(), file.id, images);
  else if (ext === 'docx') md = await docxToMd(await res.arrayBuffer(), file.id, images);
  else {
    const text = await res.text();
    if (ext === 'html' || ext === 'htm') md = htmlToMd(text);
    else if (ext === 'ipynb') md = notebookToMd(text);
    else if (ext === 'md' || ext === 'txt') md = text.trim();
    else md = `\`\`\`${ext}\n${text.trim()}\n\`\`\``;
  }
  return { md, images };
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
