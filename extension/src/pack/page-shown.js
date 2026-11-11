// What a Canvas page's PDF can show, kept apart from the PDF maker (which
// loads only when a page is saved): the page's body as it will be drawn, the
// letters and symbols the font draws, and the pictures a PDF holds.
//
//   const { body, sizes } = pageBody(html, { pictures, base });
//   lacksLetters(title, html)   // letters the font cannot draw: keep it Markdown
//   drawable(text)              // the text as the font can draw it
//   pictureData(bytes)          // { src: data: URL, width, height } | null
//
// pictures: the page's <img> src → pictureData(); a picture not in it is
// left out, its alt text kept. base: the Canvas site the page's own links
// (/courses/…) are on.
import { COVERED } from './font-coverage.js';

const GONE = 'script, style, noscript, template, link, meta, form, button, input, select, textarea, svg, math, object, embed, audio, canvas, .screenreader-only';
export const PDF_PICTURE_EXTS = new Set(['png', 'jpg', 'jpeg']); // what a PDF holds
// A page's PDF before its text and pictures: mostly its font.
export const pdfSize = (html) => 30 * 1024 + html.length;

// The page as it will be drawn: what a reader cannot see gone, links made
// whole, embeds as their links, pictures as data (sizes: data: URL → pixels)
// or as their alt text.
export function pageBody(html, { pictures = new Map(), base } = {}) {
  const body = new DOMParser().parseFromString(html ?? '', 'text/html').body;
  for (const el of body.querySelectorAll(GONE)) el.remove();
  const absolute = (url) => {
    try {
      return base ? new URL(url, base).href : url;
    } catch {
      return url;
    }
  };
  for (const a of body.querySelectorAll('a[href]')) a.setAttribute('href', absolute(a.getAttribute('href')));
  const text = (s) => body.ownerDocument.createTextNode(s);
  // An embedded video or tool becomes its link.
  for (const el of body.querySelectorAll('iframe, video')) {
    const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src');
    if (!src) {
      el.remove();
      continue;
    }
    const p = body.ownerDocument.createElement('p');
    const a = Object.assign(body.ownerDocument.createElement('a'), { textContent: el.getAttribute('title') || src });
    a.setAttribute('href', absolute(src));
    p.append(text('Embedded: '), a);
    el.replaceWith(p);
  }
  const sizes = new Map(); // data: URL → its size in pixels
  for (const img of body.querySelectorAll('img')) {
    const picture = pictures.get(img.getAttribute('src'));
    if (picture) {
      img.setAttribute('src', picture.src);
      for (const a of ['width', 'height', 'style']) img.removeAttribute(a); // sized below, to fit the page
      sizes.set(picture.src, picture);
    } else {
      img.replaceWith(text(img.getAttribute('alt') ? `[${img.getAttribute('alt')}]` : ''));
    }
  }
  return { body, sizes };
}

// For a page the PDF maker cannot take as it is: no styles, and tables as
// lines of text.
export function flatten(body) {
  for (const el of body.querySelectorAll('[style], [class]')) ['style', 'class'].forEach((a) => el.removeAttribute(a));
  for (const table of [...body.querySelectorAll('table')].reverse()) { // the innermost first
    const lines = [...table.querySelectorAll('tr')].map((tr) => {
      const p = body.ownerDocument.createElement('p');
      p.textContent = [...tr.children].map((cell) => cell.textContent.trim()).filter(Boolean).join(' · ');
      return p;
    });
    table.replaceWith(...lines);
  }
}

// What the font cannot draw would be an empty box: an arrow or a tick becomes
// its look-alike, any other symbol or emoji is left out, and a page with
// letters it cannot draw (Chinese, Japanese, Korean, Arabic, Thai…) is not
// made a PDF at all (lacksLetters), or its text would be lost.
const LOOK_ALIKE = { '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '⇔': '<=>', '✓': '√', '✔': '√', '☑': '√' };
function drawn(c) {
  const cp = c.codePointAt(0);
  let lo = 0;
  let hi = COVERED.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < COVERED[mid][0]) hi = mid - 1;
    else if (cp > COVERED[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}
const letters = (text) => [...text.normalize('NFC')]; // a decomposed ắ is drawn as one letter
export const drawable = (text) => letters(text).map((c) => (drawn(c) || /\s/.test(c) ? c : LOOK_ALIKE[c] ?? '')).join('');
// What a page shows as text, entities decoded, alt text and embeds' titles too.
export function lacksLetters(title, html = '') {
  return letters(`${title} ${pageBody(html).body.textContent}`).some((c) => /\p{L}/u.test(c) && !drawn(c));
}

// A picture's bytes as pdfmake takes them, or null for a kind a PDF cannot
// hold (GIF, WebP, SVG…).
export function pictureData(bytes) {
  const b = new Uint8Array(bytes);
  const at = (i) => (b[i] << 8) | b[i + 1];
  let type;
  let size;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    type = 'png';
    size = { width: at(18), height: at(22) }; // IHDR, big-endian; no picture is 65,536 pixels wide
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    type = 'jpeg';
    // The frame header (SOF0-15 but DHT, JPG, DAC) holds the size.
    for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + at(i + 2)) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        size = { height: at(i + 5), width: at(i + 7) };
        break;
      }
    }
  }
  if (!size?.width || !size.height) return null;
  let binary = '';
  for (let i = 0; i < b.length; i += 0x8000) binary += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { src: `data:image/${type};base64,${btoa(binary)}`, ...size };
}
