// background.js
if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}
// Chromium runs this file as a classic service worker and has to load shared.js itself;
// Firefox lists shared.js before background.js in manifest.firefox.json.
if (typeof importScripts === 'function') {
  importScripts('shared.js');
}

const NATIVE_HOST = 'stream_player_host';

let detectedStreams = new Map();   // tabId -> [stream]
let detectedSubtitles = new Map(); // tabId -> [{ url, label, lang }]
let storageReady = browser.storage.local.get(['detectedStreams', 'detectedSubtitles']).then(result => {
  if (result.detectedStreams) {
    detectedStreams = new Map(result.detectedStreams);
  }
  if (result.detectedSubtitles) {
    detectedSubtitles = new Map(result.detectedSubtitles);
  }
});

browser.runtime.onStartup.addListener(() => {
  browser.storage.local.remove(['detectedStreams', 'detectedSubtitles']);
  detectedStreams.clear();
  detectedSubtitles.clear();
});

function saveStreams() {
  browser.storage.local.set({
    detectedStreams: Array.from(detectedStreams.entries()),
    detectedSubtitles: Array.from(detectedSubtitles.entries())
  }).catch(() => {});
}

// Mutations of a tab's stream list are serialised so concurrent detections
// (each of which awaits) can never overwrite each other.
const tabQueues = new Map();
function runExclusive(tabId, task) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  tabQueues.set(tabId, next);
  next.catch(() => {}).then(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
  return next;
}

let pendingUpdates = new Map(); // tabId → timeout for debounced updates
let currentPlatform = 'win';
let platformReady = browser.runtime.getPlatformInfo().then(info => {
  currentPlatform = info.os;
});

// Log our extension ID so users can copy it for native messaging setup
console.log('[StreamPlayer] Extension ID:', browser.runtime.id);

let settings = {
  enabled: true,
  cleanNames: true,
  maxStreams: 50,
  whitelist: [],
  blacklist: [],
  showCopyIcon: true,
  showPlayIcon: true,
  showDownloadIcon: true,
  defaultTapAction: 'default', // 'default' will map to 'share' on Android, 'copy' on Desktop
  webPlayerEngine: 'vidstack',
  desktopExternalMethod: 'native',
  desktopProtocol: 'vlc://',
  protocolUrlFormat: 'encoded', // 'encoded' | 'raw' (see docs/PROTOCOL_HANDLER.md)
  externalPlayerPath: '',
  nativeArgsTemplate: '',
  downloadDir: '',
  forwardCookies: false,
  androidPlayer: 'auto',
  buttonVisibility: 'always', // floating button: 'always' | 'fade' | 'never'
  vlcHttpPassword: '',
  customPatterns: '', // lines of `type /regex/flags`, see StreamShared.parseCustomPatterns
  openStreamLinks: false, // navigating to a .m3u8 / .mpd URL opens it in the web player
  openMp4Links: false,    // … and .mp4 too (off by default: it would stop plain .mp4 downloads)
  fastBuffering: true,    // built-in players: parallel segment downloads + deeper buffer (src/prefetch.mjs)
  fastBufferingParallel: 4,
  bufferAheadSeconds: 0,  // 0 = automatic (120 s desktop, 60 s phone)
  cacheWholeVideo: true,  // built-in players: download the whole video while watching (src/stream-cache.mjs)
  cacheLimitGB: 0,        // 0 = automatic (8 GB desktop, 3 GB phone)
  downloadMethod: 'browser' // ⬇️: 'browser' = built-in MP4 downloader (download.html), 'native' = yt-dlp/ffmpeg via the native host
};

// Load settings on startup
let settingsReady = browser.storage.local.get('settings').then(result => {
  if (result.settings) {
    // 1.6 migration: before the built-in downloader, a visible ⬇️ meant yt-dlp/ffmpeg through the
    // native host. Users who had switched it on keep that; everyone else gets the built-in one.
    if (result.settings.downloadMethod === undefined && result.settings.showDownloadIcon === true) {
      result.settings.downloadMethod = 'native';
      browser.storage.local.set({ settings: { ...result.settings } }).catch(() => {});
    }
    settings = { ...settings, ...result.settings };
  }
});

// Listen for settings changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const cleanNamesBefore = settings.cleanNames;
    settings = { ...settings, ...changes.settings.newValue };
    syncLinkRedirectRules();
    if (settings.cleanNames !== cleanNamesBefore) renameAllStreams().catch(() => {});
  }
});

// ─── Direct stream links → web player ────────────────────────────────────────
// Idea from FastStream (setupRedirectRule): a declarativeNetRequest rule redirects top-level
// navigations to a stream file into our player. Differences: only the URL *path* is matched
// (FastStream's pattern also fires for "page.html?next=a.m3u8"), DASH always goes to the
// Shaka page, and the chosen engine is used for HLS/MP4.

const LINK_RULE_IDS = { streams: 1001, dash: 1002, mp4: 1003 };

// The player page of an engine setting, and the page for DASH (Vidstack cannot play it: Shaka)
const ENGINE_PAGES = { vidstack: 'player.html', shaka: 'player-shaka.html', artplayer: 'player-art.html' };
function enginePageFor(engine) {
  return ENGINE_PAGES[engine] || ENGINE_PAGES.vidstack;
}
function dashPageFor(engine) {
  return engine === 'artplayer' ? 'player-art.html' : 'player-shaka.html';
}

// Pure: rules for the given settings. `pageUrl(name)` returns the extension URL of a page.
function buildLinkRedirectRules(s, pageUrl) {
  const enginePage = enginePageFor(s.webPlayerEngine);
  const rule = (id, extensions, page) => ({
    id,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${pageUrl(page)}#\\0` } },
    condition: {
      // scheme://host/path.ext with an optional query or fragment; the extension must end the path
      regexFilter: `^https?://[^?#]*\\.(?:${extensions})(?:[?#].*)?$`,
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame']
    }
  });
  const rules = [];
  if (s.openStreamLinks) {
    rules.push(rule(LINK_RULE_IDS.streams, 'm3u8|m3u', enginePage));
    rules.push(rule(LINK_RULE_IDS.dash, 'mpd', dashPageFor(s.webPlayerEngine)));
  }
  if (s.openMp4Links) rules.push(rule(LINK_RULE_IDS.mp4, 'mp4|m4v', enginePage));
  return rules;
}

