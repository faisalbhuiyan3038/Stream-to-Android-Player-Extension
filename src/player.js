import 'vidstack/styles/defaults.css';
import 'vidstack/styles/community-skin/video.css';
import 'vidstack/define/media-player.js';
import 'vidstack/define/media-community-skin.js';
import { isHLSProvider } from 'vidstack';
import Hls from 'hls.js';
import dashjs from 'dashjs';

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
    // Vidstack 0.6.x doesn't have a DASH provider — handle DASH directly
    // using dash.js attached to the underlying <video> element, and let
    // Vidstack's UI still wrap it via the native video provider.
    player.addEventListener('provider-setup', (event) => {
      const provider = event.detail;
      // provider.video is the raw <video> element Vidstack created
      const videoEl = provider.video;
      if (!videoEl) return;

      const dash = dashjs.MediaPlayer().create();
      dash.initialize(videoEl, videoUrl, true);
    });
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
