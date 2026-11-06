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

  // ─── Domain rules (whitelist / blacklist) ────────────────────────────────────
  // One rule per entry:
  //   example.com    host or any subdomain of it (suffix match on whole labels)
  //   youtube        a single word matches any host that has that label (www.youtube.com)
  //   -example.com   exactly that host
  //   ~^cdn\d+\.     regular expression tested against the host name
  //   !rule          exception: hosts matching it are removed from the list
  // (prefixes adapted from FastStream's auto-enable list). Plain `includes` matching
  // made "ads.com" also match "roads.com.au".

  const domainRuleCache = new Map();

  function parseDomainRule(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s || s.startsWith('#')) return null;
    const key = s;
    if (domainRuleCache.has(key)) return domainRuleCache.get(key);

    const rule = { negate: false, kind: 'suffix', value: '', re: null };
    while (s) {
      const c = s[0];
      if (c === '!') rule.negate = true;
      else if (c === '~') rule.kind = 'regex';
      else if (c === '-') { if (rule.kind !== 'regex') rule.kind = 'exact'; }
      else break;
      s = s.slice(1);
    }
    let result = null;
    if (rule.kind === 'regex') {
      try {
        rule.re = new RegExp(s, 'i');
        rule.value = s;
        result = s ? rule : null;
      } catch (e) {
        result = null;
      }
    } else {
      s = s.toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '')
        .replace(/^\*?\./, '')
        .replace(/\.$/, '');
      rule.value = s;
      result = s ? rule : null;
    }
    if (domainRuleCache.size > 500) domainRuleCache.clear();
    domainRuleCache.set(key, result);
    return result;
  }

  function matchesDomainRule(hostname, rule) {
    if (!rule || !hostname) return false;
    const host = hostname.toLowerCase();
    if (rule.kind === 'regex') return rule.re.test(host);
    if (rule.kind === 'exact') return host === rule.value;
    if (rule.value.includes('.')) return host === rule.value || host.endsWith('.' + rule.value);
    return host.split('.').includes(rule.value);
  }

  // True when the host matches at least one positive rule and no "!" exception.
  function matchesDomainList(hostname, list) {
    if (!hostname || !Array.isArray(list)) return false;
    let positive = false;
    for (const raw of list) {
      const rule = parseDomainRule(raw);
      if (!rule || !matchesDomainRule(hostname, rule)) continue;
      if (rule.negate) return false;
      positive = true;
    }
    return positive;
  }

  // Validates a list typed by the user. Returns one message per unusable line.
  function validateDomainList(list) {
    const errors = [];
    list.forEach((raw, i) => {
      const s = String(raw).trim();
      if (s && !s.startsWith('#') && !parseDomainRule(s)) errors.push(`Entry ${i + 1} ("${s}") is not a valid rule`);
    });
    return errors;
  }

  // ─── Custom detection patterns ───────────────────────────────────────────────
  // One rule per line:  <type> /regex/flags     (lines starting with # or // are comments)
  // Types: m3u8 (hls), mpd (dash), mp4, ts, video (any other media), subtitle (vtt, srt).
  // Format adapted from FastStream's "custom source patterns".

  const PATTERN_TYPES = {
    m3u8: 'm3u8', hls: 'm3u8', m3u: 'm3u8',
    mpd: 'mpd', dash: 'mpd',
    mp4: 'mp4', webm: 'mp4',
    ts: 'ts',
    video: 'video', stream: 'video',
    subtitle: 'subtitle', subtitles: 'subtitle', vtt: 'subtitle', srt: 'subtitle', sub: 'subtitle'
  };

  let lastPatternText = null;
  let lastPatternResult = { rules: [], errors: [] };

  function parseCustomPatterns(text) {
    const rules = [];
    const errors = [];
    String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      const space = line.search(/\s/);
      const typeName = (space === -1 ? line : line.slice(0, space)).toLowerCase();
      const rest = space === -1 ? '' : line.slice(space).trim();
      const type = PATTERN_TYPES[typeName];
      if (!type) {
        errors.push({ line: i + 1, message: `Unknown type "${typeName}" (use m3u8, mpd, mp4, ts, video or subtitle)` });
        return;
      }
      const last = rest.lastIndexOf('/');
      if (!rest.startsWith('/') || last <= 0) {
        errors.push({ line: i + 1, message: 'Expected /regex/flags after the type' });
        return;
      }
      const source = rest.slice(1, last);
      const flags = rest.slice(last + 1).replace(/[gy]/g, ''); // stateful flags would break repeated tests
      if (!source) {
        errors.push({ line: i + 1, message: 'Empty regular expression (it would match every URL)' });
        return;
      }
      try {
        rules.push({ type, re: new RegExp(source, flags) });
      } catch (e) {
        errors.push({ line: i + 1, message: `Invalid regular expression: ${e.message}` });
      }
    });
    return { rules, errors };
  }

  // Parsing is cached for the last text, which is what the background script keeps asking for.
  function compileCustomPatterns(text) {
    const key = String(text || '');
    if (key !== lastPatternText) {
      lastPatternResult = parseCustomPatterns(key);
      lastPatternText = key;
    }
    return lastPatternResult;
  }

  // Returns the type of the first rule that matches `url`, or null.
  function matchCustomPattern(text, url) {
    for (const rule of compileCustomPatterns(text).rules) {
      if (rule.re.test(url)) return rule.type;
    }
    return null;
  }

  // ─── Page title cleaning ─────────────────────────────────────────────────────
  // Turns "Watch Dark Matter Season 1 Episode 5 Online Free - SiteName" into
  // { name: "Dark Matter", season: 1, episode: 5, title: "Dark Matter S01E05" }.
  // Idea from FastStream's getMediaInfoFromTab. Differences: nothing is stripped just for being
  // non-ASCII (their version deletes every non-Latin character, destroying CJK/Cyrillic titles),
  // generic words such as "movie" or "show" are kept, and only edge phrases are removed.

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const keyOf = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  function siteLabel(hostname) {
    const parts = String(hostname || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
    if (parts.length < 2) return parts[0] || '';
    let i = parts.length - 2;
    const second = ['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'];
    if (parts.length >= 3 && second.includes(parts[i]) && parts[parts.length - 1].length === 2) i--;
    return keyOf(parts[i]);
  }

  const TITLE_SEPARATORS = /\s+[-–—|•·»«]+\s+|\s*\|\s*|\s+::\s+/;
  // Multi-word boilerplate that is safe to strip from the end of any title…
  const STRONG_TRAIL = /[\s,:\-–—|]*\b(?:(?:watch\s+)?online(?:\s+(?:free|hd))?|free\s+online|watch\s+now|full\s+(?:movie|episodes?|video)|(?:english|eng)\s*(?:sub(?:bed|titles?|s)?|dub(?:bed)?)|subbed|dubbed)\b[\s.!]*$/i;
  // …and single words that are only boilerplate once "Watch …" / "Download …" shows the title is
  // a call to action ("Born Free" and "Free Guy" are real titles and must stay intact).
  const WEAK_TRAIL = /[\s,:\-–—|]*\b(?:free|hd|streaming|online|full)\b[\s.!]*$/i;
  const FILLER_LEAD = /^(?:watch(?:ing)?|download)\s+/i;

  function stripFillerEdges(text) {
    let s = text.trim();
    for (let i = 0; i < 8; i++) {
      let next = s;
      const lead = next.replace(FILLER_LEAD, '');
      const callToAction = lead !== next;
      next = lead.replace(STRONG_TRAIL, '').trim();
      // Weak words go only in the pass that removed "Watch …", and only when no multi-word
      // boilerplate matched: "Watch Born Free Online Free" keeps the title's own "Free".
      if (callToAction && next === lead.trim()) next = next.replace(WEAK_TRAIL, '').trim();
      if (next === s) break;
      s = next;
    }
    return s;
  }

  function looksLikeSite(segment, site) {
    if (!site || site.length < 3) return false;
    const key = keyOf(segment);
    if (!key) return false;
    const words = segment.trim().split(/\s+/).length;
    if (key === site) return true;
    if (words <= 4 && key.includes(site)) return true;
    return words <= 3 && key.length >= 3 && levenshtein(key, site) <= Math.floor(site.length * 0.3);
  }

  function padNum(n) { return String(n).padStart(2, '0'); }

  function cleanPageTitle(rawTitle, hostname) {
    const original = String(rawTitle || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const empty = { name: '', season: null, episode: null, title: '' };
    // A tab that has not loaded yet reports its URL (or nothing) as the title
    if (!original || /^https?:\/\//i.test(original) || /^about:/i.test(original)) return empty;

    const site = siteLabel(hostname);
    let segments = original.split(TITLE_SEPARATORS).map(s => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      const kept = segments
        .map(stripFillerEdges)
        .filter(s => s && !looksLikeSite(s, site));
      segments = kept.length > 0 ? kept : [stripFillerEdges(segments[0]) || segments[0]];
    } else {
      segments = [stripFillerEdges(segments[0] || original) || original];
    }
    let name = segments.join(' - ');

    // Bare site name or domain inside the remaining text ("Foo kisskh.co")
    if (site.length >= 4) {
      name = name.split(' ').filter(word => {
        const k = keyOf(word);
        return !(k === site || (k.length >= site.length && k.includes(site) && /\./.test(word)));
      }).join(' ');
    }

    let season = null;
    let episode = null;
    name = name.replace(/\bS(\d{1,2})\s*[._-]?\s*E(\d{1,4})\b/i, (m, s, e) => { season = +s; episode = +e; return ' '; });
    // Words for "season" / "episode" in a few languages. \b does not work next to non-ASCII
    // letters, hence the explicit lookarounds.
    const START = '(?<![\\p{L}\\p{N}])';
    const END = '(?![\\p{L}\\p{N}])';
    if (season === null) {
      const re = new RegExp(`${START}(?:season|series|сезон|temporada|saison|staffel)\\s*(\\d{1,2})${END}|第\\s*(\\d{1,2})\\s*[季期]`, 'iu');
      name = name.replace(re, (m, a, b) => { season = +(a || b); return ' '; });
    }
    if (episode === null) {
      const re = new RegExp(`${START}(?:episode|episodio|épisode|episódio|folge|capítulo|capitulo|серия|серия|эпизод|ep|eps)\\.?\\s*#?(\\d{1,4})${END}|第\\s*(\\d{1,4})\\s*[集话話回]`, 'iu');
      name = name.replace(re, (m, a, b) => { episode = +(a || b); return ' '; });
    }

    name = name
      .replace(/\(\s*\)|\[\s*\]/g, ' ')
      .replace(/\s+[-–—|:,]+\s+(?=[-–—|:,]|$)/g, ' ')
      .replace(/^[\s\-–—|:,.]+|[\s\-–—|:,]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    name = stripFillerEdges(name);

    if (!name) return empty;
    let tag = '';
    if (season !== null && episode !== null) tag = `S${padNum(season)}E${padNum(episode)}`;
    else if (episode !== null) tag = `E${padNum(episode)}`;
    else if (season !== null) tag = `S${padNum(season)}`;
    const title = (tag ? `${name} ${tag}` : name).slice(0, 120);
    return { name, season, episode, title };
  }

  // ─── Subtitle language / label ───────────────────────────────────────────────
  // Guesses { lang, label } from a subtitle URL: "Show.S01E02.en.srt", "subs_eng.vtt",
  // "English.srt", "?lang=pt-BR". Three-letter codes and names count anywhere in the file
  // name; two-letter codes only as the last part of it (or in a query parameter), because
  // "it", "no" or "to" are ordinary words too.

  const LANGUAGES = [
    ['en', 'English', ['eng', 'english']], ['es', 'Spanish', ['spa', 'spanish', 'espanol', 'español', 'castellano']],
    ['fr', 'French', ['fre', 'fra', 'french', 'francais', 'français']], ['de', 'German', ['ger', 'deu', 'german', 'deutsch']],
    ['it', 'Italian', ['ita', 'italian', 'italiano']], ['pt', 'Portuguese', ['por', 'portuguese', 'portugues', 'português']],
    ['ru', 'Russian', ['rus', 'russian']], ['ja', 'Japanese', ['jpn', 'japanese']], ['ko', 'Korean', ['kor', 'korean']],
    ['zh', 'Chinese', ['chi', 'zho', 'chinese', 'chs', 'cht']], ['ar', 'Arabic', ['ara', 'arabic']], ['hi', 'Hindi', ['hin', 'hindi']],
    ['bn', 'Bengali', ['ben', 'bengali', 'bangla']], ['id', 'Indonesian', ['ind', 'indonesian']], ['ms', 'Malay', ['may', 'msa', 'malay']],
    ['th', 'Thai', ['tha', 'thai']], ['vi', 'Vietnamese', ['vie', 'vietnamese']], ['tr', 'Turkish', ['tur', 'turkish']],
    ['pl', 'Polish', ['pol', 'polish']], ['nl', 'Dutch', ['dut', 'nld', 'dutch']], ['sv', 'Swedish', ['swe', 'swedish']],
    ['uk', 'Ukrainian', ['ukr', 'ukrainian']], ['fa', 'Persian', ['per', 'fas', 'persian', 'farsi']], ['he', 'Hebrew', ['heb', 'hebrew']],
    ['ur', 'Urdu', ['urd', 'urdu']], ['ta', 'Tamil', ['tam', 'tamil']], ['te', 'Telugu', ['tel', 'telugu']],
    ['tl', 'Filipino', ['fil', 'tgl', 'tagalog', 'filipino']], ['el', 'Greek', ['gre', 'ell', 'greek']], ['ro', 'Romanian', ['rum', 'ron', 'romanian']],
    ['hu', 'Hungarian', ['hun', 'hungarian']], ['cs', 'Czech', ['cze', 'ces', 'czech']], ['da', 'Danish', ['dan', 'danish']],
    ['fi', 'Finnish', ['fin', 'finnish']], ['nb', 'Norwegian', ['nor', 'nob', 'norwegian']]
  ];
  const LANG_BY_CODE = new Map(LANGUAGES.map(([code, name]) => [code, name]));
  const LANG_BY_WORD = new Map();
  for (const [code, , words] of LANGUAGES) for (const w of words) LANG_BY_WORD.set(w, code);

  function langFromCode(raw) {
    const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}|\d{3}|[a-z]{4}))?$/i.exec(String(raw || '').trim());
    if (!m) return null;
    const base = m[1].toLowerCase();
    const code = LANG_BY_CODE.has(base) ? base : LANG_BY_WORD.get(base);
    if (!code) return null;
    return m[2] ? `${code}-${m[2].length === 2 ? m[2].toUpperCase() : m[2]}` : code;
  }

  function langName(code) {
    const base = String(code).split('-')[0];
    const name = LANG_BY_CODE.get(base);
    if (!name) return '';
    const region = String(code).split('-')[1];
    return region ? `${name} (${region})` : name;
  }

  function describeSubtitle(url, label = '', lang = '') {
    let fileName = '';
    let params = null;
    try {
      const u = new URL(url);
      params = u.searchParams;
      fileName = decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch (e) {
      fileName = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
    }

    let code = langFromCode(lang) || (lang ? String(lang) : '');
    if (!code && params) {
      for (const key of ['lang', 'language', 'srclang', 'tlang', 'hl', 'lan']) {
        const found = langFromCode(params.get(key));
        if (found) { code = found; break; }
      }
    }
    if (!code) {
      const stem = fileName.replace(/\.(vtt|srt|ass|ssa|ttml|dfxp|xml|sub)$/i, '');
      const tokens = stem.split(/[._\s\-\[\]()]+/).filter(Boolean);
      // The "name.en.srt" convention: the part after the last dot (or the whole name, "en.srt");
      // keeps "pt-BR" together. "do_it.srt" is not Italian.
      const last = stem.includes('.') ? stem.slice(stem.lastIndexOf('.') + 1) : stem;
      code = langFromCode(last) || '';
      if (!code) {
        for (let i = tokens.length - 1; i >= 0 && !code; i--) {
          const t = tokens[i].toLowerCase();
          if (t.length >= 3 && LANG_BY_WORD.has(t)) code = LANG_BY_WORD.get(t);
        }
      }
    }

    const nice = code ? langName(code) : '';
    let outLabel = String(label || '').trim();
    if (!outLabel) outLabel = nice || fileName || 'Subtitles';
    return { lang: code, label: outLabel };
  }

  root.StreamShared = {
    ANDROID_PLAYERS, formatDuration, buildAndroidIntent, launchAndroidIntent, shareToAndroid,
    parseDomainRule, matchesDomainRule, matchesDomainList, validateDomainList,
    parseCustomPatterns, compileCustomPatterns, matchCustomPattern,
    cleanPageTitle, levenshtein,
    describeSubtitle
  };
})(globalThis);
