// PowerPoint (.pptx) and Word (.docx) → Markdown. Both are zips of XML parts
// linked by relationship files; pictures are saved into `images`.
import JSZip from 'jszip';
import { contentHeading, mdTable } from './md.js';
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf, imageName } from './names.js';

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const readXml = async (zip, path) => xml(await zip.file(path).async('string'));
const textOf = (el, tag) => [...el.getElementsByTagName(tag)].map((t) => t.textContent).join('');
// Text of one DrawingML paragraph; <a:br/> line breaks become spaces.
const paraText = (p) =>
  [...p.getElementsByTagName('*')]
    .map((e) => (e.tagName === 'a:t' ? e.textContent : e.tagName === 'a:br' ? ' ' : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
const paragraphs = (el) => [...el.getElementsByTagName('a:p')].map(paraText).filter(Boolean);
const placeholderType = (sp) => sp.getElementsByTagName('p:ph')[0]?.getAttribute('type');
const isPlaceholder = (sp) => sp.getElementsByTagName('p:ph').length > 0;

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

// ---------- PowerPoint ----------

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'ftr', 'dt']); // slide number, footer, date

// Top-left corner of a shape, for reading order.
function position(sp) {
  const off = sp.getElementsByTagName('a:off')[0];
  return off ? [Number(off.getAttribute('y')), Number(off.getAttribute('x'))] : [0, 0];
}

// Shapes are stored in z-order; read them top-to-bottom, left-to-right instead.
function slideShapes(slide) {
  return [...slide.getElementsByTagName('p:sp')].sort((a, b) => {
    const [ay, ax] = position(a);
    const [by, bx] = position(b);
    return ay - by || ax - bx;
  });
}

// Body placeholders are bulleted unless turned off; plain text boxes only when they ask for it.
function isBullet(sp, p) {
  const pPr = p.getElementsByTagName('a:pPr')[0];
  if (pPr?.getElementsByTagName('a:buNone').length) return false;
  return Boolean(isPlaceholder(sp) || pPr?.getElementsByTagName('a:buChar').length || pPr?.getElementsByTagName('a:buAutoNum').length);
}

// Title plus body lines as [{ md, template }]; template marks free text boxes,
// which may be typed-in footers.
function slideText(slide) {
  let title = '';
  const body = [];
  for (const sp of slideShapes(slide)) {
    const type = placeholderType(sp);
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
      body.push({ md, template: !isPlaceholder(sp) });
    }
  }
  for (const tbl of slide.getElementsByTagName('a:tbl')) {
    const rows = [...tbl.getElementsByTagName('a:tr')].map((tr) => [...tr.getElementsByTagName('a:tc')].map((tc) => paragraphs(tc).join(' ')));
    if (rows.length) body.push(...mdTable(rows).split('\n').map((md) => ({ md, template: false })));
  }
  return { title, body };
}

