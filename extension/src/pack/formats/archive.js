// Zip archives, usually code scaffolds, solutions and lab files: the list of
// what is inside, then each readable file converted by its own format.
// Dependencies, build output and editor folders are left out, and caps keep
// one huge project from flooding the pack (each cut is said in the Markdown).
import JSZip from 'jszip';
import { contentHeading } from '../md.js';
import { IMAGE_EXTS, MIN_IMAGE_BYTES, extOf, imageName } from '../names.js';

const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.svn|__MACOSX|\.idea|\.vscode|\.gradle|\.next|\.nuxt|dist|build|out|target|bin|obj|venv|\.venv|__pycache__|\.pytest_cache|\.DS_Store|coverage|vendor)(\/|$)/;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock|Cargo\.lock|gradlew(\.bat)?|mvnw(\.cmd)?|\.env[^/]*|[^/]*\.min\.(js|css)|[^/]*\.map|\.gitignore|\.gitattributes|\.editorconfig|\.DS_Store|LICEN[CS]E(\.\w+)?|HELP\.md)$/i;
// Folders of build tooling (Maven and Gradle wrappers).
const SKIP_TOOL_DIRS = /(^|\/)(\.mvn|gradle\/wrapper)(\/|$)/;
// Generated READMEs that every new project of a kind starts with.
const BOILERPLATE = [/This project was bootstrapped with \[Create React App\]/, /^# Getting Started\n\n### Reference Documentation/m, /This template provides a minimal setup to get React working in Vite/];
const MAX_LISTED = 300;
const MAX_FILES = 120;
const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000; // about 50k tokens per archive
const MAX_IMAGES = 20;

// ctx.convertEntry(name, bytes, budget) converts one file by its own format;
// it returns null for a file no converter reads. A zip inside this one gets
// the same budget, spent before each conversion, so nesting can't multiply
// the work or the length.
export async function archive(bytes, ctx) {
  const budget = ctx.budget ?? { files: MAX_FILES, chars: MAX_TOTAL_CHARS };
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && !SKIP_DIRS.test(e.name) && !SKIP_TOOL_DIRS.test(e.name) && !SKIP_FILES.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skipped = Object.values(zip.files).filter((e) => !e.dir).length - entries.length;

  const listed = entries.slice(0, MAX_LISTED).map((e) => `- ${e.name}`);
  if (entries.length > MAX_LISTED) listed.push(`- … and ${entries.length - MAX_LISTED} more files`);
  const parts = [`${contentHeading(1, `Contents (${entries.length} files${skipped ? `; ${skipped} build, dependency or editor files left out` : ''})`)}\n${listed.join('\n')}`];
  budget.chars -= parts[0].length; // every archive, nested or not, pays for its own list

  // Pictures inside a code project are its icons and logos; only an archive
  // of pictures (no readable text in it) sends them.
  const pictureBundle = entries.every((e) => IMAGE_EXTS.has(extOf(e.name)) || !ctx.isReadable(e.name));
  const assets = new Map();
  const seen = new Set(); // identical files (a template copied into several folders) are sent once
  const cut = [];
  for (const entry of entries) {
    const ext = extOf(entry.name);
    if (IMAGE_EXTS.has(ext)) {
      if (!pictureBundle) continue;
      if (assets.size >= MAX_IMAGES) continue;
      const data = await entry.async('uint8array');
      if (data.length < MIN_IMAGE_BYTES) continue;
      const name = imageName(`${ctx.fileId}-${entry.name}`);
      assets.set(name, { blob: new Blob([data], { type: `image/${ext.replace('jpg', 'jpeg')}` }) });
      parts.push(`${contentHeading(1, entry.name)}\n![](images/${name})`);
      continue;
    }
    if (!ctx.isReadable(entry.name)) continue;
    if (budget.files <= 0 || budget.chars <= 0) {
      cut.push(entry.name);
      continue;
    }
    budget.files--;
    let result;
    try {
      result = await ctx.convertEntry(entry.name, await entry.async('arraybuffer'), budget);
    } catch {
      result = null; // a damaged entry should not lose the rest of the archive
    }
    if (!result?.md || BOILERPLATE.some((re) => re.test(result.md)) || seen.has(result.md)) continue;
    seen.add(result.md);
    let md = result.md;
    if (ext !== 'zip') { // a zip inside already spent the budget for its list and files
      const room = Math.min(MAX_FILE_CHARS, budget.chars);
      if (md.length > room) {
        md = md.slice(0, room);
        if (md.startsWith('```')) md += '\n```'; // close the code block before the note
        md += '\n\n_(cut here: the rest of this file is too long to include)_';
      }
      budget.chars -= md.length;
    }
    for (const [name, source] of result.assets) assets.set(name, source);
    parts.push(`${contentHeading(1, entry.name)}\n${md}`);
  }
  if (cut.length) parts.push(`_(${cut.length} more files not included to keep this archive's part a readable size)_`);
  return { md: parts.join('\n\n'), assets };
}
