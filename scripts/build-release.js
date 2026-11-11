// Release build: a minified, mangled copy of the whole extension for one browser, ready to load
// unpacked or to upload to the Chrome Web Store / addons.mozilla.org.
//   node scripts/build-release.js --target=chrome|firefox|all [--no-bundle] [--no-zip]
// Output: dist/<target>/ (unpacked) and releases/Stream-to-Player-v<ver>-<target>-min.zip
// Steps: rebuild the player/download bundles from src/ (esbuild, already minified and mangled),
// then copy the packaged files (the same list as `npm run package`, LICENSE.md included) with
//   - JavaScript minified and mangled with esbuild: each root script is wrapped in a function scope
//     (format 'iife'), so every identifier is renamed, top-level ones included. That is safe because
//     the scripts share nothing by name: shared.js exports only globalThis.StreamShared, the others
//     use globalThis.browser / StreamShared. Property names are not mangled (chrome.* APIs, message
//     and storage fields must keep theirs). Tree shaking is off, so nothing is dropped.
//   - A license banner on every script (GPL-3.0: the source must stay available).
//   - CSS minified with esbuild, HTML comments/indentation removed, manifest written compact.
// Note for addons.mozilla.org: minified code needs the source code uploaded with the version
// (this repository, with these build steps).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const esbuild = require('esbuild');
const AdmZip = require('adm-zip');
const { EXTENSION_FILES } = require('./build-extension');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const targetArg = (args.find(a => a.startsWith('--target=')) || '--target=all').split('=')[1].toLowerCase();
const targets = targetArg === 'all' ? ['chrome', 'firefox'] : [targetArg];

// Already-minified esbuild bundles: copied as they are (minifying again gains nothing)
const BANNER = '/*! Stream to Android Player | GPL-3.0-or-later | see LICENSE.md | source: https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension */';

const PREBUILT = new Set(['player.bundle.js', 'player-shaka.bundle.js', 'download.bundle.js', 'player.bundle.css', 'player-shaka.bundle.css']);

function minifyHtml(html) {
  return html
    .replace(/<!--(?!\[)[\s\S]*?-->/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

async function processFile(rel, outDir, stats) {
  const src = path.join(rootDir, rel);
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const before = fs.statSync(src).size;
  const ext = path.extname(rel).toLowerCase();
  if (PREBUILT.has(rel) && ext === '.js') {
    fs.writeFileSync(dest, `${BANNER}\n${fs.readFileSync(src, 'utf8')}`);
  } else if (PREBUILT.has(rel) || !['.js', '.css', '.html'].includes(ext)) {
    fs.copyFileSync(src, dest);
  } else {
    const code = fs.readFileSync(src, 'utf8');
    let out;
    if (ext === '.html') {
      out = minifyHtml(code);
    } else {
      const js = ext === '.js';
      const result = await esbuild.transform(code, {
        loader: js ? 'js' : 'css',
        minify: true, // whitespace + syntax + identifiers
        // own function scope per script → top-level names are mangled too
        ...(js ? { format: 'iife', treeShaking: false, target: 'es2020', banner: BANNER } : {}),
        legalComments: 'none',
        charset: 'utf8'
      });
      out = result.code;
    }
    fs.writeFileSync(dest, out);
  }
  stats.before += before;
  stats.after += fs.statSync(dest).size;
}

function walk(rel) {
  const abs = path.join(rootDir, rel);
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap(name => walk(path.join(rel, name)));
}

async function buildTarget(target) {
  const manifestPath = path.join(rootDir, `manifest.${target}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Unknown target "${target}" (no manifest.${target}.json)`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const outDir = path.join(rootDir, 'dist', target);
  // Empty the folder rather than delete it: it may be loaded unpacked in a browser (locked on Windows)
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

  const stats = { before: 0, after: 0 };
  for (const entry of EXTENSION_FILES) {
    if (!fs.existsSync(path.join(rootDir, entry))) throw new Error(`Missing file: ${entry}`);
    for (const rel of walk(entry)) await processFile(rel, outDir, stats);
  }
  const kb = n => `${(n / 1024).toFixed(0)} KB`;
  console.log(`[OK] dist/${target}/  (${kb(stats.before)} → ${kb(stats.after)})`);

  if (!args.includes('--no-zip')) {
    const releasesDir = path.join(rootDir, 'releases');
    fs.mkdirSync(releasesDir, { recursive: true });
    const zipName = `Stream-to-Player-v${manifest.version}-${target}-min.zip`;
    const zip = new AdmZip();
    zip.addLocalFolder(outDir);
    zip.writeZip(path.join(releasesDir, zipName));
    console.log(`[OK] releases/${zipName}`);
  }
}

async function main() {
  if (!args.includes('--no-bundle')) {
    console.log('Building bundles (npm run build)...');
    execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
  }
  for (const target of targets) await buildTarget(target);
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
