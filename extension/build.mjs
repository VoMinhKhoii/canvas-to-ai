// Bundles the extension into dist/ — load that folder in chrome://extensions.
// The panel is split so pdf.js, SheetJS and JSZip load only when a file needs
// them; the tab proxy is a classic script injected into the Canvas tab.
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, target: 'chrome120', logLevel: 'info', legalComments: 'eof' };

await build({ ...common, entryPoints: { panel: 'src/panel/panel.js', background: 'src/background.js' }, outdir: 'dist', format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]', minify: true });
await build({ ...common, entryPoints: { 'tab-proxy': 'src/canvas/tab-proxy.js' }, outdir: 'dist', format: 'iife' });

// One version: package.json's.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
writeFileSync('dist/manifest.json', JSON.stringify({ ...manifest, version }, null, 2));
for (const f of ['sidepanel.html', 'sidepanel.css']) cpSync(`src/panel/${f}`, `dist/${f}`);
for (const size of [16, 32, 48, 128]) cpSync(`src/icons/icon-${size}.png`, `dist/icons/icon-${size}.png`);
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
