// The registry of readable formats. convert(fileName, bytes, ctx) gives
// { md, assets }, or null for a file no converter reads (ctx: { fileId, pdf,
// budget? }); isReadable(fileName) says whether the pack can read a file, as
// text or as a picture; unreadableReason(fileName) says, in a student's
// words, why not. Heavy libraries (pdf.js, SheetJS, JSZip) load only when a
// file needs them.
import { CODE, CODE_NAMES, code, plain, markdown, notebook, subtitles, rtf, calendar } from './text.js';
import { htmlToMd } from './html-to-md.js';
import { IMAGE_EXTS, extOf } from '../names.js';

const lazy = (load, name) => async (input, ctx) => (await load())[name](input, ctx);
const binary = (fn) => ({ binary: true, convert: fn });
const text = (fn) => ({ binary: false, convert: fn });

const pdf = binary(lazy(() => import('./pdf.js'), 'pdfToMd'));
const pptx = binary(lazy(() => import('./ooxml.js'), 'pptxToMd'));
const docx = binary(lazy(() => import('./ooxml.js'), 'docxToMd'));
const spreadsheet = binary(lazy(() => import('./sheet.js'), 'sheet'));
const delimited = text(lazy(() => import('./sheet.js'), 'sheet'));
const ppt = binary(lazy(() => import('./legacy.js'), 'ppt'));
const doc = binary(lazy(() => import('./legacy.js'), 'doc'));
const odt = binary(lazy(() => import('./odf.js'), 'odt'));
const odp = binary(lazy(() => import('./odf.js'), 'odp'));
const epub = binary(lazy(() => import('./epub.js'), 'epub'));
const zip = binary(lazy(() => import('./archive.js'), 'archive'));
const html = text((input) => ({ md: htmlToMd(input), assets: new Map() }));

const FORMATS = {
  pdf,
  pptx, pptm: pptx, ppsx: pptx, potx: pptx,
  docx, docm: docx, dotx: docx,
  xlsx: spreadsheet, xlsm: spreadsheet, xlsb: spreadsheet, xls: spreadsheet, ods: spreadsheet,
  csv: delimited, tsv: delimited,
  ppt, pps: ppt, pot: ppt,
  doc, dot: doc,
  odt, odp,
  epub,
  zip,
  html, htm: html, xhtml: html,
  ipynb: text(notebook),
  vtt: text(subtitles), srt: text(subtitles),
  rtf: text(rtf),
  md: text(markdown), markdown: text(markdown), rmd: text(markdown), qmd: text(markdown),
  txt: text(plain), rst: text(plain), adoc: text(plain), log: text(plain), ics: text(calendar),
};
for (const [ext, lang] of Object.entries(CODE)) FORMATS[ext] ??= text(code(lang));

const baseName = (fileName) => fileName.split('/').pop().toLowerCase();

export function converterFor(fileName) {
  const byName = CODE_NAMES[baseName(fileName)];
  if (byName) return text(code(byName));
  return FORMATS[extOf(fileName)] ?? null;
}

export async function convert(fileName, bytes, ctx) {
  const converter = converterFor(fileName);
  if (!converter) return null;
  return converter.convert(converter.binary ? bytes : new TextDecoder().decode(bytes), ctx);
}

export const isImage = (fileName) => IMAGE_EXTS.has(extOf(fileName));
export const isReadable = (fileName) => isImage(fileName) || Boolean(converterFor(fileName));

const REASONS = [
  [/^(mp4|mov|m4v|avi|mkv|webm|wmv|flv)$/, 'video: the AI can\'t watch it here'],
  [/^(mp3|m4a|wav|aac|ogg|flac|wma)$/, 'audio: the AI can\'t listen to it here'],
  [/^(key|pages|numbers)$/, 'Apple file: export it as PDF first'],
  [/^(rar|7z|tar|gz|tgz|bz2|xz)$/, 'compressed file: only .zip can be opened'],
  [/^(exe|msi|dmg|pkg|app|apk|jar|war|class|dll|so|o)$/, 'program file'],
  [/^(svg|psd|ai|sketch|fig|xd|eps)$/, 'design file'],
  [/^(heic|heif|tif|tiff|bmp|raw)$/, 'picture in a format the AI chat can\'t take: save it as PNG or JPG'],
];

export function unreadableReason(fileName) {
  const ext = extOf(fileName);
  if (!ext) return 'unknown file type';
  return REASONS.find(([re]) => re.test(ext))?.[1] ?? `.${ext} files can't be read`;
}
