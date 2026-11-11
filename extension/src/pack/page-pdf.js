// A Canvas page as a PDF, for Download all: an export is kept to be read, so
// its pages are saved as PDFs a student can open, not as Markdown.
//
//   const doc = pageDoc(title, html, { pictures }); // a pdfmake document
//   const blob = await renderPdf(doc);                     // in the panel
//
// pictures: the page's <img> src → { src: a data: URL (JPEG or PNG, what
// PDFs take), width, height } in pixels. A picture not in it is left out, its
// alt text kept.
import htmlToPdfmake from 'html-to-pdfmake';

const WIDTH = 595.28 - 2 * 56; // A4, less the margins
const HEIGHT = 600; // a picture leaves room for a line or two on its page
const PX = 0.75; // points to a CSS pixel
const GONE = 'script, style, noscript, template, link, meta, form, button, input, select, textarea, svg, math, object, embed, audio, canvas, .screenreader-only';

// plain: without the page's own styles and with its tables as lines of
// text, for a page the PDF maker cannot take as it is.
export function pageDoc(title, html, { pictures = new Map(), plain = false } = {}) {
  const body = new DOMParser().parseFromString(html ?? '', 'text/html').body;
  for (const el of body.querySelectorAll(GONE)) el.remove();
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
    a.setAttribute('href', src);
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
  if (plain) {
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

  const content = htmlToPdfmake(body.innerHTML, { window: globalThis, removeExtraBlanks: true, ignoreStyles: ['font-family'], defaultStyles: { a: { color: '#1a5fb4', decoration: 'underline' } } });
  fit(content, sizes);
  return {
    info: { title },
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 56],
    content: [{ text: title, style: 'title' }, ...[content].flat()],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 },
    styles: { title: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] } },
  };
}

// Every picture at its own size, but no wider than the page nor taller than
// most of it.
function fit(node, sizes) {
  if (Array.isArray(node)) return node.forEach((n) => fit(n, sizes));
  if (!node || typeof node !== 'object') return;
  if (node.image) {
    const { width, height } = sizes.get(node.image);
    delete node.width;
    delete node.height;
    node.fit = [Math.min(WIDTH, width * PX), Math.min(HEIGHT, height * PX)];
  }
  for (const key of ['stack', 'text', 'ul', 'ol', 'columns']) fit(node[key], sizes);
  if (node.table?.body) node.table.body.forEach((row) => fit(row, sizes));
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
