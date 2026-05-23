let streams = [];
let observer = null;
let debounceTimer = null;
const defaultSettings = {
  showCopyIcon: true,
  showPlayIcon: true,
  defaultTapAction: 'default'
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

function shareUrl(url) {
  if (navigator.share && extPlatform === 'android') {
    navigator.share({ url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).catch(() => {});
  }
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds === Infinity) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
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
      durationBadge.textContent = formatDuration(stream.duration);
      badges.appendChild(durationBadge);
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
      }
      .quality-badge, .duration-badge {
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
    `;
    document.head.appendChild(styles);
  }

  // Wire up buttons
  menu.querySelectorAll('.stream-item').forEach(item => {
    const url = item.dataset.url;
    
    const handleAction = (action, el) => {
      if (action === 'copy') {
        navigator.clipboard.writeText(url).catch(() => {});
      } else if (action === 'browser') {
        browser.runtime.sendMessage({ type: 'openWebPlayer', url: url });
      } else if (action === 'external') {
        if (el) {
          const origText = el.textContent;
          el.textContent = '⏳';
          browser.runtime.sendMessage({ type: 'openExternalPlayer', url: url }).then(res => {
            el.textContent = res && res.success ? '✅' : '❌';
            if (res && !res.success && res.error) {
              alert("External Player Error: " + res.error);
            }
            setTimeout(() => el.textContent = origText, 1500);
          }).catch(() => {
            el.textContent = '❌';
            setTimeout(() => el.textContent = origText, 1500);
          });
        } else {
          browser.runtime.sendMessage({ type: 'openExternalPlayer', url: url }).then(res => {
            if (res && !res.success && res.error) alert("External Player Error: " + res.error);
          }).catch(() => {});
        }
      } else {
        shareUrl(url); // default/share
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

function createFloatingButton() {
  const button = document.createElement('div');
  button.id = 'video-handler-button';
  button.innerHTML = '▶️';
  button.style.display = 'none';
  document.body.appendChild(button);

  let lastClickTime = 0;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastClickTime < 300) return; // Prevent double-fire on touch devices
    lastClickTime = now;
    
    const menu = document.getElementById('video-handler-menu');
    if (menu) {
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
  });

  return button;
}

// ─── MutationObserver for dynamic video elements ──────────────────────────────

function setupVideoObserver() {
  if (observer) return; // Already watching

  const callback = () => {
    // Debounce: wait 1s after last mutation before scanning
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sources = [];
      document.querySelectorAll('video').forEach(video => {
        if (video.src && video.src.startsWith('http')) {
          sources.push({ url: video.src, duration: video.duration });
        }
        video.querySelectorAll('source').forEach(source => {
          if (source.src && source.src.startsWith('http')) {
            sources.push({ url: source.src, duration: video.duration });
          }
        });
      });
      document.querySelectorAll('[data-source]').forEach(el => {
        const src = el.getAttribute('data-source');
        if (src && src.startsWith('http')) {
          sources.push({ url: src, duration: null });
        }
      });

      if (sources.length > 0) {
        browser.runtime.sendMessage({
          type: 'videoSourcesFound',
          sources: sources
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

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "streamDetected") {
    streams = message.streams;
    browser.runtime.sendMessage({ type: 'getSettings' }).then(res => {
      if (res) {
        applyRuntimeState(res);
      }
      const button = document.getElementById('video-handler-button') || createFloatingButton();
      button.style.display = 'block';
      updateMenu();
    }).catch(() => {
      const button = document.getElementById('video-handler-button') || createFloatingButton();
      button.style.display = 'block';
      updateMenu();
    });
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    applyRuntimeState({ settings: changes.settings.newValue });
    const menu = document.getElementById('video-handler-menu');
    if (menu) {
      updateMenu();
    }
  }
});

// Start observing when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupVideoObserver);
} else {
  setupVideoObserver();
}
