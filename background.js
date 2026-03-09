// background.js
let detectedStreams = new Map();
let pendingUpdates = new Map(); // tabId → timeout for debounced updates
let settings = {
  enabled: true,
  cleanNames: true,
  maxStreams: 50,
  whitelist: [],
  blacklist: []
};

// Load settings on startup
browser.storage.local.get('settings').then(result => {
  if (result.settings) {
    settings = { ...settings, ...result.settings };
  }
});

// Listen for settings changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

// ─── URL filtering ────────────────────────────────────────────────────────────

const SKIP_EXTENSIONS = new Set([
  '.css', '.js', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.json', '.xml', '.txt', '.html', '.htm', '.php', '.asp'
]);

const SKIP_PATTERNS = [
  'googlesyndication', 'doubleclick', 'googleadservices',
  'analytics', 'facebook.com/tr', 'pixel', 'beacon',
  'tracking', 'telemetry', '/ads/', 'pagead',
  'data:',  'blob:', 'chrome-extension:', 'moz-extension:'
];

function shouldSkipUrl(url) {
  const lower = url.toLowerCase();

  // Skip very short URLs or data/blob URIs
  if (lower.length < 20) return true;

  // Skip known non-video extensions
  const pathEnd = lower.split('?')[0];
  for (const ext of SKIP_EXTENSIONS) {
    if (pathEnd.endsWith(ext)) return true;
  }

  // Skip tracking/ad/non-media patterns
  for (const pattern of SKIP_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }

  return false;
}

// ─── Stream URL detection ─────────────────────────────────────────────────────

const VIDEO_PATTERNS = [
  '.mp4', '.m3u8', '.m3u', '.ts', '.mpd',
  '/video/', '/media/', '/stream/',
  'manifest', 'playlist', 'master.json', 'urlset'
];

function isStreamUrl(url) {
  const lower = url.toLowerCase();
  return VIDEO_PATTERNS.some(pattern => lower.includes(pattern));
}

function isStreamContent(contentType) {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('video/') ||
         lower.includes('application/x-mpegurl') ||
         lower.includes('application/vnd.apple.mpegurl') ||
         lower.includes('application/dash+xml') ||
         (lower.includes('application/octet-stream') && false); // too broad, skip
}

// ─── Quality extraction ───────────────────────────────────────────────────────

function extractQuality(url, name) {
  const qualityPatterns = [
    { regex: /[^a-z](4320p|8k)[^a-z]/i, quality: '8K' },
    { regex: /[^a-z](2160p|4k)[^a-z]/i, quality: '4K' },
    { regex: /[^a-z](1440p|2k)[^a-z]/i, quality: '1440p' },
    { regex: /[^a-z]1080p[^a-z]/i, quality: '1080p' },
    { regex: /[^a-z]720p[^a-z]/i, quality: '720p' },
    { regex: /[^a-z]480p[^a-z]/i, quality: '480p' },
    { regex: /[^a-z]360p[^a-z]/i, quality: '360p' },
    { regex: /[^a-z]240p[^a-z]/i, quality: '240p' },
    { regex: /[^a-z]144p[^a-z]/i, quality: '144p' }
  ];

  const testString = ` ${url} ${name} `;
  for (const pattern of qualityPatterns) {
    if (pattern.regex.test(testString)) {
      return pattern.quality;
    }
  }
  return null;
}

// ─── Name cleaning ────────────────────────────────────────────────────────────

function cleanStreamName(url) {
  try {
    // Get last path segment, strip query/hash
    let name = decodeURIComponent(url.split('/').pop().split('?')[0].split('#')[0]);

    // Remove common file extensions for display
    name = name.replace(/\.(m3u8|m3u|mp4|ts|mpd|f4m|ism)$/i, '');

    // Replace dashes, underscores, dots with spaces
    name = name.replace(/[-_.]+/g, ' ');

    // Title case
    name = name.replace(/\b\w/g, c => c.toUpperCase()).trim();

    // If result is empty or too short, use a generic name
    if (name.length < 2) name = 'Stream';

    return name;
  } catch (e) {
    return 'Stream';
  }
}

function getStreamType(url, contentType) {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('.m3u') ||
      (contentType && contentType.includes('mpegurl'))) return 'm3u8';
  if (lower.includes('.mpd') ||
      (contentType && contentType.includes('dash'))) return 'mpd';
  if (lower.includes('.mp4')) return 'mp4';
  if (lower.includes('.ts')) return 'ts';
  return 'video';
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isDomainAllowed(domain) {
  if (!domain) return settings.enabled;

  // Whitelist overrides blacklist
  if (settings.whitelist.length > 0 && settings.whitelist.some(d => domain.includes(d))) {
    return true;
  }

  // Blacklist blocks
  if (settings.blacklist.some(d => domain.includes(d))) return false;

  return true;
}

// ─── Debounced stream notification ────────────────────────────────────────────

function notifyContentScript(tabId) {
  // Debounce: wait 500ms before sending, to batch rapid detections
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
  }

  pendingUpdates.set(tabId, setTimeout(() => {
    pendingUpdates.delete(tabId);
    const streams = detectedStreams.get(tabId);
    if (!streams || streams.length === 0) return;

    browser.tabs.sendMessage(tabId, {
      type: "streamDetected",
      streams: streams
    }).catch(() => {}); // Tab might be closed
  }, 500));
}

