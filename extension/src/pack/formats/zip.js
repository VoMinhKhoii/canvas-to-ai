// Helpers for the formats that are zips inside (Office, OpenDocument, EPUB, .zip).
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf } from '../names.js';

export const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');

// { blob } for a picture file in the zip; null when it is missing, not a
// picture, or too small to be more than an icon.
export async function picture(zip, path) {
  if (!IMAGE_EXTS.has(extOf(path))) return null;
  const data = await zip.file(path)?.async('uint8array');
  return data && data.length >= MIN_IMAGE_BYTES ? { blob: new Blob([data], { type: `image/${extOf(path).replace('jpg', 'jpeg')}` }) } : null;
}
