// Text formats: source code, plain text and Markdown, Jupyter notebooks,
// subtitles and transcripts (.vtt, .srt), and Rich Text (.rtf).
// Each converter takes the file's text and returns { md, assets }.

const none = () => new Map();

// Extension → fence language for source code and data files.
export const CODE = {
  java: 'java', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', vue: 'vue', svelte: 'svelte',
  py: 'python', r: 'r', rmd: 'markdown', qmd: 'markdown', jl: 'julia', m: 'matlab', sas: 'sas', do: 'stata',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin',
  kts: 'kotlin', scala: 'scala', dart: 'dart', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', hs: 'haskell',
  ml: 'ocaml', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', fs: 'fsharp', vb: 'vb', asm: 'asm', s: 'asm',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  css: 'css', scss: 'scss', less: 'less', xml: 'xml', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', gradle: 'groovy', groovy: 'groovy',
  tex: 'latex', bib: 'bibtex', graphql: 'graphql', proto: 'protobuf', sol: 'solidity', v: 'verilog', vhd: 'vhdl',
};
// Build files known by name rather than extension.
export const CODE_NAMES = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', jenkinsfile: 'groovy' };

const fence = (lang, text) => `\`\`\`${lang}\n${text.replace(/\s+$/, '')}\n\`\`\``;

export const code = (lang) => (text) => ({ md: fence(lang, text), assets: none() });
export const plain = (text) => ({ md: text.trim(), assets: none() });

// A Markdown file's own headings go below the pack's "### <file>" heading,
// so they don't break the document's outline (code blocks are left alone).
export function markdown(text) {
  let fenced = false;
  const md = text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, h.length + 3)));
    })
    .join('\n')
    .trim();
  return { md, assets: none() };
}

export function notebook(text) {
  const nb = JSON.parse(text);
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python';
  const md = (nb.cells ?? [])
    .map((c) => {
      const src = (Array.isArray(c.source) ? c.source.join('') : c.source ?? '').trim();
      if (!src) return '';
      return c.cell_type === 'code' ? fence(lang, src) : src;
    })
    .filter(Boolean)
    .join('\n\n');
  return { md, assets: none() };
}

// WebVTT / SRT captions → the transcript: cue numbers, timings, styling tags
// and repeated lines (rolling captions) removed.
export function subtitles(text) {
  const lines = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (!line || /^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line) || /^\d+$/.test(line) || /-->/.test(line)) continue;
    if (lines.at(-1) !== line) lines.push(line);
  }
  // Captions are short fragments of sentences: join them into paragraphs.
  const md = lines.join(' ').replace(/\s+/g, ' ').replace(/([.!?]) (?=[A-Z])/g, '$1\n\n').trim();
  return { md, assets: none() };
}

// Rich Text: control words and destination groups ({\*\...}, fonts, colours,
// pictures) removed, paragraphs and escaped characters kept.
export function rtf(text) {
  let s = text;
  // Drop groups that hold no body text (font/colour tables, pictures, metadata).
  for (const dest of ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', '\\*']) {
    let i;
    while ((i = s.indexOf(dest === '\\*' ? '{\\*' : `{\\${dest}`)) !== -1) {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth === 0) break;
      }
      s = s.slice(0, i) + s.slice(j + 1);
    }
  }
  const win1252 = new TextDecoder('windows-1252');
  s = s
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => win1252.decode(new Uint8Array([parseInt(h, 16)])))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\(par|line)\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/\\([{}\\])/g, '$1')
    .replace(/[{}]/g, '');
  const md = s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { md, assets: none() };
}