let linkRulesSync = Promise.resolve();
function syncLinkRedirectRules() {
  if (!browser.declarativeNetRequest || !browser.declarativeNetRequest.updateDynamicRules) return linkRulesSync;
  linkRulesSync = linkRulesSync.catch(() => {}).then(async () => {
    await settingsReady;
    const addRules = buildLinkRedirectRules(settings, page => browser.runtime.getURL(page));
    try {
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Object.values(LINK_RULE_IDS), addRules });
    } catch (e) {
      console.warn('[StreamPlayer] Could not update the stream-link rules:', e);
    }
  });
  return linkRulesSync;
}
syncLinkRedirectRules();

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
  'data:', 'blob:', 'chrome-extension:', 'moz-extension:'
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

// '.ts' stays in this list on purpose: some sites serve a bare .ts stream.
// Segments that belong to a detected playlist are hidden by isSegmentOf().
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
    lower.includes('application/dash+xml');
}

const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.ass', '.ssa'];

function isSubtitleUrl(url, contentType) {
  const path = url.toLowerCase().split('?')[0].split('#')[0];
  if (SUBTITLE_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  const ct = (contentType || '').toLowerCase();
  return ct.includes('text/vtt') || ct.includes('application/x-subrip');
}

// A stream URL carried inside a query parameter, e.g. https://proxy.example/get.php?u=https%3A%2F%2Fcdn%2Fa.m3u8.
// Returns the inner URL, or ''. (URLSearchParams has already percent-decoded the values.)
const EMBEDDED_STREAM_RE = /^https?:\/\/[^\s]+?\.(m3u8|mpd|mp4)(?:[?#&].*)?$/i;
function embeddedStreamUrl(url) {
  try {
    for (const value of new URL(url).searchParams.values()) {
      if (EMBEDDED_STREAM_RE.test(value)) return value;
    }
  } catch { /* not a URL */ }
  return '';
}

function typeFromExtension(url) {
  const m = /\.(m3u8|mpd|mp4)(?:[?#&]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// Decides what a URL is. Returns { kind: 'stream', type } | { kind: 'subtitle' } | null.
// `resourceType` is the webRequest type ('media', 'xmlhttprequest', …) when known.
// Order matters: the user's custom patterns win over every built-in filter, then a stream
// URL embedded in a query string (which the extension filter below would otherwise reject,
// e.g. /proxy.php?u=…m3u8), then the built-in skip list, subtitles, and finally streams.
function classifyUrl(url, contentType, resourceType) {
  if (!/^https?:/i.test(url)) return null;

  const custom = StreamShared.matchCustomPattern(settings.customPatterns, url);
  if (custom) return custom === 'subtitle' ? { kind: 'subtitle' } : { kind: 'stream', type: custom };

  const lower = url.toLowerCase();
  const inner = SKIP_PATTERNS.some(p => lower.includes(p)) ? '' : embeddedStreamUrl(url);
  if (inner) return { kind: 'stream', type: typeFromExtension(inner) };

  if (shouldSkipUrl(url)) return null;
  if (isSubtitleUrl(url, contentType)) return { kind: 'subtitle' };
  if (isStreamUrl(url) || isStreamContent(contentType)) return { kind: 'stream', type: null };

  // Browsers tag the requests behind a <video>/<audio> element as "media": a stream even
  // when the URL says nothing about it (https://cdn.example/get?id=42). Audio is not.
  if (resourceType === 'media' && !/^audio\//i.test(contentType || '')) return { kind: 'stream', type: null };
  return null;
}

// Client errors, server errors and empty responses are not streams. 206 (range) is.
function isUsableStatus(statusCode) {
  if (!statusCode) return true;
  return !(statusCode >= 400 || statusCode === 204);
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

function heightLabel(height) {
  if (!height) return null;
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return `${height}p`;
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
  if (lower.includes('.mp4') || (contentType && /video\/mp4/i.test(contentType))) return 'mp4';
  if (lower.includes('.ts')) return 'ts';
  return 'video';
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? '' : o;
  } catch {
    return '';
  }
}

// ─── HLS segment detection ────────────────────────────────────────────────────

function dirOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  } catch {
    return '';
  }
}

function stemOf(url) {
  try {
    return new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

// True when `segUrl` looks like a media segment of the playlist `stream`.
function isSegmentOf(segUrl, stream) {
  if (stream.segmentDir && segUrl.startsWith(stream.segmentDir)) return true;
  // e.g. Ep1.v190_index0.ts  <->  Ep1.v190_index.m3u8
  const segStem = stemOf(segUrl).replace(/\d+$/, '');
  if (segStem.length > 2 && segStem === stemOf(stream.url)) return true;
  // Same directory (or deeper) as a playlist that is not at the site root
  const plDir = dirOf(stream.url);
  try {
    return new URL(plDir).pathname !== '/' && segUrl.startsWith(plDir);
  } catch {
    return false;
  }
}

// ─── Playlist analysis (duration, real quality, variants) ─────────────────────

// The background's own request for a playlist must look like the page's: many CDNs refuse a
// request without the page's Referer/Origin (hotlink protection), and then no duration, quality
// or variant list is shown. A session rule gives exactly this URL, requested from outside any tab
// (tabId -1: our background), the headers captured from the page; it is removed right after.
const ANALYSIS_RULE_BASE = 1900000000; // far above the player rules (tabId + 1) and 1001-1003
let analysisRuleSeq = 0;

async function addAnalysisRule(url, headers) {
  if (!headers || !browser.declarativeNetRequest || !browser.declarativeNetRequest.updateSessionRules) return 0;
  const requestHeaders = playerHeaderRuleHeaders({
    referer: headers.referer || '',
    origin: headers.origin || originOf(headers.referer || ''),
    cookie: settings.forwardCookies ? (headers.cookie || '') : ''
  });
  // urlFilter treats | * ^ as syntax, and only takes ASCII
  if (!requestHeaders.length || /[|*^]/.test(url) || /[^\x21-\x7e]/.test(url)) return 0;
  const id = ANALYSIS_RULE_BASE + (analysisRuleSeq++ % 1000000);
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 2,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: { urlFilter: `|${url}|`, tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] }
      }]
    });
    return id;
  } catch {
    return 0;
  }
}

async function fetchText(url, headers = null) {
  const ruleId = await addAnalysisRule(url, headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.text()).slice(0, 2000000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (ruleId) browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function resolveUrl(ref, base) {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const result = { isMaster: false, variants: [], duration: 0, segmentDir: null };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      result.isMaster = true;
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j < lines.length) {
        const res = /(\d+)x(\d+)/.exec(attrs.RESOLUTION || '');
        result.variants.push({
          url: resolveUrl(lines[j].trim(), baseUrl),
          bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
          height: res ? parseInt(res[2], 10) : 0,
          codecs: attrs.CODECS || ''
        });
      }
    } else if (line.startsWith('#EXTINF:')) {
      result.duration += parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line && !line.startsWith('#') && !result.isMaster && !result.segmentDir) {
      result.segmentDir = dirOf(resolveUrl(line, baseUrl));
    }
  }
  return result;
}

