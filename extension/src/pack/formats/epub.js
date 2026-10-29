// EPUB e-books: the chapters (XHTML) in spine order, through the HTML
// converter, with their pictures.
import JSZip from 'jszip';
import { htmlToMd } from './html-to-md.js';
import { imageName, imageRef } from '../names.js';
import { xml, picture } from './zip.js';

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
    for (const [, src] of html.matchAll(/<img[^<>]+src="([^"]+)"/g)) { // [^<>]: a run of "<img" with no ">" is not rescanned
      const target = join(dirOf(path), src);
      const pic = await picture(zip, target);
      if (pic) pictures.set(src, { name: imageName(`${fileId}-${target}`), ...pic });
    }
    const md = htmlToMd(html, (img) => {
      const pic = pictures.get(img.getAttribute('src'));
      if (!pic) return '';
      assets.set(pic.name, { blob: pic.blob });
      return imageRef(pic.name);
    });
    if (md) chapters.push(md);
  }
  return { md: chapters.join('\n\n'), assets };
}
