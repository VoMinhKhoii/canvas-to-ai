// Bundles the extension into dist/ — load that folder in chrome://extensions.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/sidepanel.js', 'src/background.js'],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: 'dist',
  // Keep function source intact: collectCourse is serialized into the Canvas tab.
  minify: false,
  logLevel: 'info',
});

for (const f of ['manifest.json', 'sidepanel.html', 'sidepanel.css']) cpSync(`src/${f}`, `dist/${f}`);
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
