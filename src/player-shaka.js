import shaka from 'shaka-player';

const urlParams = new URLSearchParams(window.location.search);
const videoUrl = urlParams.get('url');
const errorEl = document.getElementById('error-message');
const video = document.getElementById('video');

async function init() {
  if (!videoUrl) {
    errorEl.textContent = 'No video URL provided.';
    video.style.display = 'none';
    return;
  }

  // Install built-in polyfills to patch browser incompatibilities.
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    errorEl.textContent = 'Browser not supported for Shaka Player.';
    video.style.display = 'none';
    return;
  }

  // Shaka v5: create player without a media element, then attach.
  const player = new shaka.Player();
  await player.attach(video);

  // Expose player so the controls script can reference it.
  window._shakaPlayer = player;

  player.addEventListener('error', (event) => {
    const detail = event.detail;
    console.error('Shaka error:', detail);
    errorEl.textContent = `Playback error (${detail.code}): ${detail.message}`;
  });

  // Valid Shaka v5 config — streaming retry parameters only.
  player.configure({
    streaming: {
      retryParameters: {
        maxAttempts: 4,
        baseDelay: 100,
        backoffFactor: 2,
        fuzzFactor: 0.5,
        timeout: 0
      }
    }
  });

  try {
    await player.load(videoUrl);
    video.play().catch(e => console.log('Autoplay blocked:', e.message));
  } catch (e) {
    console.error('Failed to load stream:', e);
    errorEl.textContent = `Failed to load: ${e.message || JSON.stringify(e)}`;
  }
}

init();
