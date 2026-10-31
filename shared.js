// shared.js — helpers shared by the content script and the popup.
(function (root) {
  const ANDROID_PLAYERS = {
    vlc: 'org.videolan.vlc',
    mx: 'com.mxtech.videoplayer.ad',
    mxpro: 'com.mxtech.videoplayer.pro',
    mpv: 'is.xyz.mpv'
  };

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds === Infinity) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // Builds an intent:// URL. `player` is a key of ANDROID_PLAYERS (explicit package) or
  // anything else for the generic "open with" chooser. Web intents can only carry
  // string extras, so only the title (all players) and one subtitle (VLC) are forwarded.
  function buildAndroidIntent(url, name, player, subtitleUrl) {
    const pkg = ANDROID_PLAYERS[player] || '';
    const pkgPart = pkg ? `package=${pkg};` : '';
    const titleExtra = name ? `S.title=${encodeURIComponent(name)};` : '';
    const subExtra = subtitleUrl && player === 'vlc' ? `S.subtitles_location=${encodeURIComponent(subtitleUrl)};` : '';
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.replace(':', '');
      const urlWithoutScheme = url.replace(`${scheme}://`, '');
      return `intent://${urlWithoutScheme}#Intent;scheme=${scheme};action=android.intent.action.VIEW;type=video/*;${pkgPart}${titleExtra}${subExtra}end`;
    } catch (e) {
      return `intent:#Intent;action=android.intent.action.VIEW;type=video/*;d=${encodeURIComponent(url)};${pkgPart}${titleExtra}${subExtra}end`;
    }
  }

  // Opens `url` in an Android player. Returns after handing the intent to the OS.
  function launchAndroidIntent(doc, url, name, player, subtitleUrl) {
    const intentUrl = buildAndroidIntent(url, name, player, subtitleUrl);
    let iframe = doc.getElementById('intent-launcher');
    if (!iframe) {
      iframe = doc.createElement('iframe');
      iframe.id = 'intent-launcher';
      iframe.style.display = 'none';
      doc.body.appendChild(iframe);
    }
    iframe.src = intentUrl;
  }

  // Share sheet first when no explicit player is configured; explicit intent otherwise.
  function shareToAndroid(win, url, name, player, subtitleUrl) {
    const explicit = ANDROID_PLAYERS[player];
    if (!explicit && win.navigator.share && win.isSecureContext) {
      win.navigator.share({ url, title: name || '' }).catch(() => {
        launchAndroidIntent(win.document, url, name, player, subtitleUrl);
      });
    } else {
      launchAndroidIntent(win.document, url, name, player, subtitleUrl);
    }
  }

  root.StreamShared = { ANDROID_PLAYERS, formatDuration, buildAndroidIntent, launchAndroidIntent, shareToAndroid };
})(globalThis);