function parseMpd(text) {
  let maxHeight = 0;
  const re = /<Representation\b[^>]*>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const h = /\bheight="(\d+)"/.exec(m[0]);
    if (h) maxHeight = Math.max(maxHeight, parseInt(h[1], 10));
  }
  let duration = 0;
  const d = text.match(/mediaPresentationDuration="PT([^"]+)"/);
  if (d) {
    const hMatch = d[1].match(/([\d.]+)H/);
    const mMatch = d[1].match(/([\d.]+)M/);
    const sMatch = d[1].match(/([\d.]+)S/);
    if (hMatch) duration += parseFloat(hMatch[1]) * 3600;
    if (mMatch) duration += parseFloat(mMatch[1]) * 60;
    if (sMatch) duration += parseFloat(sMatch[1]);
  }
  return { maxHeight, duration };
}

// Analysis attempts per stream ("tabId|url"): a failed fetch is tried again a few times (after
// a delay, or when the page requests the playlist again), as the 1.4 release effectively did by
// fetching on every detection.
const analysisState = new Map();
const ANALYSIS_ATTEMPTS = 3;

function scheduleAnalysis(tabId, url, type, headers, delay = 0) {
  const key = `${tabId}|${url}`;
  const st = analysisState.get(key) || { running: false, attempts: 0, done: false, timer: null };
  analysisState.set(key, st);
  if (st.running || st.done || st.attempts >= ANALYSIS_ATTEMPTS) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const run = async () => {
    st.timer = null;
    if (st.running || st.done) return;
    st.running = true;
    st.attempts++;
    let ok = false;
    try {
      ok = await analyzeStream(tabId, url, type, headers);
    } catch { /* treated as a failed attempt */ }
    st.running = false;
    if (ok) st.done = true;
    else if (st.attempts < ANALYSIS_ATTEMPTS) st.timer = setTimeout(run, 3000 * st.attempts);
  };
  if (delay) st.timer = setTimeout(run, delay);
  else run();
}

function forgetAnalyses(tabId) {
  for (const [key, st] of analysisState) {
    if (key.startsWith(`${tabId}|`)) {
      if (st.timer) clearTimeout(st.timer);
      analysisState.delete(key);
    }
  }
}

// Fetches and parses a playlist, then merges the findings into the stored stream.
// Returns false when the playlist could not be fetched (worth another try).
async function analyzeStream(tabId, url, type, headers = null) {
  const info = {};
  if (type === 'm3u8') {
    const text = await fetchText(url, headers);
    if (!text) return false;
    const parsed = parseM3u8(text, url);
    if (parsed.isMaster) {
      const byHeight = new Map();
      for (const v of parsed.variants) {
        const key = v.height || `bw${v.bandwidth}`;
        const prev = byHeight.get(key);
        if (!prev || v.bandwidth > prev.bandwidth) byHeight.set(key, v);
      }
      info.variants = [...byHeight.values()]
        .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))
        .map(v => ({
          url: v.url,
          bandwidth: v.bandwidth,
          height: v.height,
          label: heightLabel(v.height) || `${Math.round(v.bandwidth / 1000)}k`
        }));
      info.quality = heightLabel(Math.max(0, ...parsed.variants.map(v => v.height)));
      // Duration from a media playlist: the first variant, else the next ones (one may be refused)
      for (const variant of parsed.variants.slice(0, 3)) {
        const mediaText = await fetchText(variant.url, headers);
        if (!mediaText) continue;
        const media = parseM3u8(mediaText, variant.url);
        info.duration = media.duration;
        info.segmentDir = media.segmentDir;
        break;
      }
    } else {
      info.duration = parsed.duration;
      info.segmentDir = parsed.segmentDir;
    }
  } else if (type === 'mpd') {
    const text = await fetchText(url, headers);
    if (!text) return false;
    const parsed = parseMpd(text);
    info.duration = parsed.duration;
    info.quality = heightLabel(parsed.maxHeight);
  } else {
    return true;
  }

  await runExclusive(tabId, async () => {
    await storageReady;
    let streams = detectedStreams.get(tabId);
    const stream = streams && streams.find(s => s.url === url);
    if (!stream) return;
    if (info.duration > 0 && isFinite(info.duration)) stream.duration = info.duration;
    if (info.quality) stream.quality = info.quality;
    if (info.variants && info.variants.length > 0) stream.variants = info.variants;
    if (info.segmentDir) {
      stream.segmentDir = info.segmentDir;
      streams = streams.filter(s => !(s.type === 'ts' && isSegmentOf(s.url, stream)));
      detectedStreams.set(tabId, streams);
    }
    saveStreams();
    updateBadge(tabId);
    notifyContentScript(tabId);
  });
  return true;
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
  if (StreamShared.matchesDomainList(domain, settings.whitelist)) return true;

  // Blacklist blocks
  if (StreamShared.matchesDomainList(domain, settings.blacklist)) return false;

  return true;
}

// ─── Toolbar badge ────────────────────────────────────────────────────────────

try {
  browser.action.setBadgeBackgroundColor({ color: '#4CAF50' });
} catch { /* badge is cosmetic */ }

function updateBadge(tabId) {
  const count = (detectedStreams.get(tabId) || []).length;
  try {
    browser.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
  } catch { /* tab may be gone */ }
}

