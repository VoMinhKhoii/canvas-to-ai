// The pack builder: turns picked items into one Markdown document, the
// pictures it refers to, and the items it could not read (see CONTEXT.md).
//
//   const packs = createPackBuilder({ files, pdf });
//   const { markdown, images, skipped } = await packs.build(course, picked, onProgress);
//
// Adapters (the file seam):
//   files.meta(fileId) → { name, size, url, locked }   Canvas file details
//   files.bytes(url)   → ArrayBuffer
//   pdf.load()         → the pdf.js build;  pdf.renderPage(page) → Blob | null
// Conversions are cached by file id for the builder's lifetime, and run a few
// at a time while the document is assembled in order.
import { convert, isImage, isReadable, unreadableReason } from './formats/index.js';
import { htmlToMd } from './formats/html-to-md.js';
import { MIN_IMAGE_BYTES, imageName, imageRef } from './names.js';
import { codeTags } from './md.js';
import { limiter } from '../limit.js';

const MAX_BYTES = 100 * 1024 * 1024;
const PARALLEL = 3;

export function createPackBuilder({ files, pdf }) {
  const metas = new Map(); // file id → Promise<meta>
  const conversions = new Map(); // file id → Promise<{ md, assets }>
  const meta = (id) => {
    if (!metas.has(id)) metas.set(id, files.meta(id).catch((e) => (metas.delete(id), Promise.reject(e))));
    return metas.get(id);
  };

  async function convertFile(item) {
    const info = await meta(item.id);
    if (info.locked) throw new Error(info.locked);
    if (info.size > MAX_BYTES) throw new Error('too large');
    const result = await convert(item.fileName, await files.bytes(info.url), { fileId: item.id, pdf });
    if (!result) throw new Error(unreadableReason(item.fileName));
    return result;
  }

  function converted(item) {
    if (!conversions.has(item.id)) {
      const run = convertFile(item);
      conversions.set(item.id, run);
      run.catch(() => conversions.delete(item.id)); // a failure is retried next time
    }
    return conversions.get(item.id);
  }

  async function build(course, picked, onProgress = () => {}) {
    const assets = new Map(); // name → { url } | { blob }: only pictures the Markdown uses
    const skipped = [];
    const parts = [`# ${course.name}`];

    // Start every conversion now, at most PARALLEL running at once, in pick
    // order; the document is then assembled in order as each one lands.
    const toConvert = picked.filter(({ item }) => item.kind === 'file' && !item.locked && !isImage(item.fileName) && isReadable(item.fileName));
    const unique = [];
    for (const { item } of toConvert) if (!unique.some((u) => u.id === item.id)) unique.push(item); // first pick names it
    const limit = limiter(PARALLEL);
    let done = 0;
    const runs = new Map(
      unique.map((item) => {
        const run = limit(() => converted(item));
        run.finally(() => onProgress({ done: ++done, total: unique.length, name: item.title })).catch(() => {});
        return [item.id, run];
      }),
    );

    // A Canvas file shown as a picture, fetched by its download link.
    const canvasPicture = (id, info) => {
      const name = imageName(`${id}-${info.name}`);
      assets.set(name, { url: info.url });
      return imageRef(name);
    };

    // Pictures shown in pages are course files: their names and download links
    // are looked up before the page is converted.
    const pageImages = async (html) => {
      const ids = [...new Set([...(html ?? '').matchAll(/<img[^>]+src="[^"]*\/files\/(\d+)/g)].map((m) => Number(m[1])))];
      const found = new Map();
      await Promise.all(ids.map(async (id) => found.set(id, await meta(id).catch(() => null))));
      return (img) => {
        const id = Number(/\/files\/(\d+)/.exec(img.getAttribute('src') || '')?.[1]);
        const info = found.get(id);
        if (!info?.url || info.locked || !isImage(info.name) || info.size < MIN_IMAGE_BYTES) return '';
        return canvasPicture(id, info);
      };
    };

    // What an item becomes under its heading; throws the reason it is left out.
    const seen = new Set();
    async function body(item) {
      if (item.kind === 'page') return htmlToMd(item.html, await pageImages(item.html));
      if (item.kind === 'link') return `Link: ${item.url}`;
      if (item.locked) throw new Error(item.locked);
      if (seen.has(item.id)) return '_(same file as above)_';
      seen.add(item.id);
      if (isImage(item.fileName)) {
        const info = await meta(item.id);
        if (info.locked) throw new Error(info.locked);
        return canvasPicture(item.id, info);
      }
      if (!isReadable(item.fileName)) throw new Error(unreadableReason(item.fileName));
      const result = await runs.get(item.id);
      for (const [name, source] of result.assets) assets.set(name, source);
      return result.md || '_(no text found)_';
    }

    let folder = null;
    let section = null;
    for (const { folder: f, section: s, item } of picked) {
      if (f !== folder) {
        parts.push(`## ${f.title}`);
        folder = f;
        section = null;
      }
      if (s !== section) {
        if (s.title) parts.push(`**${s.title}**`);
        section = s;
      }
      try {
        parts.push(`### ${item.title}\n${await body(item)}`);
      } catch (e) {
        skipped.push({ title: item.title, reason: e.message });
      }
    }
    if (skipped.length) parts.push(`## Not included\n${skipped.map((s) => `- ${s.title} (${s.reason})`).join('\n')}`);
    return {
      markdown: `${codeTags(parts.join('\n\n')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')}\n`, // control characters (scrambled fonts, binary leftovers) mean nothing to an AI
      images: [...assets].map(([name, source]) => ({ name, ...source })),
      skipped,
    };
  }

  return { build, meta };
}

