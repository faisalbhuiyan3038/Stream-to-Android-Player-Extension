import 'vidstack/styles/defaults.css';
import 'vidstack/styles/community-skin/video.css';
import 'vidstack/define/media-player.js';
import 'vidstack/define/media-community-skin.js';
import { isHLSProvider } from 'vidstack';
import Hls from 'hls.js';

const urlParams = new URLSearchParams(window.location.search);
const videoUrl = urlParams.get('url');
const errorEl = document.getElementById('error-message');
const player = document.querySelector('media-player');

// Detect stream type from URL
function getStreamType(url) {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'hls';
  if (lower.endsWith('.mpd')) return 'dash';
  return 'native'; // mp4, webm, ts, etc.
}

if (!videoUrl) {
  errorEl.textContent = 'No video URL provided.';
  player.style.display = 'none';
} else {
  const streamType = getStreamType(videoUrl);

  if (streamType === 'dash') {
    // Vidstack 0.6.x has no DASH provider (the old dash.js attach never fired
    // and left an empty player), so hand DASH streams to the Shaka page.
    window.location.replace('player-shaka.html' + window.location.search);
  } else {
    // HLS: hand our locally bundled Hls class to the provider so no CDN
    // fetch is attempted (extension CSP blocks external scripts).
    player.addEventListener('provider-change', (event) => {
      const provider = event.detail;
      if (isHLSProvider(provider)) {
        provider.library = Hls;
      }
    });
  }

  player.src = videoUrl;

  // Wait for the player to signal it can play before attempting autoplay.
  player.addEventListener('can-play', () => {
    player.play().catch((e) => {
      console.log('Autoplay blocked:', e.message);
    });
  }, { once: true });
}
