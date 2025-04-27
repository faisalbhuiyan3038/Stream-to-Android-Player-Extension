let streams = [];

// Clear streams when page unloads
window.addEventListener('beforeunload', () => {
  streams = [];
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
    navigator.share({
      url: url
    }).catch(console.error);
  }
}

function updateMenu() {
  const menu = document.getElementById('video-handler-menu') || createStreamMenu();
  menu.innerHTML = streams.map(stream => `
    <div class="stream-item" data-url="${stream.url}" title="${stream.name}">
      <div class="stream-info">
        ${stream.name}
        ${stream.quality ? `<span class="quality-badge">${stream.quality}</span>` : ''}
      </div>
      <div class="stream-actions">
        <button class="share-btn" title="Share">📤</button>
        <button class="download-btn" title="Download">⬇️</button>
      </div>
    </div>
  `).join('');

  // Add CSS for quality badge if not already added
  if (!document.getElementById('video-handler-styles')) {
    const styles = document.createElement('style');
    styles.id = 'video-handler-styles';
    styles.textContent = `
      .stream-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px;
        cursor: pointer;
      }
      .quality-badge {
        background-color: #4CAF50;
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 12px;
        margin-left: 8px;
      }
      .stream-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px;
      }
      .stream-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stream-actions {
        display: flex;
        gap: 8px;
        margin-left: 16px;
      }
      .share-btn, .download-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        font-size: 16px;
        border-radius: 4px;
        transition: background-color 0.2s;
      }
      .share-btn:hover, .download-btn:hover {
        background-color: rgba(0,0,0,0.1);
      }
    `;
    document.head.appendChild(styles);
  }

  menu.querySelectorAll('.stream-item').forEach(item => {
    const url = item.dataset.url;
    item.querySelector('.share-btn').onclick = (e) => {
      e.stopPropagation();
      shareUrl(url);
    };
    item.querySelector('.download-btn').onclick = (e) => {
      e.stopPropagation();
      browser.runtime.sendMessage({
        type: 'initiateDownload',
        url: url,
        filename: item.querySelector('.stream-info').textContent.trim()
      });
    };
  });
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

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "streamDetected") {
    streams = message.streams;
    const button = document.getElementById('video-handler-button') || createFloatingButton();
    button.style.display = 'block';
    updateMenu();
  }
});