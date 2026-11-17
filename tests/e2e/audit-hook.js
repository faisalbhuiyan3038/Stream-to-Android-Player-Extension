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
    if (want) out.audio = audio || 'pending';
    if (document.querySelector('.popup-container')) {
      out.scrollWidth = document.documentElement.scrollWidth;
      out.bodyWidth = getComputedStyle(document.body).width;
    }
    return out;
  };
  // ?audit_audio=<preset>: switch the audio effects on, then measure them (Firefox's extension
  // pages cannot be scripted, so this is how the audit checks that the audio path works there)
  const want = new URLSearchParams(location.search).get('audit_audio');
  let audio = null;
  if (want) {
    const run = async () => {
      if (!window._audioFx) return setTimeout(run, 300);
      const m = document.querySelector('video, audio');
      window._audioFx.report(true);
      await window._audioFx.set({ preset: want, boost: want === 'music' ? 2 : 1 });
      if (m) { m.currentTime = 0; m.play().catch(() => {}); }
      await new Promise(r => setTimeout(r, 1500));
      const loud = await window._audioFx.measure(1000);
      if (m && m.duration > 10) m.currentTime = 5;
      await new Promise(r => setTimeout(r, 4000));
      const quiet = await window._audioFx.measure(1500);
      const db = x => Math.round(20 * Math.log10(x + 1e-9) * 10) / 10;
      const st = window._audioFx.status();
      audio = {
        mode: st.mode, preset: st.settings.preset, boost: st.settings.boost, ctx: st.contextState, fx: st.state, crossOrigin: m && m.crossOrigin, channels: st.state && st.state.channels,
        loud: loud && { in: db(loud.in.rms), out: db(loud.out.rms), peak: Math.round(loud.out.peak * 1000) / 1000 },
        quiet: quiet && { in: db(quiet.in.rms), out: db(quiet.out.rms) },
        status: (document.querySelector('.sap-audio-status') || {}).textContent
      };
    };
    run();
  }
  const report = () => { try { document.title = 'AUDIT ' + JSON.stringify(probe()); } catch (e) { document.title = 'AUDIT ' + JSON.stringify({ error: String(e) }); } };
  setInterval(report, 1000);
})();
