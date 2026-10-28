// Text formats: source code, plain text and Markdown, Jupyter notebooks,
// subtitles and transcripts (.vtt, .srt), calendar invites (.ics) and Rich
// Text (.rtf). Each converter takes the file's text and returns { md, assets }.
import { contentHeading } from '../md.js';

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
  ino: 'cpp', service: 'ini', // Arduino sketches; systemd units
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

// Calendar invites (.ics): each event's title, time, place and description.
// Attendee lists (people's emails), time-zone rules, the invite's HTML copy and
// long tracking links (meeting joins through mail filters) are left out.
export function calendar(text) {
  const events = [];
  const open = []; // components we are inside: VCALENDAR, VEVENT, VALARM…
  let event = null;
  for (const line of text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')) { // lines go on after a space
    const begin = /^BEGIN:(\S+)$/.exec(line)?.[1];
    const end = /^END:(\S+)$/.exec(line)?.[1];
    if (begin) {
      open.push(begin);
      if (begin === 'VEVENT') event = {};
    } else if (end) {
      if (open.pop() === 'VEVENT' && event) events.push(event), (event = null);
    } else if (event && open.at(-1) === 'VEVENT') { // not a reminder's (VALARM) own description
      // NAME;PARAM=…;PARAM="…":value — a quoted parameter may hold colons.
      const m = /^([A-Z-]+)((?:;(?:"[^"]*"|[^";:])*)*):(.*)$/.exec(line);
      if (m) event[m[1]] ??= m[3].replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c)).trim(); // one pass: "\\n" is a backslash and an n
    }
  }
  const when = (v) => v?.replace(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d*(Z?))?$/, (_, y, mo, d, h, mi, z) => `${y}-${mo}-${d}${h ? ` ${h}:${mi}${z ? ' UTC' : ''}` : ''}`);
  const about = (s) => s?.replace(/<https?:[^>]*>/g, '').replace(/https?:\/\/\S{80,}/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[_\-=*]{5,}$/.test(l)).join('\n');
  const md = events
    .map((e) => [contentHeading(1, e.SUMMARY || 'Event'), [when(e.DTSTART), when(e.DTEND)].filter(Boolean).join(' to '), e.LOCATION && `Where: ${e.LOCATION}`, about(e.DESCRIPTION)].filter(Boolean).join('\n'))
    .join('\n\n');
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
  // Escapes and group braces in one left-to-right pass, so an escaped
  // backslash ("\\") is never read as the start of another escape ("\\par" is
  // a backslash and "par") and escaped braces stay.
  s = s.replace(/\\(?:'([0-9a-f]{2})|u(-?\d+)\??|([{}\\])|([a-z]+)-?\d* ?)|[{}]/gi, (_, hex, uni, char, word) => {
    if (hex) return win1252.decode(new Uint8Array([parseInt(hex, 16)]));
    if (uni) return String.fromCharCode(Number(uni) < 0 ? Number(uni) + 65536 : Number(uni));
    if (char) return char;
    return word === 'par' || word === 'line' ? '\n' : word === 'tab' ? '\t' : ''; // other control words and bare braces
  });
  const md = s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { md, assets: none() };
}
