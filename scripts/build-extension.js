const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

const EXTENSION_FILES = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'styles.css',
  'player.html',
  'player.bundle.css',
  'player.bundle.js',
  'player-shaka.html',
  'player-shaka.bundle.js',
  'player-shaka-controls.js',
  'icons'
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
  if (!fs.existsSync(releasesDir)) {
    fs.mkdirSync(releasesDir, { recursive: true });
  }

  const stageDir = path.join(rootDir, `_stage_${targetLower}`);
  if (fs.existsSync(stageDir)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stageDir, { recursive: true });

  // Copy manifest
  fs.copyFileSync(manifestSource, path.join(stageDir, 'manifest.json'));

  // Copy extension files
  for (const file of EXTENSION_FILES) {
    const srcPath = path.join(rootDir, file);
    const destPath = path.join(stageDir, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`Warning: Expected file ${file} does not exist in root.`);
      continue;
    }
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  const zipName = `Stream-to-Player-v${version}-${targetLower}.zip`;
  const zipPath = path.join(releasesDir, zipName);

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  try {
    execSync(`powershell -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'inherit' });
    console.log(`[OK] Created release package: releases/${zipName}`);
  } catch (err) {
    console.error(`Failed to create zip for ${targetLower}:`, err);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
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

main();
