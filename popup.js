// popup.js
if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}

const defaults = {
  enabled: true,
  cleanNames: true,
  maxStreams: 50,
  whitelist: [],
  blacklist: [],
  showCopyIcon: true,
  showPlayIcon: true,
  showDownloadIcon: true,
  defaultTapAction: 'default',
  webPlayerEngine: 'vidstack',
  desktopExternalMethod: 'native',
  desktopProtocol: 'vlc://',
  protocolUrlFormat: 'encoded',
  buttonVisibility: 'always',
  externalPlayerPath: '',
  nativeArgsTemplate: '',
  downloadDir: '',
  forwardCookies: false,
  androidPlayer: 'auto',
  vlcHttpPassword: '',
  customPatterns: '',
  openStreamLinks: false,
  openMp4Links: false,
  fastBuffering: true,
  fastBufferingParallel: 4,
  bufferAheadSeconds: 0,
  cacheWholeVideo: true,
  cacheLimitGB: 0,
  downloadMethod: 'browser'
};

let currentDomain = '';

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings and platform directly to avoid background script wake-up race conditions
  const storageResult = await browser.storage.local.get('settings');
  const settings = { ...defaults, ...(storageResult.settings || {}) };
  
  let platform = 'win';
  try {
    const info = await browser.runtime.getPlatformInfo();
    platform = info.os;
  } catch (e) {
    // fallback to default
  }

  // Populate UI
  document.getElementById('toggle-enabled').checked = settings.enabled;
  document.getElementById('toggle-clean-names').checked = settings.cleanNames;
  document.getElementById('max-streams').value = settings.maxStreams;
  document.getElementById('max-streams-value').textContent = settings.maxStreams;
  document.getElementById('whitelist').value = (settings.whitelist || []).join('\n');
  document.getElementById('blacklist').value = (settings.blacklist || []).join('\n');
  document.getElementById('custom-patterns').value = settings.customPatterns || '';
  document.getElementById('toggle-open-stream-links').checked = !!settings.openStreamLinks;
  document.getElementById('toggle-open-mp4-links').checked = !!settings.openMp4Links;
  document.getElementById('toggle-open-stream-links').addEventListener('change', e => saveSettings({ openStreamLinks: e.target.checked }));
  document.getElementById('toggle-open-mp4-links').addEventListener('change', e => saveSettings({ openMp4Links: e.target.checked }));
  const cacheToggle = document.getElementById('toggle-cache-whole-video');
  const cacheOptions = document.getElementById('cache-options');
  cacheToggle.checked = settings.cacheWholeVideo !== false;
  cacheOptions.style.display = cacheToggle.checked ? '' : 'none';
  document.getElementById('cache-limit').value = String(settings.cacheLimitGB || 0);
  cacheToggle.addEventListener('change', e => {
    cacheOptions.style.display = e.target.checked ? '' : 'none';
    saveSettings({ cacheWholeVideo: e.target.checked });
  });
  document.getElementById('cache-limit').addEventListener('change', e => saveSettings({ cacheLimitGB: parseInt(e.target.value, 10) }));
  // Parallel downloads and buffer ahead are always shown: whole-video loading uses them too
  const fastToggle = document.getElementById('toggle-fast-buffering');
  fastToggle.checked = settings.fastBuffering !== false;
  document.getElementById('fast-buffering-parallel').value = String(settings.fastBufferingParallel || 4);
  document.getElementById('buffer-ahead').value = String(settings.bufferAheadSeconds || 0);
  fastToggle.addEventListener('change', e => saveSettings({ fastBuffering: e.target.checked }));
  document.getElementById('fast-buffering-parallel').addEventListener('change', e => saveSettings({ fastBufferingParallel: parseInt(e.target.value, 10) }));
  document.getElementById('buffer-ahead').addEventListener('change', e => saveSettings({ bufferAheadSeconds: parseInt(e.target.value, 10) }));

  // Floating button controls (all platforms)
  document.getElementById('button-visibility').value = settings.buttonVisibility;
  document.getElementById('button-visibility').addEventListener('change', e => saveSettings({ buttonVisibility: e.target.value }));
  await initButtonPositionControls();

  if (platform === 'android') {
    document.getElementById('android-settings').style.display = 'block';
    document.getElementById('android-player').value = settings.androidPlayer;
    document.getElementById('android-default-action').value = settings.defaultTapAction;
    document.getElementById('android-player').addEventListener('change', e => saveSettings({ androidPlayer: e.target.value }));
    document.getElementById('android-default-action').addEventListener('change', e => saveSettings({ defaultTapAction: e.target.value }));
    document.getElementById('android-web-player-engine').value = settings.webPlayerEngine;
    document.getElementById('android-web-player-engine').addEventListener('change', e => saveSettings({ webPlayerEngine: e.target.value }));
    document.getElementById('android-download-icon').checked = settings.showDownloadIcon;
    document.getElementById('android-download-icon').addEventListener('change', e => saveSettings({ showDownloadIcon: e.target.checked }));
  }

  if (platform !== 'android') {
    document.getElementById('desktop-settings').style.display = 'block';

    document.getElementById('toggle-copy-icon').checked = settings.showCopyIcon;
    document.getElementById('toggle-play-icon').checked = settings.showPlayIcon;
    document.getElementById('toggle-download-icon').checked = settings.showDownloadIcon;
    document.getElementById('toggle-forward-cookies').checked = settings.forwardCookies;
    document.getElementById('native-args-template').value = settings.nativeArgsTemplate;
    document.getElementById('download-dir').value = settings.downloadDir;
    document.getElementById('default-action').value = settings.defaultTapAction;
    document.getElementById('web-player-engine').value = settings.webPlayerEngine;
    document.getElementById('external-method').value = settings.desktopExternalMethod;
    document.getElementById('desktop-protocol').value = settings.desktopProtocol;
    document.getElementById('protocol-format').value = settings.protocolUrlFormat;
    document.getElementById('protocol-format').addEventListener('change', e => saveSettings({ protocolUrlFormat: e.target.value }));
    document.getElementById('external-player-path').value = settings.externalPlayerPath;
    document.getElementById('vlc-http-password').value = settings.vlcHttpPassword;

    const checkNativePermission = async () => {
      try {
        const hasPermission = await browser.permissions.contains({ permissions: ['nativeMessaging'] });
        const warningEl = document.getElementById('native-permission-warning');
        if (warningEl) {
          warningEl.style.display = hasPermission ? 'none' : 'block';
        }
        return hasPermission;
      } catch (e) {
        console.error('Error checking nativeMessaging permission:', e);
        return false;
      }
    };

    const requestNativePermission = async () => {
      try {
        const granted = await browser.permissions.request({ permissions: ['nativeMessaging'] });
        await checkNativePermission();
        return granted;
      } catch (e) {
        console.error('Error requesting nativeMessaging permission:', e);
        return false;
      }
    };

    const updateMethodVisibility = () => {
      const val = document.getElementById('external-method').value;
      document.getElementById('protocol-settings').style.display = val === 'protocol' ? 'flex' : 'none';
      document.getElementById('native-settings').style.display = val === 'native' ? 'flex' : 'none';
      document.getElementById('vlc-http-settings').style.display = val === 'vlc_http' ? 'flex' : 'none';
      if (val === 'native') {
        checkNativePermission();
      }
    };
    updateMethodVisibility();
    
    document.getElementById('external-method').addEventListener('change', async (e) => {
      const val = e.target.value;
      updateMethodVisibility();
      
      // Save immediately in case the permission prompt closes the popup
      saveSettings({ desktopExternalMethod: val });
      
      if (val === 'native') {
        const granted = await requestNativePermission();
        if (!granted) {
          alert('Native Messaging permission is required to use this option. Reverting to Protocol Handler.');
          document.getElementById('external-method').value = 'protocol';
          updateMethodVisibility();
          saveSettings({ desktopExternalMethod: 'protocol' });
          return;
        }
      }
    });

    document.getElementById('grant-native-permission').addEventListener('click', async () => {
      const granted = await requestNativePermission();
      if (granted) {
        alert('Permission granted successfully!');
      } else {
        alert('Permission was not granted.');
      }
    });
    
    document.getElementById('toggle-copy-icon').addEventListener('change', e => saveSettings({ showCopyIcon: e.target.checked }));
    document.getElementById('toggle-play-icon').addEventListener('change', e => saveSettings({ showPlayIcon: e.target.checked }));
    document.getElementById('toggle-download-icon').addEventListener('change', e => saveSettings({ showDownloadIcon: e.target.checked }));
    document.getElementById('download-method').value = settings.downloadMethod || 'browser';
    document.getElementById('download-method').addEventListener('change', e => saveSettings({ downloadMethod: e.target.value }));
    document.getElementById('toggle-forward-cookies').addEventListener('change', e => saveSettings({ forwardCookies: e.target.checked }));
    document.getElementById('native-args-template').addEventListener('change', e => saveSettings({ nativeArgsTemplate: e.target.value }));
    document.getElementById('download-dir').addEventListener('change', e => saveSettings({ downloadDir: e.target.value }));
    document.getElementById('test-native').addEventListener('click', async () => {
      const out = document.getElementById('native-test-result');
      out.textContent = 'Testing…';
      const granted = await checkNativePermission();
      if (!granted) {
        out.textContent = 'Grant the Native Messaging permission first.';
        return;
      }
      const res = await browser.runtime.sendMessage({ type: 'nativePing' }).catch(e => ({ success: false, error: e.message }));
      if (res && res.success) {
        const tools = [res.response.ytdlp ? 'yt-dlp' : null, res.response.ffmpeg ? 'ffmpeg' : null].filter(Boolean);
        out.textContent = `Host v${res.response.version} OK (${res.response.os}). Download tools: ${tools.join(', ') || 'none found'}.`;
      } else {
        out.textContent = `Failed: ${res && res.error}`;
      }
    });
    document.getElementById('default-action').addEventListener('change', e => saveSettings({ defaultTapAction: e.target.value }));
    document.getElementById('web-player-engine').addEventListener('change', e => saveSettings({ webPlayerEngine: e.target.value }));
    document.getElementById('desktop-protocol').addEventListener('change', e => saveSettings({ desktopProtocol: e.target.value }));
    document.getElementById('external-player-path').addEventListener('change', e => saveSettings({ externalPlayerPath: e.target.value }));
    document.getElementById('vlc-http-password').addEventListener('change', e => saveSettings({ vlcHttpPassword: e.target.value }));
  }

  // Get current tab info
  try {
    // popup.html?tabId=N inspects another tab (used by the automated tests)
    const forcedTabId = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
    const tabs = Number.isInteger(forcedTabId)
      ? [await browser.tabs.get(forcedTabId)]
      : await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const tab = tabs[0];
      const url = new URL(tab.url);
      currentDomain = url.hostname;
      document.getElementById('current-domain').textContent = currentDomain;

      // Check if current domain is blacklisted
      const isBlacklisted = StreamShared.matchesDomainList(currentDomain, settings.blacklist) &&
        !StreamShared.matchesDomainList(currentDomain, settings.whitelist);
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
      await renderStreamList(tab.id, settings, platform);
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
      // Remove every positive rule that blocks this host (e.g. "example.com" for www.example.com)
      blacklist = blacklist.filter(d => {
        const rule = StreamShared.parseDomainRule(d);
        return !rule || rule.negate || !StreamShared.matchesDomainRule(currentDomain, rule);
      });
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

  // Live validation of the lists and the custom patterns
  const showListErrors = () => {
    const errors = [
      ...StreamShared.validateDomainList(parseDomainList(document.getElementById('whitelist').value)).map(e => 'Whitelist: ' + e),
      ...StreamShared.validateDomainList(parseDomainList(document.getElementById('blacklist').value)).map(e => 'Blacklist: ' + e)
    ];
    const el = document.getElementById('domain-list-error');
    el.textContent = errors.join('\n');
    el.style.display = errors.length ? 'block' : 'none';
    return errors.length === 0;
  };
  const showPatternStatus = () => {
    const { rules, errors } = StreamShared.parseCustomPatterns(document.getElementById('custom-patterns').value);
    const el = document.getElementById('custom-patterns-status');
    if (errors.length) {
      el.textContent = errors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
      el.classList.remove('ok');
      el.style.display = 'block';
    } else if (rules.length) {
      el.textContent = `${rules.length} pattern${rules.length === 1 ? '' : 's'} OK`;
      el.classList.add('ok');
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
    return errors.length === 0;
  };
  for (const id of ['whitelist', 'blacklist']) document.getElementById(id).addEventListener('input', showListErrors);
  document.getElementById('custom-patterns').addEventListener('input', showPatternStatus);
  showPatternStatus();

  // Save lists button (invalid lines are reported and skipped, the rest is saved)
  document.getElementById('save-lists').addEventListener('click', () => {
    const whitelist = parseDomainList(document.getElementById('whitelist').value);
    const blacklist = parseDomainList(document.getElementById('blacklist').value);
    const customPatterns = document.getElementById('custom-patterns').value;
    const listsOk = showListErrors();
    const patternsOk = showPatternStatus();
    saveSettings({ whitelist, blacklist, customPatterns });

    // Visual feedback
    const btn = document.getElementById('save-lists');
    btn.textContent = listsOk && patternsOk ? '✓ Saved' : '✓ Saved (see errors)';
    btn.classList.add('saved');
    setTimeout(() => {
      btn.textContent = 'Save Lists & Patterns';
      btn.classList.remove('saved');
    }, 1500);
  });
});

