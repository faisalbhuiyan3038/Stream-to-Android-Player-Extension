if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}

let streams = [];
let pageSubtitles = [];
let observer = null;
let debounceTimer = null;
const selectedVariants = new Map(); // stream.url -> chosen variant url
const seenResources = new Set();    // resource-timing URLs already reported
// Cheap pre-filter; the background applies the real stream / subtitle rules
const LIKELY_MEDIA_URL = /\.(m3u8?|mpd|mp4|ts|vtt|srt|ass|ssa)(\?|#|$)|manifest|playlist|master\.json|urlset|\/video\/|\/media\/|\/stream\//i;
const defaultSettings = {
  showCopyIcon: true,
  showPlayIcon: true,
  showDownloadIcon: false,
  defaultTapAction: 'default',
  androidPlayer: 'auto',
  buttonVisibility: 'always' // 'always' | 'fade' (translucent when idle) | 'never'
};
let extSettings = { ...defaultSettings };
let extPlatform = 'win';

// Clear streams when page unloads
window.addEventListener('beforeunload', () => {
  streams = [];
  if (observer) { observer.disconnect(); observer = null; }
  if (debounceTimer) clearTimeout(debounceTimer);
  const menu = document.getElementById('video-handler-menu');
  const button = document.getElementById('video-handler-button');
  if (menu) menu.remove();
  if (button) button.remove();
});

function createStreamMenu() {
  const menu = document.createElement('div');
  menu.id = 'video-handler-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);
  return menu;
}

function shareUrl(url, name) {
  if (extPlatform === 'android') {
    const sub = pageSubtitles[0] && pageSubtitles[0].url;
    StreamShared.shareToAndroid(window, url, name, extSettings.androidPlayer, sub);
  } else {
    navigator.clipboard.writeText(url).catch(() => {});
  }
}

// The URL to act on: the variant picked in the row's quality selector, else the stream itself.
function effectiveUrl(stream) {
  return selectedVariants.get(stream.url) || stream.url;
}

function updateMenu() {
  const menu = document.getElementById('video-handler-menu') || createStreamMenu();

  menu.replaceChildren(...streams.map(stream => {
    const name = stream.displayName || stream.name;
    const subtitle = stream.pageTitle || '';

    const item = document.createElement('div');
    item.className = 'stream-item';
    item.dataset.url = stream.url;
    item.title = stream.url;

    const info = document.createElement('div');
    info.className = 'stream-info';

    const streamName = document.createElement('span');
    streamName.className = 'stream-name';
    streamName.textContent = name;
    info.appendChild(streamName);

    const badges = document.createElement('div');
    badges.className = 'stream-badges';

    if (stream.quality) {
      const qualityBadge = document.createElement('span');
      qualityBadge.className = 'quality-badge';
      qualityBadge.textContent = stream.quality;
      badges.appendChild(qualityBadge);
    }

    if (stream.duration) {
      const durationBadge = document.createElement('span');
      durationBadge.className = 'duration-badge';
      durationBadge.textContent = StreamShared.formatDuration(stream.duration);
      badges.appendChild(durationBadge);
    }

    if (pageSubtitles.length > 0) {
      const subBadge = document.createElement('span');
      subBadge.className = 'sub-badge';
      subBadge.textContent = `CC ${pageSubtitles.length}`;
      subBadge.title = pageSubtitles.map(s => s.label).join('\n');
      badges.appendChild(subBadge);
    }

    if (stream.variants && stream.variants.length > 1) {
      const select = document.createElement('select');
      select.className = 'v-quality';
      select.title = 'Quality';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Auto';
      select.appendChild(auto);
      for (const variant of stream.variants) {
        const option = document.createElement('option');
        option.value = variant.url;
        option.textContent = variant.label;
        select.appendChild(option);
      }
      select.value = selectedVariants.get(stream.url) || '';
      select.onclick = e => e.stopPropagation();
      select.onchange = () => {
        if (select.value) selectedVariants.set(stream.url, select.value);
        else selectedVariants.delete(stream.url);
      };
      badges.appendChild(select);
    }

    info.appendChild(badges);

    if (subtitle) {
      const subtitleEl = document.createElement('span');
      subtitleEl.className = 'stream-subtitle';
      subtitleEl.textContent = subtitle;
      info.appendChild(subtitleEl);
    }

    const actions = document.createElement('div');
    actions.className = 'stream-actions';

    const shareButton = createActionButton(
      'v-action-share',
      extPlatform === 'android' ? 'Share' : 'Open in External Player',
      extPlatform === 'android' ? '📤' : '🖥️'
    );
    actions.appendChild(shareButton);

    if (extSettings.showCopyIcon !== false) {
      actions.appendChild(createActionButton('v-action-copy', 'Copy URL', '📋'));
    }

    if (extSettings.showPlayIcon !== false) {
      actions.appendChild(createActionButton('v-action-play', 'Play in Browser', '▶️'));
    }

    if (extPlatform !== 'android' && extSettings.showDownloadIcon) {
      actions.appendChild(createActionButton('v-action-download', 'Download with yt-dlp / ffmpeg', '⬇️'));
    }

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }));

  // Inject styles once
  if (!document.getElementById('video-handler-styles')) {
    const styles = document.createElement('style');
    styles.id = 'video-handler-styles';
    styles.textContent = `
      .stream-item {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        padding: 8px 12px !important;
        cursor: pointer !important;
        border-bottom: 1px solid rgba(255,255,255,0.08) !important;
        transition: background 0.15s !important;
      }
      .stream-item:last-child { border-bottom: none !important; }
      .stream-item:hover { background: rgba(255,255,255,0.08) !important; }
      .stream-info {
        flex: 1 !important;
        min-width: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 2px !important;
      }
      .stream-name {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font-size: 13px !important;
      }
      .stream-subtitle {
        font-size: 11px !important;
        color: rgba(255,255,255,0.5) !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .stream-badges {
        display: flex !important;
        gap: 6px !important;
        align-items: center !important;
        margin-top: 2px !important;
        flex-wrap: wrap !important;
      }
      .quality-badge, .duration-badge, .sub-badge {
        display: inline-block !important;
        color: white !important;
        padding: 1px 5px !important;
        border-radius: 3px !important;
        font-size: 10px !important;
        font-weight: 600 !important;
      }
      .quality-badge {
        background: #4CAF50 !important;
      }
      .duration-badge {
        background: #2196F3 !important;
      }
      .sub-badge {
        background: #9C27B0 !important;
      }
      .v-quality {
        background: rgba(255,255,255,0.12) !important;
        color: white !important;
        border: none !important;
        border-radius: 3px !important;
        font-size: 10px !important;
        padding: 1px 2px !important;
        cursor: pointer !important;
      }
      .v-quality option { color: black !important; }
      .stream-actions {
        display: flex !important;
        gap: 6px !important;
        margin-left: 12px !important;
        flex-shrink: 0 !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .v-handler-btn {
        all: unset !important;
        box-sizing: border-box !important;
        background: none !important;
        border: none !important;
        cursor: pointer !important;
        padding: 4px !important;
        font-size: 15px !important;
        line-height: 1 !important;
        border-radius: 4px !important;
        transition: background 0.15s !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: white !important;
        min-width: 23px !important;
        min-height: 23px !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .v-handler-btn:hover {
        background: rgba(255,255,255,0.15) !important;
      }
      @media (pointer: coarse) {
        #video-handler-menu { max-width: 92vw !important; }
        .stream-item { padding: 12px 12px !important; }
        .stream-name { font-size: 15px !important; }
        .v-handler-btn { min-width: 44px !important; min-height: 44px !important; font-size: 22px !important; }
        .v-quality { font-size: 13px !important; padding: 4px !important; }
        .quality-badge, .duration-badge, .sub-badge { font-size: 12px !important; }
      }
    `;
    document.head.appendChild(styles);
  }

  // Wire up buttons
  menu.querySelectorAll('.stream-item').forEach((item, index) => {
    const stream = streams[index];
    if (!stream) return;

    const showFailure = (el, error) => {
      const origText = el.textContent;
      el.textContent = '❌';
      el.title = error || 'Failed';
      setTimeout(() => el.textContent = origText, 1500);
    };

    // Asks the background to run an action; el (optional) shows progress/result.
    const runBackground = (type, el) => {
      const message = { type, url: effectiveUrl(stream), streamUrl: stream.url };
      if (!el) {
        browser.runtime.sendMessage(message).catch(() => {});
        return;
      }
      const origText = el.textContent;
      el.textContent = '⏳';
      browser.runtime.sendMessage(message).then(res => {
        if (res && res.success) {
          el.textContent = '✅';
          setTimeout(() => el.textContent = origText, 1500);
        } else {
          showFailure(el, res && res.error);
        }
      }).catch(() => showFailure(el, 'No response from the extension'));
    };

    const handleAction = (action, el) => {
      const url = effectiveUrl(stream);
      if (action === 'copy') {
        navigator.clipboard.writeText(url).catch(() => {});
      } else if (action === 'browser') {
        runBackground('openWebPlayer', null);
      } else if (action === 'external') {
        runBackground('openExternalPlayer', el);
      } else if (action === 'download') {
        runBackground('downloadStream', el);
      } else {
        shareUrl(url, stream.displayName || stream.name || ''); // default/share
      }
    };

    item.onclick = () => {
      let action = extSettings.defaultTapAction || 'default';
      if (action === 'default') {
        action = extPlatform === 'android' ? 'share' : 'copy';
      }
      handleAction(action, null);
    };

    const btnShare = item.querySelector('.v-action-share');
    if (btnShare) {
      btnShare.onclick = (e) => {
        e.stopPropagation();
        handleAction(extPlatform === 'android' ? 'share' : 'external', btnShare);
      };
    }

    const btnCopy = item.querySelector('.v-action-copy');
    if (btnCopy) {
      btnCopy.onclick = (e) => {
        e.stopPropagation();
        const origText = btnCopy.textContent;
        btnCopy.textContent = '✅';
        setTimeout(() => btnCopy.textContent = origText, 1000);
        handleAction('copy', null);
      };
    }

    const btnPlay = item.querySelector('.v-action-play');
    if (btnPlay) {
      btnPlay.onclick = (e) => {
        e.stopPropagation();
        handleAction('browser', null);
      };
    }

    const btnDownload = item.querySelector('.v-action-download');
    if (btnDownload) {
      btnDownload.onclick = (e) => {
        e.stopPropagation();
        handleAction('download', btnDownload);
      };
    }
  });
}

function createActionButton(actionClass, title, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `v-handler-btn ${actionClass}`;
  button.title = title;
  button.textContent = label;
  return button;
}

function applyRuntimeState(response = {}) {
  extSettings = { ...defaultSettings, ...(response.settings || extSettings || {}) };
  extPlatform = response.platform || extPlatform;
}

// ─── Floating button: position, drag, visibility ─────────────────────────────

const BUTTON_SIZE = 48;
const BUTTON_MARGIN = 20;
const DEFAULT_BUTTON_POS = { side: 'right', yRatio: 1 }; // bottom-right corner
let buttonLayout = { global: { ...DEFAULT_BUTTON_POS }, sites: {} };
let lastDragEnd = 0;
let fadeTimer = null;

function sanitizePos(pos) {
  if (!pos || (pos.side !== 'left' && pos.side !== 'right') || typeof pos.yRatio !== 'number' || !isFinite(pos.yRatio)) {
    return null;
  }
  return { side: pos.side, yRatio: Math.min(1, Math.max(0, pos.yRatio)) };
}

function normalizeLayout(value) {
  const layout = { global: { ...DEFAULT_BUTTON_POS }, sites: {} };
  if (value) {
    layout.global = sanitizePos(value.global) || layout.global;
    for (const [host, pos] of Object.entries(value.sites || {})) {
      const clean = sanitizePos(pos);
      if (clean) layout.sites[host] = clean;
    }
  }
  return layout;
}

function currentButtonPos() {
  return buttonLayout.sites[location.hostname] || buttonLayout.global;
}

function viewportSize() {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: window.innerHeight
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// Places the button from the stored {side, yRatio}; independent of the window size.
function applyButtonPosition(button = document.getElementById('video-handler-button')) {
  if (!button) return;
  const { width, height } = viewportSize();
  const pos = currentButtonPos();
  const left = pos.side === 'left' ? BUTTON_MARGIN : width - BUTTON_SIZE - BUTTON_MARGIN;
  const top = clamp(pos.yRatio * (height - BUTTON_SIZE), BUTTON_MARGIN, height - BUTTON_SIZE - BUTTON_MARGIN);
  button.style.left = `${Math.max(0, left)}px`;
  button.style.top = `${top}px`;
  button.style.right = 'auto';
  button.style.bottom = 'auto';
  positionMenu();
}

// Opens the menu towards the side of the screen that has room, next to the button.
function positionMenu() {
  const button = document.getElementById('video-handler-button');
  const menu = document.getElementById('video-handler-menu');
  if (!button || !menu || menu.style.display === 'none') return;
  const { width, height } = viewportSize();
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const edge = 8;
  const openUp = rect.top + rect.height / 2 > height / 2;
  const space = openUp ? rect.top - gap - edge : height - rect.bottom - gap - edge;
  menu.style.maxHeight = `${Math.max(120, Math.min(350, space))}px`;
  if (openUp) {
    menu.style.top = 'auto';
    menu.style.bottom = `${height - rect.top + gap}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${rect.bottom + gap}px`;
  }
  if (rect.left + rect.width / 2 > width / 2) {
    menu.style.left = 'auto';
    menu.style.right = `${Math.max(edge, width - rect.right)}px`;
  } else {
    menu.style.right = 'auto';
    menu.style.left = `${Math.max(edge, rect.left)}px`;
  }
}

function toggleMenu() {
  const menu = document.getElementById('video-handler-menu');
  if (!menu) return;
  const opening = menu.style.display === 'none';
  menu.style.display = opening ? 'block' : 'none';
  if (opening) positionMenu();
  wakeButton();
}

// "Fade when idle": the button becomes translucent after a few seconds, unless the menu is open.
function wakeButton() {
  const button = document.getElementById('video-handler-button');
  if (!button) return;
  button.classList.remove('v-faded');
  clearTimeout(fadeTimer);
  if (extSettings.buttonVisibility !== 'fade') return;
  fadeTimer = setTimeout(() => {
    const menu = document.getElementById('video-handler-menu');
    if (menu && menu.style.display !== 'none') {
      wakeButton();
      return;
    }
    button.classList.add('v-faded');
  }, 3000);
}

// Shown only while there are streams, the user did not choose "hidden", and no
// element (usually a video) is in fullscreen.
function updateButtonVisibility() {
  const button = document.getElementById('video-handler-button');
  if (!button) return;
  const hidden = streams.length === 0 || extSettings.buttonVisibility === 'never' || !!document.fullscreenElement;
  button.style.display = hidden ? 'none' : 'flex';
  if (hidden) {
    const menu = document.getElementById('video-handler-menu');
    if (menu) menu.style.display = 'none';
  } else {
    applyButtonPosition(button);
    wakeButton();
  }
}

function saveButtonPosition(pos) {
  buttonLayout.sites[location.hostname] = pos;
  browser.storage.local.set({ buttonLayout }).catch(() => {});
}

// Mouse: drag after a few pixels of movement. Touch: long-press first, so a
// normal tap still opens the menu.
function setupButtonDrag(button) {
  const THRESHOLD = 6;
  const LONG_PRESS_MS = 350;
  let drag = null;

  const startDragging = () => {
    drag.active = true;
    button.classList.add('v-dragging');
    const menu = document.getElementById('video-handler-menu');
    if (menu) menu.style.display = 'none';
    if (navigator.vibrate && drag.type === 'touch') navigator.vibrate(15);
  };

  button.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = button.getBoundingClientRect();
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top, active: false, type: e.pointerType, timer: null };
    if (e.pointerType === 'touch') {
      drag.timer = setTimeout(() => { if (drag && !drag.active) startDragging(); }, LONG_PRESS_MS);
    }
    try { button.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  });

  button.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      if (drag.type === 'touch') { // moved before the long-press: not a drag
        clearTimeout(drag.timer);
        drag = null;
        return;
      }
      startDragging();
    }
    const { width, height } = viewportSize();
    button.style.left = `${clamp(drag.left + dx, 0, width - BUTTON_SIZE)}px`;
    button.style.top = `${clamp(drag.top + dy, 0, height - BUTTON_SIZE)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    e.preventDefault();
  });

  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    clearTimeout(drag.timer);
    const wasDragging = drag.active;
    drag = null;
    button.classList.remove('v-dragging');
    try { button.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (!wasDragging) return;
    lastDragEnd = Date.now();
    // Snap to the nearest side edge; keep the vertical position as a ratio
    const { width, height } = viewportSize();
    const rect = button.getBoundingClientRect();
    const pos = {
      side: rect.left + rect.width / 2 < width / 2 ? 'left' : 'right',
      yRatio: clamp(rect.top / Math.max(1, height - BUTTON_SIZE), 0, 1)
    };
    saveButtonPosition(pos);
    applyButtonPosition(button);
  };
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
}

function createFloatingButton() {
  const button = document.createElement('div');
  button.id = 'video-handler-button';
  button.innerHTML = '▶️';
  button.style.display = 'none';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-label', 'Detected streams (drag to move)');
  document.body.appendChild(button);
  applyButtonPosition(button);
  setupButtonDrag(button);

  let lastClickTime = 0;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - lastDragEnd < 150) return; // the click that ends a drag
    const now = Date.now();
    if (now - lastClickTime < 300) return; // Prevent double-fire on touch devices
    lastClickTime = now;
    toggleMenu();
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMenu();
    }
  });
  button.addEventListener('pointerenter', wakeButton);
  button.addEventListener('focus', wakeButton);

  return button;
}

browser.storage.local.get('buttonLayout').then(result => {
  buttonLayout = normalizeLayout(result.buttonLayout);
  applyButtonPosition();
}).catch(() => {});
window.addEventListener('resize', () => applyButtonPosition());
document.addEventListener('fullscreenchange', updateButtonVisibility);

// ─── MutationObserver for dynamic video elements ──────────────────────────────

function setupVideoObserver() {
  if (observer) return; // Already watching

  const callback = () => {
    // Debounce: wait 1s after last mutation before scanning
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sources = [];
      const tracks = [];
      document.querySelectorAll('video').forEach(video => {
        if (video.src && video.src.startsWith('http')) {
          sources.push({ url: video.src, duration: video.duration });
        }
        video.querySelectorAll('source').forEach(source => {
          if (source.src && source.src.startsWith('http')) {
            sources.push({ url: source.src, duration: video.duration });
          }
        });
        video.querySelectorAll('track').forEach(track => {
          if (track.src && track.src.startsWith('http')) {
            tracks.push({ url: track.src, label: track.label || '', lang: track.srclang || '' });
          }
        });
      });
      document.querySelectorAll('[data-source]').forEach(el => {
        const src = el.getAttribute('data-source');
        if (src && src.startsWith('http')) {
          sources.push({ url: src, duration: null });
        }
      });

      // Safety net for requests the background missed (extension still starting,
      // restored tabs): re-read the page's resource timing entries.
      const resources = [];
      for (const entry of performance.getEntriesByType('resource')) {
        if (seenResources.has(entry.name) || !LIKELY_MEDIA_URL.test(entry.name)) continue;
        seenResources.add(entry.name);
        resources.push(entry.name);
      }

      if (sources.length > 0 || tracks.length > 0 || resources.length > 0) {
        browser.runtime.sendMessage({
          type: 'videoSourcesFound',
          sources: sources,
          tracks: tracks,
          resources: resources
        }).catch(() => {});
      }
    }, 1000);
  };

  observer = new MutationObserver(callback);
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial scan
  callback();
}

// ─── Message listener ─────────────────────────────────────────────────────────

function showStreams(newStreams, newSubtitles) {
  streams = newStreams;
  pageSubtitles = newSubtitles || [];
  const render = () => {
    if (!document.getElementById('video-handler-button')) createFloatingButton();
    updateMenu();
    updateButtonVisibility();
  };
  browser.runtime.sendMessage({ type: 'getSettings' }).then(res => {
    if (res) {
      applyRuntimeState(res);
    }
    render();
  }).catch(render);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "streamDetected") {
    showStreams(message.streams, message.subtitles);
  } else if (message.type === "streamsCleared") {
    streams = [];
    pageSubtitles = [];
    selectedVariants.clear();
    const menu = document.getElementById('video-handler-menu');
    if (menu) {
      menu.style.display = 'none';
      menu.replaceChildren();
    }
    updateButtonVisibility();
  }
});

// This script can finish loading after the background already pushed its
// "streamDetected" message (slow first load, back/forward cache), in which case
// that push is lost. Pull the current list once so the button still appears.
function requestInitialStreams() {
  browser.runtime.sendMessage({ type: 'getStreams', docUrl: location.href }).then(res => {
    if (res && res.streams && res.streams.length > 0 && streams.length === 0) {
      showStreams(res.streams, res.subtitles);
    }
  }).catch(() => {});
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    applyRuntimeState({ settings: changes.settings.newValue });
    const menu = document.getElementById('video-handler-menu');
    if (menu) {
      updateMenu();
    }
    updateButtonVisibility();
  }
  if (changes.buttonLayout) {
    // Changed from the popup (corner choice / reset) or from another tab of this site
    buttonLayout = normalizeLayout(changes.buttonLayout.newValue);
    applyButtonPosition();
  }
});

// Start observing when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupVideoObserver);
} else {
  setupVideoObserver();
}
requestInitialStreams();
