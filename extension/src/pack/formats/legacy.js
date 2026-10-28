// Office 97-2003 binary files (.ppt, .doc). Both are compound files (an
// in-file directory of streams); SheetJS's CFB reader opens them. Only the
// text is recovered: enough for the AI to read old lecture slides and notes.
import { contentHeading } from '../md.js';

const win1252 = new TextDecoder('windows-1252');
const utf16 = new TextDecoder('utf-16le');

async function openStreams(bytes) {
  const XLSX = await import('xlsx');
  const cfb = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' });
  // From the root: an embedded object (a chart, another document) has
  // streams of the same names inside the file's ObjectPool.
  return (name) => {
    const entry = XLSX.CFB.find(cfb, `/${name}`);
    return entry?.content ? new Uint8Array(entry.content) : null;
  };
}

// ---------- PowerPoint (.ppt) ----------
// The "PowerPoint Document" stream is a tree of records: an 8-byte header
// (version/instance, type, length); version 0xF marks a container whose body
// is more records. Fast save appends edited copies, so the stream is read the
// way PowerPoint reads it: "Current User" points at the newest UserEditAtom;
// the chain of edits and their persist directories maps object ids to the
// live records. From the live Document, the slide list names each slide (and
// its notes) by persist id; their text is in text atoms.

const SLIDE_LIST = 0x0ff0; // instance 0 slides, 2 notes
const SLIDE_PERSIST = 0x03f3;
const SLIDE_ATOM = 0x03ef;
const TEXT_HEADER = 0x0f9f;
const TEXT_CHARS = 0x0fa0; // UTF-16
const TEXT_BYTES = 0x0fa8; // 8-bit
const TITLE_TYPES = new Set([0, 6]); // title, centred title

function header(view, o) {
  const verInst = view.getUint16(o, true);
  return { container: (verInst & 0xf) === 0xf, instance: verInst >> 4, type: view.getUint16(o + 2, true), body: o + 8, end: o + 8 + view.getUint32(o + 4, true) };
}

// Every record inside the container at `o`, depth first, in stream order.
function* walk(view, o) {
  const root = header(view, o);
  const end = Math.min(root.end, view.byteLength);
  for (let at = root.body; at + 8 <= end; ) {
    const r = header(view, at);
    if (r.end > end) throw new Error('damaged PowerPoint file'); // a record runs past its container
    yield { ...r, at };
    at = r.container ? r.body : r.end;
  }
}

// Live object offsets: persist id → offset, applying the edit chain oldest first.
function persistDirectory(view, currentUser) {
  let edit = new DataView(currentUser.buffer, currentUser.byteOffset, currentUser.byteLength).getUint32(16, true);
  const edits = [];
  while (edit && edit + 32 <= view.byteLength && edits.length < 1000) {
    edits.push({ directory: view.getUint32(edit + 20, true), doc: view.getUint32(edit + 24, true) });
    const last = view.getUint32(edit + 16, true);
    if (last >= edit) break; // older edits come earlier in the stream
    edit = last;
  }
  if (!edits.length) throw new Error('no edit chain');
  const live = new Map();
  for (const { directory } of edits.reverse()) {
    const dir = header(view, directory);
    for (let at = dir.body; at + 4 <= dir.end; ) {
      const entry = view.getUint32(at, true);
      const first = entry & 0xfffff;
      const count = entry >>> 20;
      for (let k = 0; k < count; k++) live.set(first + k, view.getUint32(at + 4 + k * 4, true));
      at += 4 + count * 4;
    }
  }
  return { live, doc: edits.at(-1).doc };
}

const isText = (r) => r.type === TEXT_CHARS || r.type === TEXT_BYTES;
const atomText = (stream, r) => (r.type === TEXT_CHARS ? utf16 : win1252).decode(stream.subarray(r.body, r.end)).replace(/[\r\v]/g, '\n').trim();

// Text atoms of one slide or notes container: [{ title?, text }].
function containerText(view, stream, o) {
  const out = [];
  let textType = 1;
  for (const r of walk(view, o)) {
    if (r.type === TEXT_HEADER) textType = view.getUint32(r.body, true);
    if (!isText(r)) continue;
    const text = atomText(stream, r);
    if (text) out.push({ title: TITLE_TYPES.has(textType), text });
  }
  return out;
}

