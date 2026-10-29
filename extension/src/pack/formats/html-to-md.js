// HTML (Canvas pages, announcements, .html files) → compact Markdown.
import TurndownService from 'turndown';
import { contentHeading, mdTable } from '../md.js';

// Spaces and tabs at line ends go line by line: /[ \t]+\n/ rescans a long run
// of spaces from each of its spaces when no newline follows it (quadratic).
const trimLineEnd = (line) => {
  let end = line.length;
  while (end && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return line.slice(0, end);
};
const tidy = (s) => {
  const lines = s.replace(/\u00a0/g, ' ').split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? trimLineEnd(l) : l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const MAX_BLANKS = 64;
const LONG_BLANKS = /\s{65,}/g; // \s includes &nbsp;

// HTML → Markdown. Headings are pushed down under our "###" item heading, link
// URLs are dropped (tokens the AI can't use), and lists use compact markers.
// resolveImage(imgNode) returns Markdown for an image, or '' to drop it.
export function htmlToMd(html, resolveImage = () => '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Canvas "Previous / Next" module footer, sometimes pasted into page bodies.
  // Only the footer's buttons go: ordinary links to a module in a sentence
  // ("visit Getting Started") keep their text.
  for (const el of doc.body.querySelectorAll('[class*="module-sequence-footer"]')) (el.closest('a') ?? el).remove();
  // Inline elements laid out apart by CSS ("<b>Customer Portal</b>Architecture lab")
  // would run together as text; put a space between them.
  // Code is literal: highlighted code is spans too.
  for (const el of doc.body.querySelectorAll('span, button, label, a, b, strong, em, small')) {
    if (el.closest('pre, code')) continue;
    const next = el.nextSibling;
    if (next && (next.nodeType === Node.ELEMENT_NODE || /^[\p{L}\p{N}]/u.test(next.textContent))) el.after(' ');
  }

  // Turndown's last step (/[\t\r\n\s]+$/ over its whole output) rescans a run
  // of whitespace from each of its characters: a page of 80k &nbsp; takes
  // seconds. No reader needs more than 64 blanks in a row (code indents
  // included), so longer runs are cut before conversion.
  const cutBlanks = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.data.length > MAX_BLANKS) child.data = child.data.replace(LONG_BLANKS, (run) => run.slice(0, MAX_BLANKS));
      } else cutBlanks(child);
    }
  };
  doc.body.normalize(); // one text node per run, as browsers parse it
  cutBlanks(doc.body);

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
      const heading = text && contentHeading(Number(node.nodeName[1]), text);
      const out = [heading, ...images].filter(Boolean).join('\n\n');
      return out ? `\n\n${out}\n\n` : '';
    },
  });
  td.addRule('linkText', { filter: 'a', replacement: (content) => content });
  td.addRule('table', { filter: 'table', replacement: (content, node) => tableToMd(node, content, resolveImage) });
  td.addRule('rule', { filter: 'hr', replacement: () => '\n\n' }); // "* * *" only costs tokens
  td.addRule('image', { filter: 'img', replacement: (_, node) => resolveImage(node) });
  const itemIndex = new Map(); // <ol> → its children's positions, found once (not per item: quadratic)
  const indexIn = (parent, node) => {
    if (!itemIndex.has(parent)) itemIndex.set(parent, new Map([...parent.children].map((c, i) => [c, i])));
    return itemIndex.get(parent).get(node) ?? -1;
  };
  td.addRule('compactListItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode;
      const prefix = parent.nodeName === 'OL' ? `${Number(parent.getAttribute('start') || 1) + indexIn(parent, node)}. ` : '- ';
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });
  return tidy(td.turndown(doc.body));
}

// A data table becomes a Markdown table of its cells' text (a timetable, an
// assessment list), with any pictures in its cells after it. A one-column
// table is page layout: keep its content as is.
function tableToMd(table, content, resolveImage) {
  const rows = [];
  for (const child of table.children) {
    const trs = child.tagName === 'TR' ? [child] : ['THEAD', 'TBODY', 'TFOOT'].includes(child.tagName) ? [...child.children] : [];
    for (const tr of trs) {
      const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      if (cells.length) rows.push(cells.map(cellText));
    }
  }
  if (rows.every((r) => r.length < 2)) return `\n\n${content}\n\n`;
  const caption = table.querySelector('caption')?.textContent.replace(/\s+/g, ' ').trim();
  const images = [...table.querySelectorAll('img')].map(resolveImage).filter(Boolean);
  return `\n\n${[caption, mdTable(rows), ...images].filter(Boolean).join('\n\n')}\n\n`;
}

// A cell's text with its paragraphs, lines and list items kept apart by " · "
// ("Lecture: Cache architecture · Lab: Redis"), not run together.
function cellText(cell) {
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const block = /^(P|DIV|LI|BR|UL|OL|H[1-6])$/.test(child.tagName);
        if (block) parts.push('\n');
        walk(child);
        if (block) parts.push('\n');
      }
    }
  };
  walk(cell);
  return parts.join('').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}