// ─── Debounced stream notification ────────────────────────────────────────────

function notifyContentScript(tabId) {
  // Debounce: wait 500ms before sending, to batch rapid detections
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
  }

  pendingUpdates.set(tabId, setTimeout(async () => {
    pendingUpdates.delete(tabId);
    await storageReady;
    const streams = detectedStreams.get(tabId);
    if (!streams || streams.length === 0) return;

    browser.tabs.sendMessage(tabId, {
      type: "streamDetected",
      streams: streams,
      subtitles: detectedSubtitles.get(tabId) || []
    }).catch(() => { }); // Tab might be closed
  }, 500));
}

// ─── Request header capture (Referer / Origin / User-Agent / Cookie) ─────────

const requestHeadersById = new Map(); // requestId -> headers, bounded
const WEB_REQUEST_TYPES = ["media", "xmlhttprequest", "object", "other"];

function rememberRequestHeaders(details) {
  const h = {};
  for (const { name, value } of details.requestHeaders || []) {
    switch (name.toLowerCase()) {
      case 'referer': h.referer = value; break;
      case 'origin': h.origin = value; break;
      case 'user-agent': h.userAgent = value; break;
      case 'cookie': h.cookie = value; break;
    }
  }
  requestHeadersById.set(details.requestId, h);
  if (requestHeadersById.size > 400) {
    requestHeadersById.delete(requestHeadersById.keys().next().value);
  }
}

{
  const filter = { urls: ["<all_urls>"], types: WEB_REQUEST_TYPES };
  try {
    // Chromium hides Referer/Cookie/Origin unless 'extraHeaders' is requested.
    browser.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, filter, ['requestHeaders', 'extraHeaders']);
  } catch {
    // Firefox rejects 'extraHeaders' and already exposes every header.
    browser.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, filter, ['requestHeaders']);
  }
  // Failed requests never reach onHeadersReceived; forget their headers too
  browser.webRequest.onErrorOccurred.addListener(d => requestHeadersById.delete(d.requestId), filter);
}

// Requests made by a page's service worker carry tabId -1. Attribute them to a tab showing
// that origin (the active one first), as FastStream does with the request initiator.
// Requests of our own extension (initiator chrome-/moz-extension://) match no web tab.
async function tabForWorkerRequest(details) {
  const initiator = details.initiator || originOf(details.documentUrl || details.originUrl || '');
  if (!initiator || !/^https?:/i.test(initiator)) return null;
  try {
    const tabs = await browser.tabs.query({});
    const matching = tabs.filter(t => originOf(t.url || '') === initiator);
    if (matching.length === 0) return null;
    return (matching.find(t => t.active) || matching[0]).id;
  } catch {
    return null;
  }
}

// ─── Add a stream to a tab ───────────────────────────────────────────────────

// "Index (m3u8)" with "Clean names" on, else the file name
function baseDisplayName(url, type) {
  return settings.cleanNames ? `${cleanStreamName(url)} (${type})` : url.split('/').pop().split('?')[0];
}

// Numbers a name that is already in the list: "Index (m3u8) #2"
function numberedName(name, others) {
  const dupes = others.filter(s => s.displayName === name || (s.displayName || '').startsWith(`${name} #`)).length;
  return dupes > 0 ? `${name} #${dupes + 1}` : name;
}

// "Clean names" switched: rename the streams already listed, so open pages update at once
async function renameAllStreams() {
  await storageReady;
  for (const tabId of [...detectedStreams.keys()]) {
    await runExclusive(tabId, async () => {
      const streams = detectedStreams.get(tabId) || [];
      const renamed = [];
      for (const s of streams) {
        s.displayName = numberedName(baseDisplayName(s.url, s.type), renamed);
        renamed.push(s);
      }
      notifyContentScript(tabId);
    });
  }
  saveStreams();
}

function addStream(tabId, url, contentType, duration = null, reqHeaders = null, typeHint = null) {
  return runExclusive(tabId, () => addStreamLocked(tabId, url, contentType, duration, reqHeaders, typeHint));
}

// Tabs we opened for the built-in player. While such a tab is still about:blank its
// own requests would otherwise look like a regular page's streams.
const playerTabs = new Set();

