import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

fs.mkdirSync(path.join(distDir, 'icons'), { recursive: true });

// 1. Bundle entrypoints with esbuild
await build({
  entryPoints: {
    viewer: path.join(__dirname, 'src/viewer/viewer.js'),
    popup: path.join(__dirname, 'src/popup/popup.js'),
    'service-worker': path.join(__dirname, 'src/background/service-worker.js'),
  },
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'edge120'],
  outdir: distDir,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// 2. Copy PDF.js worker
const workerSrc = path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
fs.copyFileSync(workerSrc, path.join(distDir, 'pdf.worker.min.mjs'));

// 3. Copy HTML, CSS, manifest, icons
const staticCopies = [
  ['manifest.json', 'manifest.json'],
  ['src/viewer/viewer.html', 'viewer.html'],
  ['src/viewer/viewer.css', 'viewer.css'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
];

for (const [from, to] of staticCopies) {
  fs.copyFileSync(path.join(__dirname, from), path.join(distDir, to));
}

const iconsSrcDir = path.join(__dirname, 'icons');
if (fs.existsSync(iconsSrcDir)) {
  for (const file of fs.readdirSync(iconsSrcDir)) {
    fs.copyFileSync(path.join(iconsSrcDir, file), path.join(distDir, 'icons', file));
  }
}

console.log(`Built MV3 extension cleanly into ${distDir}`);
