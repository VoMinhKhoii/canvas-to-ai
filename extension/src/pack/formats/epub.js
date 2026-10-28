// EPUB e-books: the chapters (XHTML) in spine order, through the HTML
// converter, with their pictures.
import JSZip from 'jszip';
import { htmlToMd } from './html-to-md.js';
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf, imageName } from '../names.js';

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
function join(dir, href) {
  const parts = (dir + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const p of parts) p === '..' ? out.pop() : p !== '.' && out.push(p);
  return out.join('/');
}

export async function epub(bytes, { fileId }) {
  const zip = await JSZip.loadAsync(bytes);
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new Error('not an EPUB file');
  const opfPath = xml(await container.async('string')).getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  const opf = xml(await zip.file(opfPath).async('string'));
  const manifest = new Map([...opf.getElementsByTagName('item')].map((it) => [it.getAttribute('id'), it.getAttribute('href')]));
  const spine = [...opf.getElementsByTagName('itemref')].map((ref) => join(dirOf(opfPath), manifest.get(ref.getAttribute('idref')) ?? ''));

  const assets = new Map();
  const chapters = [];
  for (const path of spine) {
    const file = zip.file(path);
    if (!file) continue;
    const html = await file.async('string');
    // Pictures are read up front so the (synchronous) HTML converter can name them.
    const pictures = new Map();
    for (const [, src] of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      const target = join(dirOf(path), src);
      const data = IMAGE_EXTS.has(extOf(target)) && (await zip.file(target)?.async('uint8array'));
      if (data && data.length >= MIN_IMAGE_BYTES) pictures.set(src, { name: imageName(`${fileId}-${target.split('/').pop()}`), blob: new Blob([data], { type: `image/${extOf(target).replace('jpg', 'jpeg')}` }) });
    }
    const md = htmlToMd(html, (img) => {
      const pic = pictures.get(img.getAttribute('src'));
      if (!pic) return '';
      assets.set(pic.name, { blob: pic.blob });
      return `![](images/${pic.name})`;
    });
    if (md) chapters.push(md);
  }
  return { md: chapters.join('\n\n'), assets };
}
