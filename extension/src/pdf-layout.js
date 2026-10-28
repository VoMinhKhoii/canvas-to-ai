// Rebuilds readable Markdown from pdf.js text content. pdf.js gives text
// fragments in drawing order with positions and font sizes; we regroup them
// into lines in reading order, then detect headings (font size), bullets
// (glyph + indent), code (monospace), drop running headers/footers, and join
// lines that were only wrapped by the layout.
//
// Pure functions (no DOM) so it can be tested in Node.

import { contentHeading, mdTable } from './md.js';

// Glyphs that are always bullets (incl. Symbol/Wingdings private-use code points).
const BULLET_GLYPHS = new Set([...'•●▪■➢►▶∙◦○‣⁃', '\uf0a7', '\uf0b7', '\uf0d8', '\uf076', '\uf0fc', '\uf0e0', '\uf06e']);

// A one-character first fragment is a bullet only with evidence. Sub-bullet
// "o": PowerPoint draws it in Courier before normal text, Word puts a tab-sized
// gap after it. A dash or asterisk needs a gap before the text. Anything else
// (an italic "q" in "q = 10") stays text.
function isGlyphBullet(glyph, next) {
  const g = glyph.str.trim();
  if (BULLET_GLYPHS.has(g)) return true;
  const gap = next.x - (glyph.x + glyph.w);
  if (g === 'o') return (glyph.mono && !next.mono) || gap >= glyph.size * 0.8;
  if (g === '-' || g === '–' || g === '*') return gap > glyph.size * 0.2;
  return false;
}

