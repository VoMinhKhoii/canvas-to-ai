// HTML (Canvas pages, announcements, .html files) → compact Markdown.
import TurndownService from 'turndown';

const tidy = (s) => s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// HTML → Markdown. Headings are pushed down under our "###" item heading, link
// URLs are dropped (tokens the AI can't use), and lists use compact markers.
// resolveImage(imgNode) returns Markdown for an image, or '' to drop it.
export function htmlToMd(html, resolveImage = () => '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Canvas "Previous / Next" module footer, sometimes pasted into page bodies.
  for (const el of doc.body.querySelectorAll('a[data-api-returntype="Module"], [class*="module-sequence-footer"]')) el.remove();
  // Inline elements laid out apart by CSS ("<b>Customer Portal</b>Architecture lab")
  // would run together as text; put a space between them.
  for (const el of doc.body.querySelectorAll('span, button, label, a, b, strong, em, small')) {
    const next = el.nextSibling;
    if (next && (next.nodeType === Node.ELEMENT_NODE || /^[\p{L}\p{N}]/u.test(next.textContent))) el.after(' ');
  }

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.escape = (s) => s; // Markdown escapes like "1\." only cost tokens
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'nav']);
  td.addRule('shiftHeadings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (_, node) => {
      // Plain text (no **bold** markers), but keep images inside the heading,
      // taken from the DOM rather than re-parsed out of the Markdown.
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      const images = [...node.querySelectorAll('img')].map(resolveImage).filter(Boolean);
      const heading = text && `${'#'.repeat(Math.min(6, Number(node.nodeName[1]) + 3))} ${text}`;
      const out = [heading, ...images].filter(Boolean).join('\n\n');
      return out ? `\n\n${out}\n\n` : '';
    },
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
  return tidy(td.turndown(doc.body));
}