// ─── Add a stream to a tab ───────────────────────────────────────────────────

async function addStream(tabId, url, contentType) {
  if (!settings.enabled) return;

  let streams = detectedStreams.get(tabId) || [];

  // Cap check
  if (streams.length >= settings.maxStreams) return;

  // Dedup check
  if (streams.some(s => s.url === url)) return;

  // Get page title for context
  let pageTitle = '';
  try {
    const tab = await browser.tabs.get(tabId);
    pageTitle = tab.title || '';

    // Check domain allowance
    if (!isDomainAllowed(getDomain(tab.url))) return;
  } catch { /* tab may not exist */ }

  const streamType = getStreamType(url, contentType);
  const quality = extractQuality(url, '');
  const rawName = url.split('/').pop().split('?')[0];

  let displayName;
  if (settings.cleanNames) {
    displayName = cleanStreamName(url);
    // Append type
    displayName += ` (${streamType})`;
  } else {
    displayName = rawName;
  }

  // Number duplicates
  const dupeCount = streams.filter(s => s.displayName === displayName).length;
  if (dupeCount > 0) {
    displayName += ` #${dupeCount + 1}`;
  }

  streams.push({
    url,
    name: rawName,
    displayName,
    type: streamType,
    quality,
    pageTitle: truncateText(pageTitle, 60)
  });

  detectedStreams.set(tabId, streams);
  notifyContentScript(tabId);
}

// ─── Extract video sources from page DOM ──────────────────────────────────────

function extractVideoSources(tabId) {
  browser.tabs.executeScript(tabId, {
    code: `
      (function() {
        let sources = [];
        document.querySelectorAll('video').forEach(video => {
          if (video.src && video.src.startsWith('http')) {
            sources.push(video.src);
          }
          video.querySelectorAll('source').forEach(source => {
            if (source.src && source.src.startsWith('http')) {
              sources.push(source.src);
            }
          });
        });
        document.querySelectorAll('[data-source]').forEach(el => {
          const src = el.getAttribute('data-source');
          if (src && src.startsWith('http')) {
            sources.push(src);
          }
        });
        return sources;
      })();
    `
  }).then(results => {
    if (!results?.[0]) return;
    for (const url of results[0]) {
      if (!shouldSkipUrl(url) && isStreamUrl(url)) {
        addStream(tabId, url, '');
      }
    }
  }).catch(() => {});
}

// ─── Handle stream downloads ─────────────────────────────────────────────────

async function handleStreamDownload(url, suggestedFilename) {
  try {
    if (url.includes('.m3u8')) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: '/icons/icon48.png',
        title: 'M3U8 Stream Detected',
        message: 'M3U8 streams require a specialized downloader. The URL has been copied to your clipboard.'
      });
      await navigator.clipboard.writeText(url);
      return;
    }

    let filename = suggestedFilename;
    if (!filename.includes('.')) {
      filename += '.mp4';
    }

    await browser.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    });
  } catch (error) {
    console.error('Download error:', error);
    browser.notifications.create({
      type: 'basic',
      iconUrl: '/icons/icon48.png',
      title: 'Download Error',
      message: 'Failed to initiate download. Please try again.'
    });
  }
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'initiateDownload') {
    handleStreamDownload(message.url, message.filename);
  } else if (message.type === 'videoSourcesFound' && sender.tab) {
    // From content script MutationObserver
    const tabId = sender.tab.id;
    for (const url of (message.sources || [])) {
      if (!shouldSkipUrl(url) && isStreamUrl(url)) {
        addStream(tabId, url, '');
      }
    }
  } else if (message.type === 'getStreams') {
    const tabId = message.tabId;
    sendResponse({ streams: detectedStreams.get(tabId) || [] });
  } else if (message.type === 'getSettings') {
    sendResponse({ settings });
  } else if (message.type === 'updateSettings') {
    settings = { ...settings, ...message.settings };
    browser.storage.local.set({ settings });
  } else if (message.type === 'getStreamCount') {
    const tabId = message.tabId;
    const streams = detectedStreams.get(tabId) || [];
    sendResponse({ count: streams.length });
  }
  return true;
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedStreams.delete(tabId);
    // Clear pending debounce
    if (pendingUpdates.has(tabId)) {
      clearTimeout(pendingUpdates.get(tabId));
      pendingUpdates.delete(tabId);
    }
  } else if (changeInfo.status === 'complete') {
    extractVideoSources(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  detectedStreams.delete(tabId);
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
    pendingUpdates.delete(tabId);
  }
});

// ─── Web request listener (headers only, no re-fetching) ──────────────────────

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!settings.enabled) return;
    if (details.tabId < 0) return; // No tab context

    const url = details.url;
    if (shouldSkipUrl(url)) return;

    const contentType = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';

    if (isStreamUrl(url) || isStreamContent(contentType)) {
      addStream(details.tabId, url, contentType);
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "object", "other"]
  },
  ["responseHeaders"]
);

// One-time scan when tab is activated (no interval)
browser.tabs.onActivated.addListener(({ tabId }) => {
  if (settings.enabled) {
    extractVideoSources(tabId);
  }
});
