// File-name and file-type helpers (pure, no DOM).

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const MIN_IMAGE_BYTES = 8 * 1024; // smaller embedded images are icons, bullets, logos

export const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

// Image files are referenced as ![](images/<name>); a name made only of
// [A-Za-z0-9._-] can't break the link or the reference lookup. When cleaning
// changes a name, a hash of the original keeps distinct names distinct
// ("plot+1.png" vs "plot_1.png"). A long name (a picture deep inside a zip)
// keeps its end, where the file's own name is, within MAX_NAME characters.
const MAX_NAME = 100;
export function imageName(original) {
  const clean = original.replace(/[^\w.-]+/g, '_');
  if (clean === original && clean.length <= MAX_NAME) return clean;
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of original) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  const dot = clean.lastIndexOf('.');
  const [stem, ext] = dot > 0 && clean.length - dot <= 6 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
  const tag = `-${h.toString(36)}${ext}`;
  return `${stem.slice(-(MAX_NAME - tag.length))}${tag}`;
}

// Safe file/folder name for downloads.
export const safe = (s) => s.replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'untitled';
