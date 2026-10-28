// Turns selected Canvas items into one compact Markdown document plus the
// images it references (saved next to it as images/<name>).
import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';
import TurndownService from 'turndown';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const MAX_BYTES = 60 * 1024 * 1024;
const MIN_IMAGE_BYTES = 8 * 1024; // smaller embedded images are icons, bullets, logos
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const CODE_EXTS = new Set([
  'txt', 'md', 'csv', 'json', 'yml', 'yaml', 'xml', 'sql', 'sh', 'java', 'js', 'jsx', 'ts', 'tsx',
  'py', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'php', 'kt', 'swift', 'rs', 'css', 'scss', 'r', 'm',
]);

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const safe = (s) => s.replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'untitled';
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// HTML → Markdown. Headings are pushed down under our "###" item heading, link
// URLs are dropped (tokens the AI can't use), and lists use compact markers.
// resolveImage(imgNode) returns Markdown for an image, or '' to drop it.
function htmlToMd(html, resolveImage = () => '') {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg']);
  td.addRule('shiftHeadings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => `\n\n${'#'.repeat(Math.min(6, Number(node.nodeName[1]) + 3))} ${content.trim()}\n\n`,
  });
  td.addRule('linkText', { filter: 'a', replacement: (content) => content });
  td.addRule('image', { filter: 'img', replacement: (_, node) => resolveImage(node) });
  td.addRule('compactListItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode;
      const prefix = parent.nodeName === 'OL' ? `${Number(parent.getAttribute('start') || 1) + [...parent.children].indexOf(node)}. ` : '- ';
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });
  return tidy(td.turndown(html));
}

async function pdfToMd(buf) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    const text = items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
    pages.push(text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean));
  }
  await task.destroy();

  // Drop running headers/footers (lines on most pages) and bare page numbers.
  const counts = new Map();
  for (const lines of pages) for (const l of new Set(lines)) counts.set(l, (counts.get(l) || 0) + 1);
  const repeated = (l) => pages.length >= 4 && counts.get(l) > pages.length / 2;
  return pages
    .map((lines, i) => {
      const kept = lines.filter((l) => !repeated(l) && !/^\d{1,3}$/.test(l));
      return kept.length ? `[p.${i + 1}]\n${kept.join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const textOf = (el, tag) => [...el.getElementsByTagName(tag)].map((t) => t.textContent).join('');
const paragraphs = (el) =>
  [...el.getElementsByTagName('a:p')].map((p) => textOf(p, 'a:t').trim()).filter(Boolean);

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

// Markdown image lines for pictures placed in an OOXML element (slide, paragraph).
// Images go into `images` as "<fileId>-<media name>"; too-small ones are stored as null.
async function embeddedImages(zip, el, partRels, fileId, images) {
  const out = [];
  const ids = new Set([...el.getElementsByTagName('a:blip')].map((b) => b.getAttribute('r:embed')).filter(Boolean));
  for (const id of ids) {
    const path = partRels.find((r) => r.id === id)?.path;
    if (!path || !IMAGE_EXTS.has(extOf(path))) continue;
    const name = `${fileId}-${path.split('/').pop()}`;
    if (!images.has(name)) {
      const blob = await zip.file(path)?.async('blob');
      images.set(name, blob && blob.size >= MIN_IMAGE_BYTES ? { blob } : null);
    }
    if (images.get(name)) out.push(`![](images/${name})`);
  }
  return out;
}

async function pptxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const pres = xml(await zip.file('ppt/presentation.xml').async('string'));
  const presRels = await rels(zip, 'ppt/presentation.xml');
  const slidePaths = [...pres.getElementsByTagName('p:sldId')].map(
    (s) => presRels.find((r) => r.id === s.getAttribute('r:id')).path,
  );

  const out = [];
  for (const [i, path] of slidePaths.entries()) {
    const slide = xml(await zip.file(path).async('string'));
    if (slide.documentElement.getAttribute('show') === '0') continue; // hidden slide
    let title = '';
    const body = [];
    for (const sp of slide.getElementsByTagName('p:sp')) {
      const type = sp.getElementsByTagName('p:ph')[0]?.getAttribute('type');
      const lines = paragraphs(sp);
      if (!title && (type === 'title' || type === 'ctrTitle')) title = lines.join(' ');
      else body.push(...lines.map((l) => `- ${l}`));
    }
    for (const tbl of slide.getElementsByTagName('a:tbl')) {
      for (const tr of tbl.getElementsByTagName('a:tr')) {
        body.push(`| ${[...tr.getElementsByTagName('a:tc')].map((tc) => paragraphs(tc).join(' ')).join(' | ')} |`);
      }
    }
    const slideRels = await rels(zip, path);
    body.push(...(await embeddedImages(zip, slide, slideRels, fileId, images)));

    const notesPath = slideRels.find((r) => r.type.endsWith('/notesSlide'))?.path;
    let notes = '';
    if (notesPath) {
      const notesDoc = xml(await zip.file(notesPath).async('string'));
      const bodySp = [...notesDoc.getElementsByTagName('p:sp')].find(
        (sp) => sp.getElementsByTagName('p:ph')[0]?.getAttribute('type') === 'body',
      );
      notes = bodySp ? paragraphs(bodySp).join(' ') : '';
    }

    if (!title && !body.length && !notes) continue;
    out.push([`#### Slide ${i + 1}${title ? `: ${title}` : ''}`, ...body, notes && `> Notes: ${notes}`].filter(Boolean).join('\n'));
  }
  return out.join('\n\n');
}

async function docxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const body = xml(await zip.file('word/document.xml').async('string')).getElementsByTagName('w:body')[0];
  const docRels = await rels(zip, 'word/document.xml');
  const out = [];
  for (const el of body.children) {
    if (el.tagName === 'w:p') {
      out.push(...(await embeddedImages(zip, el, docRels, fileId, images)));
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
  if (ext === 'pdf') md = await pdfToMd(await res.arrayBuffer());
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
    const name = `${f.id}-${safe(f.name).replace(/\s+/g, '_')}`; // no spaces: they break ![](path)
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
  return {
    md: parts.join('\n\n') + '\n',
    skipped: skipped.length,
    images: [...images].filter(([, src]) => src).map(([name, src]) => ({ name, ...src })),
  };
}