async function addStreamLocked(tabId, url, contentType, duration, reqHeaders, typeHint) {
  if (playerTabs.has(tabId)) return;
  await settingsReady;
  if (!settings.enabled) return;

  await storageReady;

  // Get page info for context (awaited before the list is read, so the read
  // below always sees the freshest state)
  let pageTitle = '';
  let pageUrl = '';
  try {
    const tab = await browser.tabs.get(tabId);
    pageTitle = tab.title || '';
    pageUrl = tab.url || '';
    if (/^(chrome|moz)-extension:/.test(pageUrl)) return; // our own player pages
    if (!isDomainAllowed(getDomain(pageUrl))) return;
  } catch { /* tab may not exist */ }

  let streams = detectedStreams.get(tabId) || [];

  // Cap check
  if (streams.length >= settings.maxStreams) return;

  // Dedup check
  let existing = streams.find(s => s.url === url);
  if (existing) {
    if (duration > 0 && isFinite(duration) && !existing.duration) {
      existing.duration = duration;
      saveStreams();
      notifyContentScript(tabId);
    }
    // Requested again and still no duration: another chance for an analysis that failed
    if (!existing.duration && (existing.type === 'm3u8' || existing.type === 'mpd')) {
      scheduleAnalysis(tabId, url, existing.type, existing.headers);
    }
    return;
  }

  const streamType = typeHint || getStreamType(url, contentType);

  // Hide media segments that belong to a playlist we already know about
  if (streamType === 'ts' && streams.some(s => s.type === 'm3u8' && isSegmentOf(url, s))) return;

  const quality = extractQuality(url, '');
  const rawName = url.split('/').pop().split('?')[0];

  const displayName = numberedName(baseDisplayName(url, streamType), streams);

  const req = reqHeaders || {};
  const headers = {
    referer: req.referer || (pageUrl.startsWith('http') ? pageUrl : ''),
    origin: req.origin || '',
    userAgent: req.userAgent || navigator.userAgent
  };
  if (settings.forwardCookies && req.cookie) headers.cookie = req.cookie;

  const stream = {
    url,
    name: rawName,
    displayName,
    type: streamType,
    quality,
    duration: duration > 0 && isFinite(duration) ? duration : null,
    pageTitle: truncateText(pageTitle, 60),
    // Cleaned page title ("Dark Matter S01E05"): used for the list, player titles and file names
    title: StreamShared.cleanPageTitle(pageTitle, getDomain(pageUrl)).title,
    pageUrl: stripHash(pageUrl),
    headers
  };
  if (streamType === 'm3u8') {
    // Segments that arrived before their playlist are no longer interesting
    streams = streams.filter(s => !(s.type === 'ts' && isSegmentOf(s.url, stream)));
  }
  streams.push(stream);

  detectedStreams.set(tabId, streams);
  saveStreams();
  updateBadge(tabId);
  notifyContentScript(tabId);

  // Duration / real quality / variants arrive later without blocking detection
  if (streamType === 'm3u8' || streamType === 'mpd') {
    scheduleAnalysis(tabId, url, streamType, headers);
  }
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

function addSubtitle(tabId, url, label = '', lang = '') {
  return runExclusive(tabId, async () => {
    await settingsReady;
    if (!settings.enabled) return;
    await storageReady;
    const subs = detectedSubtitles.get(tabId) || [];
    if (subs.length >= 20 || subs.some(s => s.url === url)) return;
    // Language and a readable label from the <track>, the file name or a ?lang= parameter
    const d = StreamShared.describeSubtitle(url, label, lang);
    let finalLabel = d.label;
    for (let n = 2; subs.some(s => s.label === finalLabel); n++) finalLabel = `${d.label} ${n}`;
    subs.push({ url, label: finalLabel, lang: d.lang });
    detectedSubtitles.set(tabId, subs);
    saveStreams();
    notifyContentScript(tabId);
  });
}

// ─── Extract video sources from page DOM ──────────────────────────────────────

// Scans the DOM of every frame (embedded players usually live in a cross-origin iframe, where
// the content script UI does not run). What a sub-frame finds gets that frame's URL as Referer.
function extractVideoSources(tabId) {
  browser.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    func: () => {
      let sources = [];
      let tracks = [];
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
      return { href: location.href, sources, tracks };
    }
  }).then(async results => {
    if (!results || results.length === 0) return;
    const top = results.find(r => r.frameId === 0) || results[0];
    if (!top || !top.result) return;
    // The tab may have navigated while the script was running; that page was cleared already
    const tab = await browser.tabs.get(tabId);
    if (stripHash(tab.url) !== stripHash(top.result.href) || isStaleDocument(tabId, top.result.href)) return;
    for (const r of results) {
      if (!r || !r.result) continue;
      const frameHeaders = r === top ? null : { referer: r.result.href, origin: originOf(r.result.href) };
      ingestDomSources(tabId, r.result.sources, r.result.tracks, [], frameHeaders);
    }
  }).catch(() => {});
}

function stripHash(url) {
  return (url || '').split('#')[0];
}

// Top-level navigations in flight: tabId -> { url, time }. Between the moment a
// navigation starts and the moment its page loads, the OLD document can still
// report what it found; those reports must not re-add the streams we just cleared.
const pendingNav = new Map();
const PENDING_NAV_TIMEOUT = 5000;

function isStaleDocument(tabId, docUrl) {
  const pending = pendingNav.get(tabId);
  if (!pending) return false;
  if (Date.now() - pending.time > PENDING_NAV_TIMEOUT) {
    pendingNav.delete(tabId);
    return false;
  }
  return stripHash(docUrl) !== stripHash(pending.url);
}

// `frameHeaders` ({referer, origin}) is set for sources found inside a sub-frame.
function ingestDomSources(tabId, sources = [], tracks = [], resources = [], frameHeaders = null) {
  for (const item of sources) {
    const url = typeof item === 'string' ? item : item.url;
    const duration = typeof item === 'string' ? null : item.duration;
    const found = classifyUrl(url, '', '');
    if (found && found.kind === 'stream') {
      addStream(tabId, url, '', duration, frameHeaders, found.type);
    }
  }
  for (const track of tracks) {
    addSubtitle(tabId, track.url, track.label, track.lang);
  }
  // URLs the page already requested (resource timing); duplicates are dropped by addStream/addSubtitle
  for (const url of resources) {
    const found = classifyUrl(url, '', '');
    if (!found) continue;
    if (found.kind === 'subtitle') addSubtitle(tabId, url);
    else addStream(tabId, url, '', null, null, found.type);
  }
}

// ─── Notifications ───────────────────────────────────────────────────────────

function notify(message) {
  try {
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon128.png'),
      title: 'Stream to Player',
      message: String(message).slice(0, 250)
    }).catch(() => {});
  } catch { /* notifications unavailable */ }
}

// ─── Action context (stream + headers + subtitles for one URL) ───────────────

async function buildContext(tabId, url, streamUrl) {
  await Promise.all([storageReady, settingsReady]);
  const streams = detectedStreams.get(tabId) || [];
  const stream = streams.find(s => s.url === (streamUrl || url)) || streams.find(s => s.url === url) || null;
  let pageUrl = '';
  try {
    pageUrl = (await browser.tabs.get(tabId)).url || '';
  } catch { /* tab gone */ }
  const h = (stream && stream.headers) || {};
  const referer = h.referer || (pageUrl.startsWith('http') ? pageUrl : '');
  return {
    tabId,
    url,
    stream,
    title: (stream && (stream.title || stream.pageTitle || stream.displayName)) || '',
    referer,
    origin: h.origin || originOf(referer),
    ua: h.userAgent || navigator.userAgent,
    cookie: settings.forwardCookies ? (h.cookie || '') : '',
    subtitles: detectedSubtitles.get(tabId) || []
  };
}

// ─── Web player (with Referer/Origin rewrite) ────────────────────────────────

