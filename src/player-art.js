// ArtPlayer page: ArtPlayer's interface (settings panel, subtitle offset, screenshot, flip,
// aspect ratio, speed, picture-in-picture, mini progress bar; on phones: swipe to seek, long-press
// fast forward, lock, landscape in fullscreen) over hls.js (HLS), Shaka (DASH) or the browser
// itself (plain files). Everything the other two players have is here as well: the whole-video
// download with Save (src/stream-cache.mjs), faster buffering when that is off, converted
// subtitles, resume position, remembered speed and quality.
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { loadSubtitleAsVtt, sanitizeVttForHtml } from './subtitles.mjs';
import { getVideoUrl, getSubtitleList, getTitle } from './page-params.mjs';
import { attachPlaybackMemory, lockOrientationOnFullscreen, makeToast, createMemory } from './player-memory.mjs';
import { SegmentPrefetcher, bufferingSettings } from './prefetch.mjs';
import { createPrefetchLoader } from './hls-prefetch.mjs';
import { openPlayerCache } from './stream-cache.mjs';
import { createCacheLoader, hlsPlan, pickLevelIndex, desiredHeight } from './cache-hls.mjs';
import { registerCacheScheme, shakaPlan, pickVariant } from './cache-shaka.mjs';
import { createCacheBadge, throttle } from './cache-ui.mjs';
import { startFileCache, onComplete, saveStreamFromCache, saveFileFromCache } from './player-cache.mjs';

async function readSettings() {
  try {
    const api = globalThis.browser || globalThis.chrome;
    const r = await api.storage.local.get('settings');
    return (r && r.settings) || {};
  } catch {
    return {};
  }
}

const isMobile = () => /Android|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;

const videoUrl = getVideoUrl(window.location);
const title = getTitle(window.location);
const subtitles = getSubtitleList(window.location);
const errorEl = document.getElementById('error-message');
const toast = makeToast(document.getElementById('toast'));
const memory = createMemory();
if (title) document.title = title;

// Read by the browser tests: { label, format, via: 'converted'|'failed' }
window._subtitleStatus = [];

