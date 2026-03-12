let streams = [];
let observer = null;
let debounceTimer = null;

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
  if (navigator.share) {
    navigator.share({ url }).catch(() => {});
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

  menu.innerHTML = streams.map(stream => {
    const name = stream.displayName || stream.name;
    const subtitle = stream.pageTitle || '';
    return `
    <div class="stream-item" data-url="${stream.url}" title="${stream.url}">
      <div class="stream-info">
        <span class="stream-name">${escapeHtml(name)}</span>
        <div class="stream-badges">
          ${stream.quality ? `<span class="quality-badge">${stream.quality}</span>` : ''}
          ${stream.duration ? `<span class="duration-badge">${formatDuration(stream.duration)}</span>` : ''}
        </div>
        ${subtitle ? `<span class="stream-subtitle">${escapeHtml(subtitle)}</span>` : ''}
      </div>
      <div class="stream-actions">
        <button class="share-btn" title="Share">📤</button>
      </div>
    </div>`;
  }).join('');

  // Inject styles once
  if (!document.getElementById('video-handler-styles')) {
    const styles = document.createElement('style');
    styles.id = 'video-handler-styles';
    styles.textContent = `
      .stream-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        transition: background 0.15s;
      }
      .stream-item:last-child { border-bottom: none; }
      .stream-item:hover { background: rgba(255,255,255,0.08); }
      .stream-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .stream-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }
      .stream-subtitle {
        font-size: 11px;
        color: rgba(255,255,255,0.5);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stream-badges {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-top: 2px;
      }
      .quality-badge, .duration-badge {
        display: inline-block;
        color: white;
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 600;
      }
      .quality-badge {
        background: #4CAF50;
      }
      .duration-badge {
        background: #2196F3;
      }
      .stream-actions {
        display: flex;
        gap: 6px;
        margin-left: 12px;
        flex-shrink: 0;
      }
      .share-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        font-size: 15px;
        border-radius: 4px;
        transition: background 0.15s;
      }
      .share-btn:hover {
        background: rgba(255,255,255,0.15);
      }
    `;
    document.head.appendChild(styles);
  }

  // Wire up buttons
  menu.querySelectorAll('.stream-item').forEach(item => {
    const url = item.dataset.url;
    
    // Restore tap-the-entire-item to share behavior
    item.onclick = () => {
      shareUrl(url);
    };
    
    item.querySelector('.share-btn').onclick = (e) => {
      e.stopPropagation();
      shareUrl(url);
    };
  });
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function createFloatingButton() {
  const button = document.createElement('div');
  button.id = 'video-handler-button';
  button.innerHTML = '▶️';
  button.style.display = 'none';
  document.body.appendChild(button);

  button.onclick = () => {
    const menu = document.getElementById('video-handler-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  };

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
    const button = document.getElementById('video-handler-button') || createFloatingButton();
    button.style.display = 'block';
    updateMenu();
  }
});

// Start observing when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupVideoObserver);
} else {
  setupVideoObserver();
}