// One session rule per player tab (id tabId+1) that makes the player's requests look like the
// page's: Referer, Origin and, when "Forward cookies" is on, Cookie (the player page is another
// origin, so the browser would not send the CDN's cookies by itself).
// It is scoped to the tab rather than to URLs on purpose: FastStream sets a 5-second rule per URL
// because its own downloader announces every request; hls.js and Shaka fetch playlists and
// segments themselves, often from other hosts, so a URL list cannot be known in advance.
// The rule is removed when the tab closes or navigates away from the player (removePlayerHeaderRule).
function playerHeaderRuleHeaders(ctx) {
  const headers = [];
  if (ctx.referer) headers.push({ header: 'Referer', operation: 'set', value: ctx.referer });
  if (ctx.origin) headers.push({ header: 'Origin', operation: 'set', value: ctx.origin });
  if (ctx.cookie) headers.push({ header: 'Cookie', operation: 'set', value: ctx.cookie });
  return headers;
}

function removePlayerHeaderRule(tabId) {
  if (!browser.declarativeNetRequest) return Promise.resolve();
  return browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId + 1] }).catch(() => {});
}

async function setPlayerHeaderRule(tabId, ctx) {
  const requestHeaders = playerHeaderRuleHeaders(ctx);
  if (!browser.declarativeNetRequest || requestHeaders.length === 0) return;
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId + 1],
    addRules: [{
      id: tabId + 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest', 'media', 'other'] }
    }]
  });
}

const subsParam = subtitles => JSON.stringify(subtitles.slice(0, 10).map(s => ({ url: s.url, label: s.label, lang: s.lang })));

