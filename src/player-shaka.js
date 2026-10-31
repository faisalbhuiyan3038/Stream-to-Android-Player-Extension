import shaka from 'shaka-player';

const urlParams = new URLSearchParams(window.location.search);
const videoUrl = urlParams.get('url');
const errorEl = document.getElementById('error-message');
const video = document.getElementById('video');

// Subtitle files detected on the source page, passed by the background script as ?subs=[{url,label,lang}]
let subtitles = [];
try {
  subtitles = JSON.parse(urlParams.get('subs') || '[]');
} catch (e) {
  console.warn('Ignoring malformed subs parameter:', e);
}

function subtitleMime(url) {
  const path = url.toLowerCase().split('?')[0];
  if (path.endsWith('.srt')) return 'text/srt';
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'text/x-ssa';
  return 'text/vtt';
}

async function addSubtitles(player) {
  for (const sub of subtitles) {
    try {
      await player.addTextTrackAsync(sub.url, sub.lang || 'und', 'subtitles', subtitleMime(sub.url), undefined, sub.label || '');
    } catch (e) {
      console.warn('Could not load subtitle', sub.url, e);
    }
  }
  // Shaka 5: selecting a track shows it, selectTextTrack(null) hides captions
  const tracks = player.getTextTracks();
  if (tracks.length > 0) {
    player.selectTextTrack(tracks[0]);
  }
}

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
    await addSubtitles(player);
    video.play().catch(e => console.log('Autoplay blocked:', e.message));
  } catch (e) {
    console.error('Failed to load stream:', e);
    errorEl.textContent = `Failed to load: ${e.message || JSON.stringify(e)}`;
  }
}

init();