// ─── Floating button position ────────────────────────────────────────────────
// content.js owns the format: { global: {side, yRatio}, sites: { host: {side, yRatio} } }

const CORNERS = {
  'bottom-right': { side: 'right', yRatio: 1 },
  'bottom-left': { side: 'left', yRatio: 1 },
  'top-right': { side: 'right', yRatio: 0 },
  'top-left': { side: 'left', yRatio: 0 }
};

function cornerName(layout) {
  if (!layout) return 'bottom-right';
  if (layout.sites && Object.keys(layout.sites).length > 0) return 'custom';
  const g = layout.global;
  if (!g) return 'bottom-right';
  return Object.keys(CORNERS).find(name => CORNERS[name].side === g.side && CORNERS[name].yRatio === g.yRatio) || 'custom';
}

async function initButtonPositionControls() {
  const select = document.getElementById('button-corner');
  const stored = await browser.storage.local.get('buttonLayout');
  select.value = cornerName(stored.buttonLayout);

  select.addEventListener('change', async () => {
    const pos = CORNERS[select.value];
    if (!pos) return;
    await browser.storage.local.set({ buttonLayout: { global: { ...pos }, sites: {} } });
  });

  document.getElementById('reset-button-position').addEventListener('click', async () => {
    await browser.storage.local.set({ buttonLayout: { global: { ...CORNERS['bottom-right'] }, sites: {} } });
    select.value = 'bottom-right';
  });
}