async function openWebPlayer(ctx) {
  const engine = settings.webPlayerEngine || 'vidstack';
  const isDash = (ctx.stream && ctx.stream.type === 'mpd') || /\.mpd(\?|#|$)/i.test(ctx.url);
  // Vidstack 0.6 cannot play DASH (Shaka takes it); Shaka and ArtPlayer play everything.
  // All three load subtitles (converted to WebVTT by src/subtitles.mjs).
  const page = isDash ? dashPageFor(engine) : enginePageFor(engine);

  const params = new URLSearchParams({ url: ctx.url });
  if (ctx.title) params.set('title', ctx.title);
  if (ctx.subtitles.length > 0) {
    params.set('subs', subsParam(ctx.subtitles));
  }
  await openExtensionTab(page, params, ctx);
}

// Opens one of our pages (player, downloader) in a new tab with the page's Referer/Origin/Cookie
// rule in place before the page fetches anything.
async function openExtensionTab(page, params, ctx) {
  const pageUrl = browser.runtime.getURL(`${page}?${params.toString()}`);
  const needsRule = !!(browser.declarativeNetRequest && playerHeaderRuleHeaders(ctx).length);
  // Open blank first so the header rule is in place before the page fetches anything
  const tab = await browser.tabs.create({ url: needsRule ? 'about:blank' : pageUrl });
  playerTabs.add(tab.id);
  if (needsRule) {
    try {
      await setPlayerHeaderRule(tab.id, ctx);
    } catch (e) {
      console.warn('[StreamPlayer] Could not set player header rule:', e);
    }
    await browser.tabs.update(tab.id, { url: pageUrl });
  }
  return tab;
}

// Built-in downloader (download.html): HLS/DASH/plain files → one MP4, no native host needed
async function openDownloadPage(ctx) {
  const params = new URLSearchParams({ url: ctx.url });
  if (ctx.title) params.set('title', ctx.title);
  // The page's subtitles go into the MP4 as text tracks (or next to a plain file as .srt)
  if (ctx.subtitles.length > 0) params.set('subs', subsParam(ctx.subtitles));
  await openExtensionTab('download.html', params, ctx);
  return { success: true };
}

// "Save" in a built-in player once the whole video is in its cache: the download page reads the
// player's cache database (`cache`), preselects what was playing and starts by itself. It gets
// the player tab's Referer/Origin/Cookie rule, so anything not cached can still be fetched.
async function saveFromPlayer(playerTabId, m) {
  const ctx = {};
  try {
    const rules = await browser.declarativeNetRequest.getSessionRules();
    const rule = rules.find(r => r.id === playerTabId + 1);
    for (const h of (rule && rule.action && rule.action.requestHeaders) || []) {
      const name = String(h.header).toLowerCase();
      if (name === 'referer') ctx.referer = h.value;
      else if (name === 'origin') ctx.origin = h.value;
      else if (name === 'cookie') ctx.cookie = h.value;
    }
  } catch { /* no rule: nothing to forward */ }
  const params = new URLSearchParams({ url: String(m.url) });
  for (const key of ['title', 'subs', 'cache', 'vh', 'vbw', 'alang', 'partial']) {
    if (m[key] != null && m[key] !== '') params.set(key, String(m[key]));
  }
  params.set('autostart', '1');
  await openExtensionTab('download.html', params, ctx);
  return { success: true };
}

// ─── External player / download ──────────────────────────────────────────────

// Argument presets for known players. A token is dropped when one of its
// placeholders is empty; a token containing {sub} is repeated per subtitle.
const NATIVE_PRESETS = {
  mpv: ['--referrer={referer}', '--user-agent={ua}', '--http-header-fields=Cookie: {cookie}', '--force-media-title={title}', '--sub-file={sub}', '{url}'],
  vlc: ['--http-referrer={referer}', '--http-user-agent={ua}', '--meta-title={title}', '--sub-file={sub}', '{url}']
};

function tokenizeTemplate(template) {
  const tokens = template.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map(t => t.replace(/"/g, ''));
}

function fillTemplate(tokens, vars, subtitles) {
  const out = [];
  for (const token of tokens) {
    const names = [...token.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (names.includes('sub')) {
      for (const sub of subtitles) out.push(token.replace(/\{sub\}/g, sub));
      continue;
    }
    if (names.some(n => !vars[n])) continue;
    out.push(token.replace(/\{(\w+)\}/g, (_, n) => vars[n]));
  }
  return out;
}

function buildNativeCommand(ctx) {
  const exe = (settings.externalPlayerPath || '').replace(/^"|"$/g, '') || 'mpv';
  const base = exe.split(/[\\/]/).pop().toLowerCase();
  let tokens;
  if (settings.nativeArgsTemplate && settings.nativeArgsTemplate.trim()) {
    tokens = tokenizeTemplate(settings.nativeArgsTemplate);
  } else if (base.includes('mpv')) {
    tokens = NATIVE_PRESETS.mpv;
  } else if (base.includes('vlc')) {
    tokens = NATIVE_PRESETS.vlc;
  } else {
    tokens = ['{url}'];
  }
  const vars = { url: ctx.url, referer: ctx.referer, ua: ctx.ua, title: ctx.title, cookie: ctx.cookie, origin: ctx.origin };
  return [exe, ...fillTemplate(tokens, vars, ctx.subtitles.map(s => s.url))];
}

async function nativeSend(message) {
  const hasPermission = await browser.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!hasPermission) {
    return { success: false, error: 'nativeMessaging permission not granted. Enable it in the extension popup settings.' };
  }
  try {
    const response = await browser.runtime.sendNativeMessage(NATIVE_HOST, message);
    if (!response) return { success: false, error: 'No response from native host' };
    if (response.status === 'error') return { success: false, error: response.error };
    return { success: true, response };
  } catch (e) {
    console.error('Native messaging failed:', e);
    const msg = /not found|forbidden/i.test(e.message || '')
      ? 'Native host is not installed for this browser. Run the installer in the native-host folder.'
      : e.message;
    return { success: false, error: msg };
  }
}

// vlc://https://host/x gets mangled by browsers (Chromium turns it into vlc://https//host/x
// because "https:" parses as a host), and handlers then have to guess. Percent-encoding the
// whole URL gives one unambiguous token: vlc://https%3A%2F%2Fhost%2Fx. 'raw' keeps the old shape.
function buildProtocolUrl(protocol, url, format) {
  const scheme = (protocol || 'vlc://').replace(/:?\/*$/, '');
  return `${scheme}://${format === 'raw' ? url : encodeURIComponent(url)}`;
}

async function handleOpenExternalPlayer(ctx) {
  if (currentPlatform === 'android') return { success: false, error: 'Not supported on Android' };

  const { desktopExternalMethod, desktopProtocol, vlcHttpPassword } = settings;

  if (desktopExternalMethod === 'protocol') {
    browser.tabs.create({ url: buildProtocolUrl(desktopProtocol, ctx.url, settings.protocolUrlFormat) });
    return { success: true };
  } else if (desktopExternalMethod === 'native') {
    return nativeSend({ action: 'launch', command: buildNativeCommand(ctx) });
  } else if (desktopExternalMethod === 'vlc_http') {
    let vlcUrl = `http://localhost:8080/requests/status.xml?command=in_play&input=${encodeURIComponent(ctx.url)}`;
    if (ctx.referer) vlcUrl += `&option=${encodeURIComponent('http-referrer=' + ctx.referer)}`;
    if (ctx.ua) vlcUrl += `&option=${encodeURIComponent('http-user-agent=' + ctx.ua)}`;
    const auth = btoa(`:${vlcHttpPassword}`);
    try {
      const res = await fetch(vlcUrl, {
        headers: { 'Authorization': `Basic ${auth}` }
      });
      if (res.ok) {
        return { success: true };
      } else {
        return { success: false, error: `HTTP ${res.status}` };
      }
    } catch (e) {
      console.error("VLC HTTP failed:", e);
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Unknown method' };
}

async function handleDownload(ctx) {
  // The built-in downloader works everywhere; yt-dlp/ffmpeg through the native host is a desktop option
  if (currentPlatform === 'android' || settings.downloadMethod !== 'native') return openDownloadPage(ctx);
  return nativeSend({
    action: 'download',
    url: ctx.url,
    title: ctx.title,
    dir: settings.downloadDir || '',
    headers: { referer: ctx.referer, userAgent: ctx.ua, cookie: ctx.cookie }
  });
}

async function copyToTab(tabId, text) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func: (value) => {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
      },
      args: [text]
    });
    return true;
  } catch {
    return false;
  }
}

// Runs one of the stream actions and reports failures to the user.
async function runAction(action, ctx) {
  let result = { success: true };
  if (action === 'browser') {
    await openWebPlayer(ctx);
  } else if (action === 'external') {
    result = await handleOpenExternalPlayer(ctx);
  } else if (action === 'download') {
    result = await handleDownload(ctx);
  } else if (action === 'copy') {
    result = { success: await copyToTab(ctx.tabId, ctx.url) };
  }
  if (!result.success && result.error) notify(result.error);
  return result;
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId ?? (sender.tab && sender.tab.id);

  if (message.type === 'videoSourcesFound' && sender.tab) {
    // From content script MutationObserver. A scan from the previous document can
    // arrive after the tab already navigated (and was cleared): drop it.
    if (sender.url && sender.tab.url && stripHash(sender.url) !== stripHash(sender.tab.url)) return false;
    if (sender.url && isStaleDocument(sender.tab.id, sender.url)) return false;
    ingestDomSources(sender.tab.id, message.sources, message.tracks, message.resources);
  } else if (message.type === 'getStreams') {
    // Popup passes a tabId; a content script that loaded after detection asks for its own tab
    storageReady.then(() => {
      let list = detectedStreams.get(tabId) || [];
      // A new page's content script can ask before the navigation-clear event reaches
      // us; only hand out streams that were detected on that very page.
      if (message.docUrl) list = list.filter(s => !s.pageUrl || s.pageUrl === stripHash(message.docUrl));
      sendResponse({
        streams: list,
        subtitles: detectedSubtitles.get(tabId) || []
      });
    });
    return true;
  } else if (message.type === 'getSettings') {
    Promise.all([settingsReady, platformReady]).then(() => {
      sendResponse({ settings, platform: currentPlatform });
    });
    return true;
  } else if (message.type === 'updateSettings') {
    const cleanNamesBefore = settings.cleanNames;
    settings = { ...settings, ...message.settings };
    browser.storage.local.set({ settings });
    syncLinkRedirectRules();
    if (settings.cleanNames !== cleanNamesBefore) renameAllStreams().catch(() => {});
  } else if (message.type === 'getStreamCount') {
    storageReady.then(() => {
      const streams = detectedStreams.get(message.tabId) || [];
      sendResponse({ count: streams.length });
    });
    return true;
  } else if (message.type === 'openWebPlayer') {
    buildContext(tabId, message.url, message.streamUrl)
      .then(ctx => runAction('browser', ctx))
      .then(res => sendResponse(res));
    return true;
  } else if (message.type === 'openExternalPlayer') {
    buildContext(tabId, message.url, message.streamUrl)
      .then(ctx => runAction('external', ctx))
      .then(res => sendResponse(res));
    return true;
  } else if (message.type === 'downloadStream') {
    buildContext(tabId, message.url, message.streamUrl)
      .then(ctx => runAction('download', ctx))
      .then(res => sendResponse(res));
    return true;
  } else if (message.type === 'saveFromPlayer') {
    // Only from our own player pages
    const ours = sender.tab && sender.url && sender.url.startsWith(browser.runtime.getURL(''));
    if (!ours || !message.url) return false;
    saveFromPlayer(sender.tab.id, message)
      .then(res => sendResponse(res), e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (message.type === 'nativePing') {
    nativeSend({ action: 'ping' }).then(res => sendResponse(res));
    return true;
  }
  return false;
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    pendingNav.delete(tabId);
    extractVideoSources(tabId);
  }
  // Single-page apps and slow sites set the title after the stream was detected
  if (changeInfo.title && tab && /^https?:/i.test(tab.url || '')) refreshStreamTitles(tabId, tab);
});

function refreshStreamTitles(tabId, tab) {
  return runExclusive(tabId, async () => {
    await storageReady;
    const streams = detectedStreams.get(tabId);
    if (!streams || streams.length === 0) return;
    const page = stripHash(tab.url);
    const title = StreamShared.cleanPageTitle(tab.title, getDomain(tab.url)).title;
    let changed = false;
    for (const s of streams) {
      if (s.pageUrl === page && s.title !== title) {
        s.title = title;
        s.pageTitle = truncateText(tab.title || '', 60);
        changed = true;
      }
    }
    if (changed) {
      saveStreams();
      notifyContentScript(tabId);
    }
  });
}

browser.tabs.onRemoved.addListener((tabId) => {
  playerTabs.delete(tabId);
  pendingNav.delete(tabId);
  runExclusive(tabId, async () => {
    await storageReady;
    forgetAnalyses(tabId);
    detectedStreams.delete(tabId);
    detectedSubtitles.delete(tabId);
    saveStreams();
  });
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
    pendingUpdates.delete(tabId);
  }
  removePlayerHeaderRule(tabId);
});

// A new top-level navigation starts a fresh page: forget the old streams.
// This runs before any sub-request of the new page, and goes through the same
// per-tab queue as addStream, so a stream detected right after cannot be wiped.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const tabId = details.tabId;
    pendingNav.set(tabId, { url: details.url, time: Date.now() });
    // A web navigation in this tab means it is not (or no longer) our player: its Referer/Cookie
    // rule must not follow. Done whether or not the tab is in `playerTabs`, because that set is lost
    // when the MV3 worker is evicted; removing a rule that does not exist is a no-op. Chromium also
    // reports navigations to our own chrome-extension:// pages here: opening the player must keep it.
    if (/^https?:/i.test(details.url)) {
      playerTabs.delete(tabId);
      removePlayerHeaderRule(tabId);
    }
    runExclusive(tabId, async () => {
      await storageReady;
      forgetAnalyses(tabId);
      if (!detectedStreams.has(tabId) && !detectedSubtitles.has(tabId)) return;
      detectedStreams.delete(tabId);
      detectedSubtitles.delete(tabId);
      saveStreams();
      updateBadge(tabId);
      // Browsers deliver webRequest events asynchronously, so the new page's content
      // script may already have pulled the old list: tell it to drop it.
      browser.tabs.sendMessage(tabId, { type: 'streamsCleared' }).catch(() => {});
    });
    if (pendingUpdates.has(tabId)) {
      clearTimeout(pendingUpdates.get(tabId));
      pendingUpdates.delete(tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// ─── Web request listener (headers only, no re-fetching) ──────────────────────

browser.webRequest.onHeadersReceived.addListener(
  async (details) => {
    // Grab captured request headers synchronously, before any await
    const reqHeaders = requestHeadersById.get(details.requestId) || null;
    requestHeadersById.delete(details.requestId);

    await settingsReady;
    if (!settings.enabled) return;
    if (!isUsableStatus(details.statusCode)) return; // 404 pages, empty 204s, …

    const url = details.url;
    const contentType = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';

    const found = classifyUrl(url, contentType, details.type);
    if (!found) return;
    // No tab: a service worker's request (or one of our own, which resolves to no tab)
    const tabId = details.tabId >= 0 ? details.tabId : await tabForWorkerRequest(details);
    if (tabId == null) return;
    if (found.kind === 'subtitle') addSubtitle(tabId, url);
    else addStream(tabId, url, contentType, null, reqHeaders, found.type);
  },
  {
    urls: ["<all_urls>"],
    types: WEB_REQUEST_TYPES
  },
  ["responseHeaders"]
);

// One-time scan when tab is activated (no interval)
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await settingsReady;
  if (settings.enabled) {
    extractVideoSources(tabId);
  }
});

// ─── Context menu ─────────────────────────────────────────────────────────────

const MENU_ITEMS = [
  { id: 'ctx-external', title: 'Open in external player', action: 'external' },
  { id: 'ctx-browser', title: 'Play in browser player', action: 'browser' },
  { id: 'ctx-copy', title: 'Copy stream URL', action: 'copy' },
  { id: 'ctx-download', title: 'Download video', action: 'download' }
];

if (browser.contextMenus) {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll().then(() => {
      for (const item of MENU_ITEMS) {
        browser.contextMenus.create({ id: item.id, title: item.title, contexts: ['link', 'video', 'audio'] });
      }
    }).catch(() => {});
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    const item = MENU_ITEMS.find(i => i.id === info.menuItemId);
    const url = info.linkUrl || info.srcUrl;
    if (!item || !url || !tab) return;
    await settingsReady;
    runAction(item.action, await buildContext(tab.id, url, url));
  });
}

// ─── Keyboard shortcut ────────────────────────────────────────────────────────

if (browser.commands) {
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'send-to-player') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    await Promise.all([storageReady, settingsReady]);
    const stream = (detectedStreams.get(tab.id) || [])[0];
    if (!stream) {
      notify('No stream detected on this page.');
      return;
    }
    let action = settings.defaultTapAction;
    if (action === 'default') action = 'copy';
    runAction(action, await buildContext(tab.id, stream.url, stream.url));
  });
}
