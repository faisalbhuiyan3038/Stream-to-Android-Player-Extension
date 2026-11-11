const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

const EXTENSION_FILES = [
  'background.js',
  'content.js',
  'shared.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'styles.css',
  'player.html',
  'player.bundle.css',
  'player.bundle.js',
  'player-shaka.html',
  'player-shaka.bundle.js',
  'player-shaka.bundle.css',
  'player-common.css',
  'download.html',
  'download.css',
  'download.bundle.js',
  'icons',
  'LICENSE.md'
];

function switchTarget(target) {
  const targetLower = target.toLowerCase();
  const sourceManifest = path.join(rootDir, `manifest.${targetLower}.json`);
  const destManifest = path.join(rootDir, 'manifest.json');

  if (!fs.existsSync(sourceManifest)) {
    console.error(`Error: Template ${sourceManifest} not found.`);
    process.exit(1);
  }

  fs.copyFileSync(sourceManifest, destManifest);
  console.log(`[OK] Switched root manifest.json to ${targetLower.toUpperCase()} (MV3)`);
}

function packageBrowser(target) {
  const targetLower = target.toLowerCase();
  const manifestSource = path.join(rootDir, `manifest.${targetLower}.json`);
  if (!fs.existsSync(manifestSource)) {
    console.error(`Error: Template ${manifestSource} not found.`);
    process.exit(1);
  }

  const manifestData = JSON.parse(fs.readFileSync(manifestSource, 'utf8'));
  const version = manifestData.version || '1.0.0';

  const releasesDir = path.join(rootDir, 'releases');
  fs.mkdirSync(releasesDir, { recursive: true });

  // Zip entries are written directly (no staging directory, no PowerShell),
  // so packaging works on Windows, macOS and Linux.
  const zip = new AdmZip();
  zip.addFile('manifest.json', fs.readFileSync(manifestSource));

  for (const file of EXTENSION_FILES) {
    const srcPath = path.join(rootDir, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`Warning: Expected file ${file} does not exist in root.`);
      continue;
    }
    if (fs.statSync(srcPath).isDirectory()) {
      zip.addLocalFolder(srcPath, file);
    } else {
      zip.addLocalFile(srcPath);
    }
  }

  const zipName = `Stream-to-Player-v${version}-${targetLower}.zip`;
  const zipPath = path.join(releasesDir, zipName);
  zip.writeZip(zipPath);
  console.log(`[OK] Created release package: releases/${zipName}`);
}

function main() {
  const targetArg = args.find(a => a.startsWith('--target='));
  const isPackage = args.includes('--package');

  if (targetArg) {
    const target = targetArg.split('=')[1];
    switchTarget(target);
  }

  if (isPackage) {
    console.log('Packaging extensions for Chrome and Firefox...');
    packageBrowser('chrome');
    packageBrowser('firefox');
  }

  if (!targetArg && !isPackage) {
    console.log('Usage:');
    console.log('  node scripts/build-extension.js --target=chrome   (Switches root manifest to Chrome)');
    console.log('  node scripts/build-extension.js --target=firefox  (Switches root manifest to Firefox)');
    console.log('  node scripts/build-extension.js --package         (Builds release zips in releases/)');
  }
}

if (require.main === module) main();

module.exports = { EXTENSION_FILES };