export async function ppt(bytes) {
  const streams = await openStreams(bytes);
  const stream = streams('PowerPoint Document');
  const currentUser = streams('Current User');
  if (!stream || !currentUser) throw new Error('not a PowerPoint file');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const { live, doc } = persistDirectory(view, currentUser);
  const docAt = live.get(doc);
  if (docAt === undefined) throw new Error('damaged PowerPoint file');

  // The live slide list: slides in order with their persist ids, the text
  // stored in the list itself, and the notes list keyed by slide id.
  const slides = [];
  const notesById = new Map();
  let list = null;
  let listEnd = 0;
  for (const r of walk(view, docAt)) {
    if (r.type === SLIDE_LIST) {
      list = r.instance;
      listEnd = r.end;
      continue;
    }
    if (r.at >= listEnd) list = null;
    if (r.type === SLIDE_PERSIST && list === 0) slides.push({ persist: view.getUint32(r.body, true), listed: [], textType: 1 });
    if (r.type === SLIDE_PERSIST && list === 2) notesById.set(view.getUint32(r.body + 12, true), view.getUint32(r.body, true));
    if (list === 0 && slides.length) {
      if (r.type === TEXT_HEADER) slides.at(-1).textType = view.getUint32(r.body, true);
      if (isText(r)) {
        const text = atomText(stream, r);
        if (text) slides.at(-1).listed.push({ title: TITLE_TYPES.has(slides.at(-1).textType), text });
      }
    }
  }

  const out = [];
  for (const [i, slide] of slides.entries()) {
    const at = live.get(slide.persist);
    const drawn = at === undefined ? [] : containerText(view, stream, at);
    // The slide's notes: its SlideAtom names the notes by id.
    let notes = '';
    if (at !== undefined) {
      const atom = [...walk(view, at)].find((r) => r.type === SLIDE_ATOM);
      const notesAt = atom && live.get(notesById.get(view.getUint32(atom.body + 16, true)));
      if (notesAt !== undefined) notes = containerText(view, stream, notesAt).map((t) => t.text.replace(/\s+/g, ' ')).join(' ').replace(/(\s*\*)+$/, ''); // "*" is the slide-number field
    }
    const texts = [...slide.listed, ...drawn];
    const title = texts.find((t) => t.title)?.text.replace(/\s+/g, ' ') ?? '';
    const lines = [...new Set(texts.filter((t) => !t.title).flatMap((t) => t.text.split('\n').map((l) => l.trim())).filter(Boolean))];
    if (/^[\d\s*]*$/.test(notes)) notes = '';
    if (!title && !lines.length && !notes) continue;
    out.push([contentHeading(1, `Slide ${i + 1}${title ? `: ${title}` : ''}`), ...lines.map((l) => `- ${l}`), notes && `> Notes: ${notes}`].filter(Boolean).join('\n'));
  }
  return { md: out.join('\n\n'), assets: new Map() };
}

// ---------- Word (.doc) ----------
// The WordDocument stream starts with the FIB; its fcClx/lcbClx point into
// the table stream at the piece table, which maps character positions to
// runs of 8-bit or UTF-16 text in WordDocument. The first ccpText characters
// are the main document.

export async function doc(bytes) {
  const stream = await openStreams(bytes);
  const word = stream('WordDocument');
  if (!word) throw new Error('not a Word file');
  const w = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (w.getUint16(0, true) !== 0xa5ec) throw new Error('not a Word 97-2003 file');
  const flags = w.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('password protected');
  const table = stream(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('damaged Word file');
  const t = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const ccpText = w.getUint32(0x4c, true);
  const fcClx = w.getUint32(0x1a2, true);
  const lcbClx = w.getUint32(0x1a6, true);

  // Skip any Prc entries (formatting) to reach the Pcdt (the piece table).
  let o = fcClx;
  const clxEnd = fcClx + lcbClx;
  while (o < clxEnd && table[o] === 0x01) o += 3 + t.getUint16(o + 1, true); // unsigned: always moves forward
  if (table[o] !== 0x02) throw new Error('damaged Word file');
  const lcb = t.getUint32(o + 1, true);
  const plc = o + 5;
  const n = (lcb - 4) / 12;
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cpStart = t.getUint32(plc + i * 4, true);
    const cpEnd = t.getUint32(plc + (i + 1) * 4, true);
    const fcRaw = t.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    const chars = cpEnd - cpStart;
    const start = compressed ? fc / 2 : fc;
    const end = start + (compressed ? chars : chars * 2);
    if (chars < 0 || end > word.length) throw new Error('damaged Word file'); // subarray would cut it short silently
    text += compressed ? win1252.decode(word.subarray(start, end)) : utf16.decode(word.subarray(start, end));
  }
  if (text.length < ccpText) throw new Error('damaged Word file');
  return { md: cleanWordText(text.slice(0, ccpText)), assets: new Map() };
}

// Word's control characters: \r paragraph, \x07 table cell/row end, \v line
// break, \f page break, fields \x13 code \x14 result \x15 (keep the result).
function cleanWordText(text) {
  let s = text.replace(/\x13[^\x13\x14\x15]*\x14([^\x15]*)\x15/g, '$1').replace(/\x13[^\x15]*\x15/g, '');
  s = s.replace(/\x07\r?/g, ' | ').replace(/[\r\v\f]/g, '\n').replace(/[\x00-\x08\x0e-\x1f]/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}