function streamType(url) {
  const path = url.toLowerCase().split(/[?#]/)[0];
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'native';
}

const SUB_SIZES = [['Small', '0.8'], ['Normal', '1'], ['Large', '1.3'], ['Extra large', '1.7']];
const SUB_SIZE_KEY = 'sap-art-subtitle-size';
const readSubSize = () => { try { return localStorage.getItem(SUB_SIZE_KEY) || '1'; } catch { return '1'; } };

const heightLabel = h => (h ? `${h}p` : 'Video');

function seekVideo(video, t) {
  const d = video.duration;
  video.currentTime = Math.max(0, Number.isFinite(d) && d > 0 ? Math.min(t, d) : t);
}

// ─── engines ─────────────────────────────────────────────────────────────────
// Each engine offers the same small interface to the menus below:
// qualities() [{ id, label, height, bitrate }], quality() → id or -1 (automatic), setQuality(id)
// audios() [{ id, label }], audio(), setAudio(id); texts() [{ id, label, lang }], setText(id | null)
// canAuto: whether "Automatic" quality is offered (not while the whole video is downloaded:
// one quality is played and downloaded, as in FastStream); choice() for Save.

function hlsEngine(hls, { canAuto, onChange }) {
  const engine = {
    kind: 'hls',
    canAuto,
    qualities: () => (hls.levels || []).map((l, i) => ({ id: i, height: l.height || 0, bitrate: l.bitrate || 0, label: heightLabel(l.height) })),
    quality: () => (hls.autoLevelEnabled ? -1 : hls.currentLevel),
    setQuality(id) {
      if (id === -1) {
        hls.currentLevel = -1;
        memory.setPreferredHeight(0);
      } else {
        hls.currentLevel = id;
        const l = hls.levels[id];
        if (l && l.height) memory.setPreferredHeight(l.height);
      }
    },
    audios: () => (hls.audioTracks || []).map((t, i) => ({ id: i, label: [t.name, t.lang].filter(Boolean).join(' · ') || `Audio ${i + 1}` })),
    audio: () => hls.audioTrack,
    setAudio(id) { hls.audioTrack = id; },
    texts: () => (hls.subtitleTracks || []).map((t, i) => ({ id: i, label: t.name || t.lang || `Track ${i + 1}`, lang: t.lang || '' })),
    setText(id) {
      hls.subtitleDisplay = id != null;
      hls.subtitleTrack = id == null ? -1 : id;
    },
    choice() {
      const l = hls.levels[hls.currentLevel] || hls.levels[hls.loadLevel] || {};
      const a = (hls.audioTracks || [])[hls.audioTrack] || {};
      return { height: l.height, bandwidth: l.bitrate, audioLanguage: a.lang };
    }
  };
  for (const ev of [Hls.Events.MANIFEST_PARSED, Hls.Events.LEVEL_SWITCHED, Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHED, Hls.Events.SUBTITLE_TRACKS_UPDATED]) {
    hls.on(ev, () => onChange());
  }
  return engine;
}

function shakaEngine(player, { canAuto, onChange }) {
  const activeVariant = () => player.getVariantTracks().find(t => t.active) || {};
  // variants of the playing audio language (so a quality pick does not switch the language)
  const sameAudio = () => {
    const a = activeVariant();
    return player.getVariantTracks().filter(t => t.language === a.language && t.height);
  };
  const engine = {
    kind: 'dash',
    canAuto,
    qualities() {
      const seen = new Map();
      for (const t of sameAudio()) {
        const prev = seen.get(t.height);
        if (!prev || t.bandwidth > prev.bitrate) seen.set(t.height, { id: t.height, height: t.height, bitrate: t.bandwidth, label: heightLabel(t.height) });
      }
      return [...seen.values()].sort((a, b) => b.height - a.height);
    },
    quality: () => (player.getConfiguration().abr.enabled ? -1 : (activeVariant().height || -1)),
    setQuality(height) {
      if (height === -1) {
        player.configure({ abr: { enabled: true } });
        memory.setPreferredHeight(0);
        return;
      }
      const pick = sameAudio().filter(t => t.height === height).sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!pick) return;
      player.configure({ abr: { enabled: false } });
      player.selectVariantTrack(pick, true);
      memory.setPreferredHeight(height);
    },
    // Shaka 5: audio tracks (one per language/role/channel layout)
    audios: () => player.getAudioTracks().map((a, i) => ({
      id: i,
      label: [a.label, a.language && a.language !== 'und' ? a.language : '', a.channelsCount ? `${a.channelsCount} ch` : '', (a.roles || []).join(' ')].filter(Boolean).join(' · ') || `Audio ${i + 1}`
    })),
    audio: () => player.getAudioTracks().findIndex(a => a.active),
    setAudio(id) {
      const a = player.getAudioTracks()[id];
      if (a) player.selectAudioTrack(a);
    },
    texts: () => player.getTextTracks().map(t => ({ id: t.id, label: t.label || t.language || `Track ${t.id}`, lang: t.language || '' })),
    // Shaka 5: selecting a track shows it, selectTextTrack(null) hides captions
    setText(id) {
      const t = id == null ? null : player.getTextTracks().find(x => x.id === id);
      player.selectTextTrack(t || null);
    },
    choice() {
      const a = activeVariant();
      return { height: a.height, bandwidth: a.videoBandwidth || a.bandwidth, audioLanguage: a.language };
    }
  };
  for (const ev of ['trackschanged', 'variantchanged', 'adaptation', 'abrstatuschanged', 'textchanged']) player.addEventListener(ev, () => onChange());
  return engine;
}

const nativeEngine = {
  kind: 'native',
  canAuto: false,
  qualities: () => [],
  quality: () => -1,
  setQuality() {},
  audios: () => [],
  audio: () => -1,
  setAudio() {},
  texts: () => [],
  setText() {},
  choice: () => ({})
};

// ─── page ────────────────────────────────────────────────────────────────────

async function main() {
  if (!videoUrl) {
    errorEl.textContent = 'No video URL provided.';
    return;
  }
  const mobile = isMobile();
  const settings = await readSettings();
  const buffering = bufferingSettings(settings, { mobile });
  const type = streamType(videoUrl);
  let badge = null;
  let filePlan = null;
  let engine = nativeEngine;

  let cache = null;
  if (buffering.wholeVideo) {
    const update = throttle(c => { if (badge) badge.update(c.progress()); }, 500);
    cache = await openPlayerCache({ maxBytes: buffering.cacheBytes, parallel: buffering.parallel, mobile, onChange: update })
      .catch((e) => { console.warn('Whole-video download unavailable:', e); return null; });
  }
  window._cache = cache;
  const prefetcher = !cache && buffering.enabled && type === 'hls'
    ? new SegmentPrefetcher({ maxParallel: buffering.parallel, maxBytes: buffering.prefetchBytes })
    : null;
  window._prefetch = prefetcher;
  if (cache && type === 'dash') registerCacheScheme(shaka, () => cache);

  const depth = {
    maxBufferLength: buffering.bufferAhead,
    maxMaxBufferLength: buffering.bufferAhead * 2,
    maxBufferSize: buffering.maxBufferBytes,
    backBufferLength: 30
  };

  // Phones: a double tap seeks ±10 s on the left/right third (play/pause in the middle);
  // a single tap shows the controls. Desktop: click = play/pause, double click = fullscreen.
  Artplayer.MOBILE_DBCLICK_PLAY = false;
  Artplayer.SEEK_STEP = 10;
  Artplayer.CONTEXTMENU = false;

  let refreshMenus = () => {};
  const menusChanged = throttle(() => refreshMenus(), 200);

  const art = new Artplayer({
    container: '#art',
    url: videoUrl,
    type: type === 'hls' ? 'm3u8' : type === 'dash' ? 'mpd' : '',
    theme: '#4caf50',
    lang: 'en',
    volume: 1,
    autoplay: false,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    flip: true,
    screenshot: true,
    pip: true,
    fullscreen: true,
    fullscreenWeb: !mobile,
    subtitleOffset: true,
    miniProgressBar: true,
    hotkey: true,
    mutex: true,
    backdrop: true,
    playsInline: true,
    autoPlayback: false, // resume is ours (shared with the other players)
    autoOrientation: true,
    airplay: false,
    lock: mobile,
    gesture: true,
    fastForward: mobile,
    // cue text is sanitised (sanitizeVttForHtml) so italics/bold survive and nothing else does
    subtitle: { type: 'vtt', escape: false, encoding: 'utf-8', onVttLoad: vtt => sanitizeVttForHtml(vtt) },
    customType: {
      m3u8(video, url, player) {
        if (player.hls) player.hls.destroy();
        if (!Hls.isSupported()) {
          video.src = url; // native HLS (Safari)
          return;
        }
        const config = { ...depth };
        if (cache) config.fLoader = createCacheLoader(Hls.DefaultConfig.loader, () => cache);
        else if (prefetcher) config.fLoader = createPrefetchLoader(Hls.DefaultConfig.loader, () => player.hls, prefetcher, { aheadSeconds: buffering.bufferAhead });
        const hls = new Hls(config);
        player.hls = hls;
        window._hls = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // One quality when downloading the whole video (or when one was chosen before)
          const preferred = memory.preferredHeight();
          if (hls.levels.length > 1 && (cache || preferred)) {
            const index = pickLevelIndex(hls.levels, desiredHeight(preferred));
            if (index >= 0) {
              hls.startLevel = index;
              hls.currentLevel = index;
            }
          }
        });
        if (cache) {
          const replan = () => cache.setPlan(hlsPlan(hls));
          for (const ev of [Hls.Events.LEVEL_LOADED, Hls.Events.LEVEL_SWITCHED, Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.AUDIO_TRACK_SWITCHED]) hls.on(ev, replan);
        }
        // Network trouble: keep trying (the whole-video download retries on its own as well)
        let mediaRecoveries = 0;
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => hls.startLoad(), 3000);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 3) {
            hls.recoverMediaError();
          } else {
            errorEl.textContent = `Playback error: ${data.details}`;
          }
        });
        engine = hlsEngine(hls, { canAuto: !cache, onChange: menusChanged });
        hls.loadSource(url);
        hls.attachMedia(video);
      },
      async mpd(video, url, player) {
        if (player.mpd) await player.mpd.destroy();
        shaka.polyfill.installAll();
        const sp = new shaka.Player();
        player.mpd = sp;
        window._shakaPlayer = sp;
        await sp.attach(video);
        sp.configure({
          streaming: {
            retryParameters: { maxAttempts: cache ? 8 : 4, baseDelay: cache ? 500 : 100, backoffFactor: 2, fuzzFactor: 0.5, timeout: 0 },
            segmentPrefetchLimit: cache ? 0 : (buffering.enabled ? buffering.parallel : 0),
            bufferingGoal: buffering.bufferAhead,
            bufferBehind: 30
          }
        });
        sp.addEventListener('error', (event) => {
          const d = event.detail;
          errorEl.textContent = `Playback error (${d.code})`;
        });
        try {
          await sp.load(url);
        } catch (e) {
          errorEl.textContent = `Failed to load: ${e.message || e.code || e}`;
          return;
        }
        const preferred = memory.preferredHeight();
        if (cache || preferred) {
          const pick = pickVariant(sp.getVariantTracks().filter(t => t.height), desiredHeight(preferred));
          sp.configure({ abr: { enabled: false } });
          if (pick && !pick.active) sp.selectVariantTrack(pick, true);
        }
        sp.selectTextTrack(null); // page subtitles are shown by ArtPlayer; manifest ones on request
        engine = shakaEngine(sp, { canAuto: !cache, onChange: menusChanged });
        menusChanged();
        if (cache) {
          let generation = 0;
          const replan = async () => {
            const mine = ++generation;
            try {
              const plan = await shakaPlan(shaka, sp);
              if (mine === generation) cache.setPlan(plan);
            } catch (e) {
              console.warn('[cache] could not list the segments:', e);
            }
          };
          for (const ev of ['variantchanged', 'adaptation', 'trackschanged']) sp.addEventListener(ev, replan);
          replan();
        }
      }
    }
  });
  window._art = art;
  art.on('destroy', () => {
    if (art.hls) art.hls.destroy();
    if (art.mpd) art.mpd.destroy();
  });

  // ── subtitles: the page's files (converted to WebVTT) + the manifest's own tracks ──
  const pageSubs = []; // { label, lang, url (blob) }
  let currentSub = null; // { kind: 'page'|'manifest', id } or null
  async function loadPageSubtitles() {
    for (const sub of subtitles) {
      const status = { label: sub.label || '', format: '', via: 'pending' };
      window._subtitleStatus.push(status);
      try {
        const { vtt, format } = await loadSubtitleAsVtt(sub);
        status.format = format;
        pageSubs.push({ label: sub.label || sub.lang || `Subtitles ${pageSubs.length + 1}`, lang: sub.lang || '', url: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })) });
        status.via = 'converted';
      } catch (e) {
        status.via = 'failed';
        console.warn('Could not load subtitle', sub.url, e);
      }
    }
  }
  function subtitleOptions() {
    return [
      ...pageSubs.map((s, i) => ({ kind: 'page', id: i, label: s.label })),
      ...engine.texts().map(t => ({ kind: 'manifest', id: t.id, label: t.label }))
    ];
  }
  let subGeneration = 0;
  async function selectSubtitle(choice, { announce = true } = {}) {
    currentSub = choice;
    const mine = ++subGeneration; // a later choice wins over a switch still loading
    if (!choice) {
      art.subtitle.show = false;
      engine.setText(null);
    } else if (choice.kind === 'page') {
      engine.setText(null);
      const s = pageSubs[choice.id];
      await art.subtitle.switch(s.url, { type: 'vtt', name: announce ? s.label : '' });
      if (mine !== subGeneration) {
        if (!currentSub || currentSub.kind !== 'page') art.subtitle.show = false;
        return;
      }
      art.subtitle.show = true;
    } else {
      art.subtitle.show = false;
      engine.setText(choice.id);
    }
    window._subtitleSelected = choice ? subtitleOptions().find(o => o.kind === choice.kind && o.id === choice.id)?.label || '' : null;
    menusChanged();
  }
  function cycleSubtitles() {
    const list = subtitleOptions();
    if (!list.length) return;
    const i = currentSub ? list.findIndex(o => o.kind === currentSub.kind && o.id === currentSub.id) : -1;
    const next = i + 1 < list.length ? list[i + 1] : null;
    selectSubtitle(next ? { kind: next.kind, id: next.id } : null, { announce: false });
    art.notice.show = next ? `Subtitles: ${next.label}` : 'Subtitles off';
  }

  // ── settings panel: quality, audio, subtitles, subtitle size (ArtPlayer adds speed,
  //    aspect ratio, flip and subtitle offset itself) ──
  const added = new Set();
  function upsert(setting) {
    if (added.has(setting.name)) art.setting.update(setting);
    else {
      art.setting.add(setting);
      added.add(setting.name);
    }
  }
  function remove(name) {
    if (added.has(name)) {
      art.setting.remove(name);
      added.delete(name);
    }
  }
  refreshMenus = () => {
    if (!art.isReady) return;
    // Quality
    const qualities = engine.qualities().sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    if (qualities.length > 1) {
      const current = engine.quality();
      const items = qualities.map(q => ({ html: q.label, value: q.id, default: q.id === current }));
      if (engine.canAuto) items.unshift({ html: 'Automatic', value: -1, default: current === -1 });
      const label = (items.find(i => i.default) || items[0]).html;
      upsert({
        name: 'sap-quality',
        html: 'Quality',
        tooltip: label,
        width: 200,
        selector: items,
        onSelect(item) {
          engine.setQuality(item.value);
          return item.html;
        }
      });
    } else remove('sap-quality');
    // Audio
    const audios = engine.audios();
    if (audios.length > 1) {
      const current = engine.audio();
      upsert({
        name: 'sap-audio',
        html: 'Audio',
        tooltip: (audios.find(a => a.id === current) || audios[0]).label,
        width: 240,
        selector: audios.map(a => ({ html: a.label, value: a.id, default: a.id === current })),
        onSelect(item) {
          engine.setAudio(item.value);
          return item.html;
        }
      });
    } else remove('sap-audio');
    // Subtitles
    const subs = subtitleOptions();
    if (subs.length) {
      const isCurrent = o => !!currentSub && o.kind === currentSub.kind && o.id === currentSub.id;
      upsert({
        name: 'sap-subtitles',
        html: 'Subtitles',
        tooltip: (subs.find(isCurrent) || { label: 'Off' }).label,
        width: 240,
        selector: [{ html: 'Off', value: null, default: !currentSub }, ...subs.map(o => ({ html: o.label, value: o, default: isCurrent(o) }))],
        onSelect(item) {
          selectSubtitle(item.value ? { kind: item.value.kind, id: item.value.id } : null, { announce: false });
          return item.html;
        }
      });
      const size = readSubSize();
      upsert({
        name: 'sap-subtitle-size',
        html: 'Subtitle size',
        tooltip: (SUB_SIZES.find(([, v]) => v === size) || SUB_SIZES[1])[0],
        width: 200,
        selector: SUB_SIZES.map(([label, v]) => ({ html: label, value: v, default: v === size })),
        onSelect(item) {
          try { localStorage.setItem(SUB_SIZE_KEY, item.value); } catch { /* not kept */ }
          applySubSize(item.value);
          return item.html;
        }
      });
    } else {
      remove('sap-subtitles');
      remove('sap-subtitle-size');
    }
  };
  const applySubSize = (v) => art.subtitle.style({ fontSize: `calc(var(--art-subtitle-font-size, 20px) * ${v})` });

  // ── Save (whole video loaded) ──
  async function save(button) {
    button.disabled = true;
    try {
      if (filePlan) {
        toast(`Saved ${await saveFileFromCache(cache, filePlan, { url: videoUrl, title })}`);
      } else {
        await saveStreamFromCache(cache, { url: videoUrl, title, choice: engine.choice() });
      }
    } catch (e) {
      toast(`Could not save: ${e.message || e}`);
    } finally {
      button.disabled = false;
    }
  }

  art.on('ready', async () => {
    const video = art.video;
    art.isFocus = true; // the page is the player: keys work without clicking it first
    // ArtPlayer clamps seeks to its duration, which it reports as 0 for files of unknown length
    // (WebM from recorders): seek the element itself
    const seekTo = t => seekVideo(video, t);
    const seekBy = (delta) => {
      seekTo(video.currentTime + delta);
      art.notice.show = `${delta > 0 ? '+' : '−'}${Math.abs(delta)} s`;
    };
    attachPlaybackMemory(video, videoUrl, {
      memory,
      toast,
      setRate: r => { art.playbackRate = r; },
      seek: seekTo
    });
    art.hotkey.keys.ArrowRight = [() => seekBy(Artplayer.SEEK_STEP)];
    art.hotkey.keys.ArrowLeft = [() => seekBy(-Artplayer.SEEK_STEP)];
    lockOrientationOnFullscreen(video);

    // Keys besides ArtPlayer's own (space, arrows, Esc): f fullscreen, m mute, c subtitles, p picture-in-picture
    art.hotkey.add('KeyF', () => { art.fullscreen = !art.fullscreen; });
    art.hotkey.add('KeyM', () => { art.muted = !art.muted; });
    art.hotkey.add('KeyC', () => cycleSubtitles());
    art.hotkey.add('KeyP', () => { art.pip = !art.pip; });

    // Phones: double tap left/right third seeks ±10 s, the middle plays/pauses
    if (mobile) {
      art.on('dblclick', (event) => {
        if (art.isLock) return;
        const rect = art.template.$player.getBoundingClientRect();
        const x = ((event.changedTouches && event.changedTouches[0]) || event).clientX - rect.left;
        if (x < rect.width / 3) {
          seekBy(-10);
        } else if (x > rect.width * 2 / 3) {
          seekBy(10);
        } else {
          art.toggle();
        }
      });
    }

    if (cache) startCacheUi(video);

    await loadPageSubtitles();
    applySubSize(readSubSize());
    if (pageSubs.length) await selectSubtitle({ kind: 'page', id: 0 }, { announce: false });
    refreshMenus();
    art.play().catch(e => console.log('Autoplay blocked:', e.message));
  });

  function startCacheUi(video) {
    badge = createCacheBadge(art.template.$player, video, { onSave: save });
    badge.update(cache.progress());
    if (type !== 'native') {
      const onTime = () => cache.setPosition(video.currentTime);
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('seeking', onTime);
      return;
    }
    // A plain file: cached as byte ranges, then played from the local copy
    startFileCache(cache, video, videoUrl).then((plan) => {
      filePlan = plan;
      window._filePlan = plan;
      if (!plan) {
        badge.destroy();
        badge = null;
        return;
      }
      onComplete(cache, async () => {
        const blob = await cache.assemble(plan.type);
        if (!blob) return;
        // (not art.switchQuality: it restores the position through ArtPlayer's clamped seek)
        const at = video.currentTime;
        const paused = video.paused;
        const rate = video.playbackRate;
        video.src = URL.createObjectURL(blob);
        await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
        seekVideo(video, at);
        video.playbackRate = rate;
        if (!paused) video.play().catch(() => {});
        window._playingLocalCopy = true;
      });
    });
  }
}

main().catch((e) => {
  console.error(e);
  errorEl.textContent = `Failed to start: ${e.message || e}`;
});
