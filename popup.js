// popup.js

const defaults = {
  enabled: true,
  cleanNames: true,
  maxStreams: 50,
  whitelist: [],
  blacklist: [],
  showCopyIcon: true,
  showPlayIcon: true,
  defaultTapAction: 'default',
  desktopExternalMethod: 'protocol',
  desktopProtocol: 'vlc://',
  externalPlayerPath: '',
  vlcHttpPassword: ''
};

let currentDomain = '';

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings and platform
  const msgResult = await browser.runtime.sendMessage({ type: 'getSettings' });
  const settings = { ...defaults, ...(msgResult.settings || {}) };
  const platform = msgResult.platform || 'win';

  // Populate UI
  document.getElementById('toggle-enabled').checked = settings.enabled;
  document.getElementById('toggle-clean-names').checked = settings.cleanNames;
  document.getElementById('max-streams').value = settings.maxStreams;
  document.getElementById('max-streams-value').textContent = settings.maxStreams;
  document.getElementById('whitelist').value = (settings.whitelist || []).join('\n');
  document.getElementById('blacklist').value = (settings.blacklist || []).join('\n');

  if (platform !== 'android') {
    document.getElementById('desktop-settings').style.display = 'block';
    
    document.getElementById('toggle-copy-icon').checked = settings.showCopyIcon;
    document.getElementById('toggle-play-icon').checked = settings.showPlayIcon;
    document.getElementById('default-action').value = settings.defaultTapAction;
    document.getElementById('external-method').value = settings.desktopExternalMethod;
    document.getElementById('desktop-protocol').value = settings.desktopProtocol;
    document.getElementById('external-player-path').value = settings.externalPlayerPath;
    document.getElementById('vlc-http-password').value = settings.vlcHttpPassword;

    const updateMethodVisibility = () => {
      const val = document.getElementById('external-method').value;
      document.getElementById('protocol-settings').style.display = val === 'protocol' ? 'flex' : 'none';
      document.getElementById('native-settings').style.display = val === 'native' ? 'flex' : 'none';
      document.getElementById('vlc-http-settings').style.display = val === 'vlc_http' ? 'flex' : 'none';
    };
    updateMethodVisibility();
    
    document.getElementById('external-method').addEventListener('change', (e) => {
      updateMethodVisibility();
      saveSettings({ desktopExternalMethod: e.target.value });
    });
    
    document.getElementById('toggle-copy-icon').addEventListener('change', e => saveSettings({ showCopyIcon: e.target.checked }));
    document.getElementById('toggle-play-icon').addEventListener('change', e => saveSettings({ showPlayIcon: e.target.checked }));
    document.getElementById('default-action').addEventListener('change', e => saveSettings({ defaultTapAction: e.target.value }));
    document.getElementById('desktop-protocol').addEventListener('change', e => saveSettings({ desktopProtocol: e.target.value }));
    document.getElementById('external-player-path').addEventListener('change', e => saveSettings({ externalPlayerPath: e.target.value }));
    document.getElementById('vlc-http-password').addEventListener('change', e => saveSettings({ vlcHttpPassword: e.target.value }));
  }

  // Get current tab info
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const tab = tabs[0];
      const url = new URL(tab.url);
      currentDomain = url.hostname;
      document.getElementById('current-domain').textContent = currentDomain;

      // Check if current domain is blacklisted
      const isBlacklisted = settings.blacklist.some(d => currentDomain.includes(d));
      document.getElementById('toggle-site').checked = !isBlacklisted;

      // Get stream count for this tab
      const response = await browser.runtime.sendMessage({
        type: 'getStreamCount',
        tabId: tab.id
      });
      if (response?.count !== undefined) {
        const countEl = document.getElementById('stream-count');
        countEl.textContent = `${response.count} stream${response.count !== 1 ? 's' : ''}`;
      }
    }
  } catch (e) {
    document.getElementById('current-domain').textContent = 'N/A';
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  // Master toggle
  document.getElementById('toggle-enabled').addEventListener('change', (e) => {
    saveSettings({ enabled: e.target.checked });
  });

  // Clean names toggle
  document.getElementById('toggle-clean-names').addEventListener('change', (e) => {
    saveSettings({ cleanNames: e.target.checked });
  });

  // Max streams slider
  const slider = document.getElementById('max-streams');
  slider.addEventListener('input', (e) => {
    document.getElementById('max-streams-value').textContent = e.target.value;
  });
  slider.addEventListener('change', (e) => {
    saveSettings({ maxStreams: parseInt(e.target.value, 10) });
  });

  // Site toggle — adds/removes from blacklist
  document.getElementById('toggle-site').addEventListener('change', async (e) => {
    if (!currentDomain) return;

    const result = await browser.storage.local.get('settings');
    const settings = { ...defaults, ...(result.settings || {}) };
    let blacklist = settings.blacklist || [];

    if (e.target.checked) {
      // Remove from blacklist
      blacklist = blacklist.filter(d => d !== currentDomain);
    } else {
      // Add to blacklist
      if (!blacklist.includes(currentDomain)) {
        blacklist.push(currentDomain);
      }
    }

    saveSettings({ blacklist });
    // Update blacklist textarea to stay in sync
    document.getElementById('blacklist').value = blacklist.join('\n');
  });

  // Save lists button
  document.getElementById('save-lists').addEventListener('click', () => {
    const whitelist = parseDomainList(document.getElementById('whitelist').value);
    const blacklist = parseDomainList(document.getElementById('blacklist').value);
    saveSettings({ whitelist, blacklist });

    // Visual feedback
    const btn = document.getElementById('save-lists');
    btn.textContent = '✓ Saved';
    btn.classList.add('saved');
    setTimeout(() => {
      btn.textContent = 'Save Lists';
      btn.classList.remove('saved');
    }, 1500);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDomainList(text) {
  return text
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => line.length > 0 && line.includes('.'));
}

async function saveSettings(partial) {
  const result = await browser.storage.local.get('settings');
  const current = { ...defaults, ...(result.settings || {}) };
  const updated = { ...current, ...partial };
  await browser.storage.local.set({ settings: updated });

  // Also notify background script
  browser.runtime.sendMessage({
    type: 'updateSettings',
    settings: updated
  }).catch(() => {});
}
