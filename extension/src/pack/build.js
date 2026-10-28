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
import { converterFor, unreadableReason } from './formats/index.js';
import { htmlToMd } from './formats/html-to-md.js';
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf, imageName } from './names.js';
import { codeTags } from './md.js';

const MAX_BYTES = 100 * 1024 * 1024;
const PARALLEL = 3;

export const isImage = (fileName) => IMAGE_EXTS.has(extOf(fileName));
// Whether the pack can read this file (as text or as a picture).
export const isReadable = (fileName) => isImage(fileName) || Boolean(converterFor(fileName));
export { unreadableReason };

export function createPackBuilder({ files, pdf }) {
  const metas = new Map(); // file id → Promise<meta>
  const conversions = new Map(); // file id → Promise<{ md, assets }>
  const meta = (id) => {
    if (!metas.has(id)) metas.set(id, files.meta(id).catch((e) => (metas.delete(id), Promise.reject(e))));
    return metas.get(id);
  };

  // Converts one file (or a file inside an archive) by its format. fileId
  // names its pictures; a file inside an archive adds its path, so two
  // documents in one zip keep their own pictures. `budget` is the archive's
  // limits, shared with any zip inside it.
  async function convertBytes(name, bytes, fileId, budget) {
    const converter = converterFor(name);
    if (!converter) return null;
    const input = converter.binary ? bytes : new TextDecoder().decode(bytes);
    return converter.convert(input, {
      fileId, pdf, isReadable, budget,
      convertEntry: (entryName, entryBytes, entryBudget) => convertBytes(entryName, entryBytes, `${fileId}/${entryName}`, entryBudget),
    });
  }

  async function convertFile(item) {
    const info = await meta(item.id);
    if (info.locked) throw new Error(info.locked);
    if (info.size > MAX_BYTES) throw new Error('too large');
    const result = await convertBytes(item.fileName, await files.bytes(info.url), item.id);
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
        const name = imageName(`${id}-${info.name}`);
        assets.set(name, { url: info.url });
        return `![](images/${name})`;
      };
    };

    const seen = new Set();
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
      if (item.kind === 'page') {
        parts.push(`### ${item.title}\n${htmlToMd(item.html, await pageImages(item.html))}`);
        continue;
      }
      if (item.kind === 'link') {
        parts.push(`### ${item.title}\nLink: ${item.url}`);
        continue;
      }
      const heading = `### ${item.title}`;
      if (item.locked) {
        skipped.push({ title: item.title, reason: item.locked });
        continue;
      }
      if (seen.has(item.id)) {
        parts.push(`${heading}\n_(same file as above)_`);
        continue;
      }
      seen.add(item.id);
      if (isImage(item.fileName)) {
        try {
          const info = await meta(item.id);
          if (info.locked) throw new Error(info.locked);
          const name = imageName(`${item.id}-${info.name}`);
          assets.set(name, { url: info.url });
          parts.push(`${heading}\n![](images/${name})`);
        } catch (e) {
          skipped.push({ title: item.title, reason: e.message });
        }
        continue;
      }
      if (!isReadable(item.fileName)) {
        skipped.push({ title: item.title, reason: unreadableReason(item.fileName) });
        continue;
      }
      try {
        const result = await runs.get(item.id);
        for (const [name, source] of result.assets) assets.set(name, source);
        parts.push(`${heading}\n${result.md || '_(no text found)_'}`);
      } catch (e) {
        skipped.push({ title: item.title, reason: e.message });
      }
    }
    if (skipped.length) parts.push(`## Not included\n${skipped.map((s) => `- ${s.title} (${s.reason})`).join('\n')}`);
    return {
      markdown: `${codeTags(parts.join('\n\n'))}\n`,
      images: [...assets].map(([name, source]) => ({ name, ...source })),
      skipped,
    };
  }

  return { build, meta };
}

// limit(task) runs task() once fewer than n tasks are running; tasks start in
// the order they were given.
function limiter(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < n && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}