// ─── Stream list for the current tab ─────────────────────────────────────────

async function renderStreamList(tabId, settings, platform) {
  const list = document.getElementById('stream-list');
  list.replaceChildren();
  const res = await browser.runtime.sendMessage({ type: 'getStreams', tabId }).catch(() => null);
  const streams = (res && res.streams) || [];
  const subtitles = (res && res.subtitles) || [];
  if (streams.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'stream-empty';
    empty.textContent = 'No streams detected on this page yet.';
    list.appendChild(empty);
    return;
  }

  const isAndroid = platform === 'android';
  const chosen = new Map(); // stream.url -> variant url

  for (const stream of streams) {
    const row = document.createElement('div');
    row.className = 'stream-row';

    const info = document.createElement('div');
    info.className = 'stream-row-info';
    const name = document.createElement('span');
    name.className = 'stream-row-name';
    name.textContent = stream.displayName || stream.name;
    name.title = stream.url;
    info.appendChild(name);
    if (stream.title) {
      const sub = document.createElement('span');
      sub.className = 'stream-row-title';
      sub.textContent = stream.title;
      info.appendChild(sub);
    }

    const meta = document.createElement('div');
    meta.className = 'stream-row-meta';
    const addBadge = (cls, text) => {
      const b = document.createElement('span');
      b.className = `badge ${cls}`;
      b.textContent = text;
      meta.appendChild(b);
    };
    if (stream.quality) addBadge('quality', stream.quality);
    if (stream.duration) addBadge('duration', StreamShared.formatDuration(stream.duration));
    if (subtitles.length) addBadge('subs', `CC ${subtitles.length}`);
    if (stream.variants && stream.variants.length > 1) {
      const select = document.createElement('select');
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Auto';
      select.appendChild(auto);
      for (const v of stream.variants) {
        const o = document.createElement('option');
        o.value = v.url;
        o.textContent = v.label;
        select.appendChild(o);
      }
      select.onchange = () => select.value ? chosen.set(stream.url, select.value) : chosen.delete(stream.url);
      meta.appendChild(select);
    }
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'stream-row-actions';
    const effective = () => chosen.get(stream.url) || stream.url;
    const addButton = (label, title, handler) => {
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      btn.textContent = label;
      btn.title = title;
      btn.onclick = async () => {
        const orig = btn.textContent;
        btn.textContent = '⏳';
        const ok = await handler().catch(() => false);
        btn.textContent = ok ? '✅' : '❌';
        setTimeout(() => btn.textContent = orig, 1200);
      };
      actions.appendChild(btn);
    };
    const viaBackground = type => async () => {
      const r = await browser.runtime.sendMessage({ type, tabId, url: effective(), streamUrl: stream.url });
      return !!(r && r.success !== false);
    };

    if (isAndroid) {
      addButton('📤', 'Share / open in player', async () => {
        StreamShared.shareToAndroid(window, effective(), stream.title || stream.displayName || stream.name, settings.androidPlayer, subtitles[0] && subtitles[0].url);
        return true;
      });
    } else {
      addButton('🖥️', 'Open in External Player', viaBackground('openExternalPlayer'));
    }
    addButton('📋', 'Copy URL', async () => { await navigator.clipboard.writeText(effective()); return true; });
    addButton('▶️', 'Play in Browser', viaBackground('openWebPlayer'));
    if (settings.showDownloadIcon) {
      addButton('⬇️', 'Download as MP4', viaBackground('downloadStream'));
    }

    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// One rule per line (see StreamShared.parseDomainRule). Regex rules (~…) keep their case.
function parseDomainList(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => (/^[!\-]*~/.test(line) ? line : line.toLowerCase()));
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