// Share of the slide each picture covers, by relationship id (the largest
// placement wins). Pictures used as fills or backgrounds are not placed: 0.
function pictureAreas(slide, slideArea) {
  const areas = new Map();
  for (const blip of slide.getElementsByTagName('a:blip')) {
    let pic = blip;
    while (pic && pic.tagName !== 'p:pic') pic = pic.parentNode;
    const ext = pic?.getElementsByTagName('a:xfrm')[0]?.getElementsByTagName('a:ext')[0];
    const area = ext ? (Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy'))) / slideArea : 0;
    const id = blip.getAttribute('r:embed');
    areas.set(id, Math.max(areas.get(id) ?? 0, area));
  }
  return areas;
}

// A placed picture under 1% of the slide (about 0.7 inch square) is an icon
// or a bullet: on its own it tells the AI nothing and costs an image.
const ICON_AREA = 0.01;
// Pictures under 10% of the slide, or used as fills, may be template logos.
const SMALL_AREA = 0.1;

async function slideNotes(zip, slideRels) {
  const notesPath = slideRels.find((r) => r.type.endsWith('/notesSlide'))?.path;
  if (!notesPath) return '';
  const bodySp = [...(await readXml(zip, notesPath)).getElementsByTagName('p:sp')].find((sp) => placeholderType(sp) === 'body');
  const notes = bodySp ? paragraphs(bodySp).join(' ') : '';
  return /^\d*$/.test(notes) ? '' : notes; // just the slide number
}

// { title, body, pictures, notes } for a visible slide, null for a hidden one.
async function readSlide(zip, path, slideArea, fileId, images) {
  const slide = await readXml(zip, path);
  if (slide.documentElement.getAttribute('show') === '0') return null;
  const slideRels = await rels(zip, path);
  const areas = pictureAreas(slide, slideArea);
  const pictures = (await embeddedImages(zip, slide, slideRels, fileId, images))
    .filter((img) => !(areas.get(img.id) > 0 && areas.get(img.id) < ICON_AREA))
    .map((img) => ({ md: img.md, template: (areas.get(img.id) ?? 0) < SMALL_AREA }));
  return { ...slideText(slide), pictures, notes: await slideNotes(zip, slideRels) };
}

// Template noise, only among template candidates (free text boxes, small
// pictures): text on most slides (typed-in footers), pictures on 3+ slides
// (logos). Placeholder text, tables and large pictures are always kept.
function templateNoise(slides) {
  const counts = (key) => {
    const c = new Map();
    for (const s of slides) for (const md of new Set(s[key].map((l) => l.md))) c.set(md, (c.get(md) || 0) + 1);
    return c;
  };
  const text = counts('body');
  const pictures = counts('pictures');
  return {
    body: (l) => l.template && slides.length >= 4 && text.get(l.md) > slides.length / 2,
    pictures: (l) => l.template && pictures.get(l.md) >= 3,
  };
}

function renderSlide(s, noise) {
  const lines = [...s.body.filter((l) => !noise.body(l)), ...s.pictures.filter((l) => !noise.pictures(l))].map((l) => l.md);
  if (!s.title && !lines.length && !s.notes) return '';
  return [contentHeading(1, `Slide ${s.number}${s.title ? `: ${s.title}` : ''}`), ...lines, s.notes && `> Notes: ${s.notes}`]
    .filter(Boolean)
    .join('\n');
}

export async function pptxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const pres = await readXml(zip, 'ppt/presentation.xml');
  const presRels = await rels(zip, 'ppt/presentation.xml');
  const sldSz = pres.getElementsByTagName('p:sldSz')[0];
  const slideArea = Number(sldSz?.getAttribute('cx') || 12192000) * Number(sldSz?.getAttribute('cy') || 6858000);
  const slidePaths = [...pres.getElementsByTagName('p:sldId')].map((s) => presRels.find((r) => r.id === s.getAttribute('r:id')).path);

  const slides = [];
  for (const [i, path] of slidePaths.entries()) {
    const slide = await readSlide(zip, path, slideArea, fileId, images);
    if (slide) slides.push({ number: i + 1, ...slide });
  }
  const noise = templateNoise(slides);
  return slides.map((s) => renderSlide(s, noise)).filter(Boolean).join('\n\n');
}

// ---------- Word ----------

export async function docxToMd(buf, fileId, images) {
  const zip = await JSZip.loadAsync(buf);
  const body = (await readXml(zip, 'word/document.xml')).getElementsByTagName('w:body')[0];
  const docRels = await rels(zip, 'word/document.xml');
  const out = [];
  for (const el of body.children) {
    if (el.tagName === 'w:p') {
      out.push(...(await embeddedImages(zip, el, docRels, fileId, images)).map((img) => img.md));
      const text = textOf(el, 'w:t').trim();
      if (!text) continue;
      const style = el.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') || '';
      const level = /^heading\s?(\d)/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? '1' : null);
      if (level) out.push(contentHeading(Number(level), text));
      else if (el.getElementsByTagName('w:numPr').length) out.push(`- ${text}`);
      else out.push(text);
    } else if (el.tagName === 'w:tbl') {
      const rows = [...el.getElementsByTagName('w:tr')].map((tr) => [...tr.getElementsByTagName('w:tc')].map((tc) => textOf(tc, 'w:t').trim()));
      if (rows.length) out.push(mdTable(rows));
    }
  }
  return out.join('\n\n');
}
