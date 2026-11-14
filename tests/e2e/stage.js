// Builds a throw-away copy of the extension with the manifest of one browser, so the
// tests do not depend on which manifest the repo's own manifest.json currently holds.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = ['background.js', 'content.js', 'shared.js', 'popup.html', 'popup.css', 'popup.js', 'styles.css',
  'player.html', 'player.bundle.css', 'player.bundle.js', 'player-shaka.html', 'player-shaka.bundle.js',
  'player-shaka.bundle.css', 'player-art.html', 'player-art.bundle.js', 'player-common.css', 'download.html', 'download.css', 'download.bundle.js', 'timer-worker.js'];

// `edit(manifest, dir)` may change the manifest or the staged files before the manifest is written.
function stageExtension(target, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sap-${target}-ext-`));
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'icons'), path.join(dir, 'icons'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, `manifest.${target}.json`), 'utf8'));
  if (edit) edit(manifest, dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

module.exports = { stageExtension, ROOT, FILES };
