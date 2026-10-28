// Rebuilds readable Markdown from pdf.js text content. pdf.js gives text
// fragments in drawing order with positions and font sizes; we regroup them
// into lines in reading order, then detect headings (font size), bullets
// (glyph + indent), code (monospace), drop running headers/footers, and join
// lines that were only wrapped by the layout.
//
// Pure functions (no DOM) so it can be tested in Node.

const BULLET_GLYPHS = new Set([...'•●▪■➢►▶∙◦○‣⁃–-*§Øüq', 'o', '', '', '', '', '', '', '']);
// Code typeset in a normal font: braces, statements, declarations.
const CODE_START = /^(import|package|public|private|protected|static|return|const|let|var|function|class|interface|def|@\w+|if\s*\(|for\s*\(|while\s*\(|}|\/\/)/;
const looksLikeCode = (t) => /[{}]$/.test(t) || (/;$/.test(t) && /[=(.]/.test(t)) || (CODE_START.test(t) && /[;{(=]/.test(t));

const BULLET_PREFIX = /^[•●▪■➢►▶∙◦○‣⁃]\s*/;

// pages: [{ items, styles }] from page.getTextContent().
// Returns per page { md, headings, bodyChars }: headings is the Markdown of
// just the page's headings, bodyChars counts non-heading text (low = the page
// is mostly a picture).
export function pagesToMd(pages) {
  const pageLines = pages.map(({ items, styles }) => toLines(items, styles));
  const all = pageLines.flat();
  const body = bodySize(all);
  const headingSizes = [...new Set(all.filter((l) => isHeadingLine(l, body)).map((l) => round(l.size)))].sort((a, b) => b - a);
  const repeated = repeatedLines(pageLines);

  return pageLines.map((lines) => {
    const kept = lines.filter((l) => !repeated.has(key(l.text)) && !/^\d{1,3}$/.test(l.text));
    return render(kept, body, headingSizes);
  });
}

const round = (n) => Math.round(n * 2) / 2;
const key = (text) => text.replace(/\d+/g, '#');

function toLines(items, styles) {
  const frags = items
    .filter((it) => it.str)
    .map((it) => {
      const [, , c, d, x, y] = it.transform;
      return { str: it.str, x, y, w: it.width, size: Math.hypot(c, d) || it.height, mono: styles[it.fontName]?.fontFamily === 'monospace' };
    })
    .filter((f) => f.size > 0);
  frags.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const f of frags) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - f.y) < Math.min(line.size, f.size) * 0.5) {
      line.frags.push(f);
      line.size = Math.max(line.size, f.str.trim() ? f.size : 0);
    } else {
      lines.push({ y: f.y, size: f.str.trim() ? f.size : 0, frags: [f] });
    }
  }

  return lines
    .map((line) => {
      line.frags.sort((a, b) => a.x - b.x);
      const visible = line.frags.filter((f) => f.str.trim());
      if (!visible.length) return null;
      // Bullet glyph drawn as its own fragment (e.g. "•" or Wingdings "o"/"§").
      const first = visible[0].str.trim();
      const glyphBullet = visible.length > 1 && first.length === 1 && BULLET_GLYPHS.has(first);
      const textFrags = glyphBullet ? visible.slice(1) : visible;

      // Join fragments; a wide gap (> 1.5 em) starts a new table cell.
      const cells = [''];
      let end = null;
      for (const f of glyphBullet ? line.frags.slice(line.frags.indexOf(visible[1])) : line.frags) {
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
      return {
        text,
        y: line.y,
        x: visible[0].x,
        textX: textFrags[0].x,
        size: Math.max(...textFrags.map((f) => f.size)), // ignore the bullet glyph's size
        bullet,
        mono: !bullet && (monoChars >= chars * 0.8 || looksLikeCode(text)),
        cells: cellTexts.length > 1 ? cellTexts : null,
      };
    })
    .filter((l) => l && l.text);
}

// Most common font size, weighted by characters.
function bodySize(lines) {
  const weight = new Map();
  for (const l of lines) weight.set(round(l.size), (weight.get(round(l.size)) || 0) + l.text.length);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
}

// Bigger than body text and short; long lines ending in ":" or "." are emphasised sentences.
const isHeadingLine = (l, body) =>
  !l.bullet && !l.mono && l.size >= body * 1.1 && l.text.length <= 120 && !(l.text.length > 50 && /[:.]$/.test(l.text));

// Lines (digits ignored) that appear on more than half the pages: headers, footers.
function repeatedLines(pageLines) {
  const counts = new Map();
  for (const lines of pageLines) for (const k of new Set(lines.map((l) => key(l.text)))) counts.set(k, (counts.get(k) || 0) + 1);
  const limit = pageLines.length / 2;
  return new Set(pageLines.length >= 4 ? [...counts].filter(([, n]) => n > limit).map(([k]) => k) : []);
}

function render(lines, body, headingSizes) {
  // Bullet nesting: cluster the x positions of bullets on this page.
  const bulletXs = [...new Set(lines.filter((l) => l.bullet).map((l) => Math.round(l.x)))].sort((a, b) => a - b);
  const levels = [];
  for (const x of bulletXs) levels.push(levels.length && x - levels.at(-1).x <= 5 ? { x, level: levels.at(-1).level } : { x, level: levels.length ? levels.at(-1).level + 1 : 0 });
  const levelOf = (x) => Math.min(3, levels.find((l) => l.x === Math.round(x))?.level ?? 0);

  const blocks = []; // { kind: 'h' | 'p' | 'li' | 'code', text, last: line }
  for (const line of lines) {
    const prev = blocks.at(-1);
    const gap = prev ? prev.last.y - line.y : Infinity;
    const close = gap <= Math.max(line.size, prev?.last.size || 0) * 1.6;

    if (line.mono) {
      if (prev?.kind === 'code' && gap <= line.size * 3) prev.lines.push(line);
      else blocks.push({ kind: 'code', lines: [line] });
      blocks.at(-1).last = line;
      continue;
    }
    if (isHeadingLine(line, body)) {
      if (prev?.kind === 'h' && gap <= line.size * 2.2 && Math.abs(prev.last.size - line.size) < 1) prev.text += ` ${line.text}`;
      else blocks.push({ kind: 'h', text: line.text, depth: Math.min(2, headingSizes.indexOf(round(line.size))) });
      blocks.at(-1).last = line;
      continue;
    }
    // Table rows: consecutive multi-cell lines.
    if (line.cells && !line.bullet) {
      if (prev?.kind === 'table' && gap <= line.size * 3) prev.rows.push(line.cells);
      else blocks.push({ kind: 'table', rows: [line.cells] });
      blocks.at(-1).last = line;
      continue;
    }
    if (line.bullet) {
      blocks.push({ kind: 'li', text: line.text, level: levelOf(line.x), bulletX: line.x, last: line });
      continue;
    }
    // Wrapped continuation of the previous paragraph or bullet.
    const sameSize = prev && Math.abs(prev.last.size - line.size) <= 1;
    const indentOk = prev?.kind === 'li' ? line.x > prev.bulletX : true;
    if ((prev?.kind === 'p' || prev?.kind === 'li') && close && sameSize && indentOk) {
      prev.text = /[a-z]-$/.test(prev.text) ? prev.text + line.text : `${prev.text} ${line.text}`;
      prev.last = line;
      continue;
    }
    blocks.push({ kind: 'p', text: line.text, last: line });
  }

  let out = '';
  const headings = blocks.filter((b) => b.kind === 'h').map((b) => `${'#'.repeat(4 + b.depth)} ${b.text}`).join('\n\n');
  const bodyChars = blocks
    .filter((b) => b.kind !== 'h')
    .reduce((n, b) => n + (b.text ?? (b.lines ? b.lines.map((l) => l.text) : b.rows.flat()).join('')).length, 0);
  for (const [i, b] of blocks.entries()) {
    const sep = i === 0 ? '' : b.kind === 'li' && blocks[i - 1].kind === 'li' ? '\n' : '\n\n';
    if (b.kind === 'h') out += `${sep}${'#'.repeat(4 + b.depth)} ${b.text}`;
    else if (b.kind === 'li') out += `${sep}${'  '.repeat(b.level)}- ${b.text}`;
    else if (b.kind === 'p') out += `${sep}${b.text}`;
    else if (b.kind === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      if (b.rows.length === 1) out += `${sep}${b.rows[0].join(' | ')}`; // lone row: just keep the cells apart
      else out += sep + [b.rows[0], Array(width).fill('---'), ...b.rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
    }
    else {
      const minX = Math.min(...b.lines.map((l) => l.x));
      const code = b.lines.map((l) => ' '.repeat(Math.max(0, Math.round((l.x - minX) / (l.size * 0.6)))) + l.text);
      out += `${sep}\`\`\`\n${code.join('\n')}\n\`\`\``;
    }
  }
  return { md: out, headings, bodyChars };
}
