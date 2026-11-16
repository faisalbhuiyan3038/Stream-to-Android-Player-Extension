// Added to the extension pages of the staged copy by firefox-audit.js only (never packaged).
// Firefox's WebDriver can neither script nor screenshot extension pages, so this reports the
// layout through document.title, which the audit reads from the browser's chrome context.
(function () {
  const probe = () => {
    const out = { vw: innerWidth, vh: innerHeight };
    const cues = [...document.querySelectorAll('.shaka-text-container span, .art-subtitle > *, media-captions [part~="cue"], [data-part="cue"]')]
      .filter(e => e.textContent.trim() && e.getBoundingClientRect().height > 0 && !e.querySelector('span'));
    out.cues = cues.slice(0, 3).map(e => ({ text: e.textContent.trim().slice(0, 24), font: getComputedStyle(e).fontSize, h: Math.round(e.getBoundingClientRect().height) }));
    const tc = document.querySelector('.shaka-text-container');
    if (tc) out.shakaTextFont = getComputedStyle(tc).fontSize;
    const v = document.querySelector('video');
    if (v) out.video = { t: +v.currentTime.toFixed(1), tracks: [...v.textTracks].map(t => `${t.label}:${t.mode}:${t.cues ? t.cues.length : '-'}`) };
    if (document.querySelector('.popup-container')) {
      out.scrollWidth = document.documentElement.scrollWidth;
      out.bodyWidth = getComputedStyle(document.body).width;
    }
    return out;
  };
  const report = () => { try { document.title = 'AUDIT ' + JSON.stringify(probe()); } catch (e) { document.title = 'AUDIT ' + JSON.stringify({ error: String(e) }); } };
  setInterval(report, 1000);
})();