// Code typeset in a normal font: braces, statements, declarations.
const CODE_START = /^(import|package|public|private|protected|static|return|const|let|var|function|class|interface|def|@\w+|if\s*\(|for\s*\(|while\s*\(|}|\/\/)/;
const looksLikeCode = (t) => /[{}]$/.test(t) || (/;$/.test(t) && /[=(.]/.test(t)) || (CODE_START.test(t) && /[;{(=]/.test(t));

const BULLET_PREFIX = /^[•●▪■➢►▶∙◦○‣⁃]\s*/;

// pages: [{ items, styles, view }]: page.getTextContent() plus page.view, the
// visible page box [x0, y0, x1, y1] that text coordinates are measured in.
// Returns per page { md, bodyChars }: bodyChars counts non-heading text (low =
// the page is mostly a picture).
export function pagesToMd(pages) {
  const pageLines = pages.map(({ items, styles }) => groupByBaseline(toFrags(items, styles)).map(assembleLine).filter((l) => l && l.text));
  const all = pageLines.flat();
  const body = bodySize(all);
  const headingSizes = [...new Set(all.filter((l) => isHeadingLine(l, body)).map((l) => round(l.size)))].sort((a, b) => b - a);
  const margins = pageLines.map((lines, i) => lines.filter((l) => inMargin(l, pages[i].view, body)));
  const repeated = repeatedLines(margins);

  return pageLines.map((lines, i) => {
    const margin = new Set(margins[i]);
    const kept = lines.filter((l) => !(margin.has(l) && (repeated.has(key(l.text)) || /^\d{1,3}$/.test(l.text))));
    const blocks = toBlocks(kept, body, headingSizes);
    const bodyChars = blocks.filter((b) => b.kind !== 'h').reduce((n, b) => n + blockText(b).length, 0);
    return { md: blocksToMd(blocks), bodyChars };
  });
}

// Running headers, footers and page numbers live in the top/bottom 8% of the
// visible page at body size or smaller; only those lines may be dropped.
function inMargin(l, [, bottom, , top], body) {
  const height = top - bottom;
  const y = l.y - bottom; // the page box need not start at y = 0
  return height > 0 && l.size <= body && (y > height * 0.92 || y < height * 0.08);
}

const round = (n) => Math.round(n * 2) / 2;
const key = (text) => text.replace(/\d+/g, '#');

// pdf.js items → { str, x, y, w, size, mono }, top-to-bottom then left-to-right.
function toFrags(items, styles) {
  return items
    .filter((it) => it.str)
    .map((it) => {
      const [, , c, d, x, y] = it.transform;
      return { str: it.str, x, y, w: it.width, size: Math.hypot(c, d) || it.height, mono: styles[it.fontName]?.fontFamily === 'monospace' };
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

// Two fragments of a text line: similar sizes within half a line, or any sizes
// on the same baseline (small caps, mixed fonts). Font boxes overstate glyph
// height, so extents are not compared. Superscripts/subscripts are handled
// separately (scriptBase), so no rule here lets a fragment be offset from the
// line, and a line's anchor never moves: nothing can bridge two rows.
function sameLine(a, b) {
  const [big, small] = a.size >= b.size ? [a, b] : [b, a];
  const d = small.y - big.y;
  if (small.size >= big.size * 0.85) return Math.abs(d) < small.size * 0.5;
  return Math.abs(d) < small.size * 0.25;
}

// The text a fragment is a superscript/subscript of, or null. Needs all of:
// short (≤ 3 characters), smaller, raised or lowered within -0.35..+0.6 em,
// and starting within 1 em after the start of that text (E = mc², x₁).
function scriptBase(f, frags) {
  if (f.str.trim().length > 3) return null;
  return (
    frags.find((g) => {
      if (g === f || !g.str.trim() || f.size >= g.size * 0.85) return false;
      const d = f.y - g.y;
      return d > -g.size * 0.35 && d < g.size * 0.6 && f.x >= g.x && f.x <= g.x + g.w + g.size;
    }) ?? null
  );
}

// Fragments → arrays of fragments, one per line. Scripts are set aside, lines
// are formed from the rest, then each script joins its base text's line.
function groupByBaseline(frags) {
  const base = new Map();
  for (const f of frags) {
    const g = scriptBase(f, frags);
    if (g) base.set(f, g);
  }
  const lines = [];
  const lineOf = new Map();
  for (const f of frags) {
    if (base.has(f)) continue;
    const line = lines.at(-1);
    if (line && sameLine(line.anchor, f)) line.frags.push(f);
    else lines.push({ anchor: f, frags: [f] });
    lineOf.set(f, lines.at(-1));
  }
  for (const [f, g] of base) {
    let root = g;
    while (base.has(root)) root = base.get(root); // script of a script; sizes strictly shrink, so this ends
    lineOf.get(root).frags.push(f);
  }
  return lines.map((l) => l.frags.sort((a, b) => a.x - b.x));
}

// One line's fragments → { text, y, x, size, bullet, mono, cells }, or null if blank.
function assembleLine(frags) {
  const visible = frags.filter((f) => f.str.trim());
  if (!visible.length) return null;
  // Bullet glyph drawn as its own fragment (e.g. "•" or PowerPoint's Courier "o").
  const glyphBullet = visible.length > 1 && visible[0].str.trim().length === 1 && isGlyphBullet(visible[0], visible[1]);
  const textFrags = glyphBullet ? visible.slice(1) : visible;
  const joinFrags = glyphBullet ? frags.slice(frags.indexOf(visible[1])) : frags;

  // Join fragments; a wide gap (> 1.5 em) starts a new table cell.
  const cells = [''];
  let end = null;
  for (const f of joinFrags) {
    const gap = end === null ? 0 : f.x - end;
    if (cells.at(-1).trim() && f.str.trim() && gap > f.size * 1.5) cells.push('');
    else if (gap > f.size * 0.15 && !/\s$/.test(cells.at(-1)) && !/^\s/.test(f.str)) cells[cells.length - 1] += ' ';
    cells[cells.length - 1] += f.str;
    if (f.str.trim()) end = f.x + f.w;
  }
  const cellTexts = cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let text = cellTexts.join(' ');
  let bullet = glyphBullet;
  if (!bullet && BULLET_PREFIX.test(text)) {
    bullet = true;
    text = text.replace(BULLET_PREFIX, '');
  }
  const monoChars = textFrags.filter((f) => f.mono).reduce((n, f) => n + f.str.trim().length, 0);
  const chars = textFrags.reduce((n, f) => n + f.str.trim().length, 0);
  const main = textFrags.reduce((a, b) => (b.size > a.size ? b : a)); // baseline: the biggest text
  return {
    text,
    y: main.y,
    x: visible[0].x,
    size: main.size, // ignore the bullet glyph's size
    bullet,
    mono: !bullet && (monoChars >= chars * 0.8 || looksLikeCode(text)),
    cells: cellTexts.length > 1 ? cellTexts : null,
  };
}

// Most common font size of prose (code is often smaller), weighted by characters.
function bodySize(lines) {
  const weight = new Map();
  const prose = lines.filter((l) => !l.mono);
  for (const l of prose.length ? prose : lines) weight.set(round(l.size), (weight.get(round(l.size)) || 0) + l.text.length);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
}

// Bigger than body text and short; long lines ending in ":" or "." are emphasised sentences.
const isHeadingLine = (l, body) =>
  !l.bullet && !l.mono && l.size >= body * 1.1 && l.text.length <= 120 && !(l.text.length > 50 && /[:.]$/.test(l.text));

// Margin lines (digits ignored, so "Page 3 of 9" matches) on more than half the pages.
function repeatedLines(pageLines) {
  const counts = new Map();
  for (const lines of pageLines) for (const k of new Set(lines.map((l) => key(l.text)))) counts.set(k, (counts.get(k) || 0) + 1);
  const limit = pageLines.length / 2;
  return new Set(pageLines.length >= 4 ? [...counts].filter(([, n]) => n > limit).map(([k]) => k) : []);
}

// Bullet nesting: cluster the x positions of a page's bullets (within 5pt of
// the previous one = same level). Returns rounded x → level.
function bulletLevels(lines) {
  const xs = [...new Set(lines.filter((l) => l.bullet).map((l) => Math.round(l.x)))].sort((a, b) => a - b);
  const levels = new Map();
  let prev = null;
  for (const x of xs) {
    levels.set(x, prev === null ? 0 : x - prev <= 5 ? levels.get(prev) : levels.get(prev) + 1);
    prev = x;
  }
  return levels;
}

// Lines → blocks: { kind: 'h' | 'p' | 'li' | 'code' | 'table', last: line, ... }.
// Each line either extends the previous block or starts a new one.
function toBlocks(lines, body, headingSizes) {
  const levels = bulletLevels(lines);
  const blocks = [];
  for (const line of lines) {
    const prev = blocks.at(-1);
    const gap = prev ? prev.last.y - line.y : Infinity;
    const close = gap <= Math.max(line.size, prev?.last.size || 0) * 1.6;

    if (line.mono) {
      if (prev?.kind === 'code' && gap <= line.size * 3) prev.lines.push(line);
      else blocks.push({ kind: 'code', lines: [line] });
    } else if (isHeadingLine(line, body)) {
      if (prev?.kind === 'h' && gap <= line.size * 2.2 && Math.abs(prev.last.size - line.size) < 1) prev.text += ` ${line.text}`;
      else blocks.push({ kind: 'h', text: line.text, depth: Math.min(2, headingSizes.indexOf(round(line.size))) });
    } else if (line.cells && !line.bullet) {
      // Table rows: consecutive multi-cell lines.
      if (prev?.kind === 'table' && gap <= line.size * 3) prev.rows.push(line.cells);
      else blocks.push({ kind: 'table', rows: [line.cells] });
    } else if (line.bullet) {
      blocks.push({ kind: 'li', text: line.text, level: Math.min(3, levels.get(Math.round(line.x)) ?? 0), bulletX: line.x });
    } else {
      // Wrapped continuation of the previous paragraph or bullet, else a new paragraph.
      const sameSize = prev && Math.abs(prev.last.size - line.size) <= 1;
      const indentOk = prev?.kind === 'li' ? line.x > prev.bulletX : true;
      if ((prev?.kind === 'p' || prev?.kind === 'li') && close && sameSize && indentOk) {
        prev.text = /[a-z]-$/.test(prev.text) ? prev.text + line.text : `${prev.text} ${line.text}`;
      } else {
        blocks.push({ kind: 'p', text: line.text });
      }
    }
    blocks.at(-1).last = line;
  }
  return blocks;
}

function blockText(b) {
  if (b.kind === 'code') return b.lines.map((l) => l.text).join('');
  if (b.kind === 'table') return b.rows.flat().join('');
  return b.text;
}

function blocksToMd(blocks) {
  let out = '';
  for (const [i, b] of blocks.entries()) {
    const sep = i === 0 ? '' : b.kind === 'li' && blocks[i - 1].kind === 'li' ? '\n' : '\n\n';
    if (b.kind === 'h') out += sep + contentHeading(b.depth + 1, b.text);
    else if (b.kind === 'li') out += `${sep}${'  '.repeat(b.level)}- ${b.text}`;
    else if (b.kind === 'p') out += sep + b.text;
    else if (b.kind === 'table') out += sep + (b.rows.length === 1 ? b.rows[0].join(' | ') : mdTable(b.rows)); // lone row: just keep the cells apart
    else {
      const minX = Math.min(...b.lines.map((l) => l.x));
      const code = b.lines.map((l) => ' '.repeat(Math.max(0, Math.round((l.x - minX) / (l.size * 0.6)))) + l.text);
      out += `${sep}\`\`\`\n${code.join('\n')}\n\`\`\``;
    }
  }
  return out;
}
