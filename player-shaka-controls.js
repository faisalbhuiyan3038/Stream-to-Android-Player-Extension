// player-shaka-controls.js
// Vanilla controls for the Shaka Player page.
// Loaded as a deferred external script so no inline code is needed (CSP safe).

(function () {
  const video = document.getElementById('video');
  const controls = document.getElementById('controls');
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const progress = document.getElementById('progress');
  const timeEl = document.getElementById('time');
  const btnMute = document.getElementById('btn-mute');
  const iconVol = document.getElementById('icon-vol');
  const iconMute = document.getElementById('icon-mute');
  const volSlider = document.getElementById('volume-slider');
  const btnBack = document.getElementById('btn-back');
  const btnFwd = document.getElementById('btn-fwd');
  const btnFs = document.getElementById('btn-fs');
  const iconFsOn = document.getElementById('icon-fs-on');
  const iconFsOff = document.getElementById('icon-fs-off');

  // ── Auto-hide controls ────────────────────────────────────
  let hideTimer;
  function showControls() {
    controls.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused) controls.classList.remove('visible');
    }, 3000);
  }
  document.addEventListener('mousemove', showControls);
  document.addEventListener('touchstart', showControls);
  showControls(); // show on load

  // ── Click-to-play toggle ──────────────────────────────────
  video.addEventListener('click', () => {
    video.paused ? video.play() : video.pause();
  });

  // ── Time formatting ───────────────────────────────────────
  function fmt(s) {
    if (!isFinite(s)) return 'LIVE';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ── Progress bar ──────────────────────────────────────────
  video.addEventListener('timeupdate', () => {
    if (video.duration && isFinite(video.duration)) {
      progress.value = (video.currentTime / video.duration) * 100;
      timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    } else {
      timeEl.textContent = fmt(video.currentTime);
    }
  });

  progress.addEventListener('input', () => {
    if (video.duration && isFinite(video.duration)) {
      video.currentTime = (progress.value / 100) * video.duration;
    }
  });

  // ── Play / Pause ──────────────────────────────────────────
  function updatePlayState() {
    iconPlay.style.display = video.paused ? '' : 'none';
    iconPause.style.display = video.paused ? 'none' : '';
  }
  video.addEventListener('play', () => { updatePlayState(); showControls(); });
  video.addEventListener('pause', () => { updatePlayState(); controls.classList.add('visible'); });
  btnPlay.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });

  // ── Mute / Volume ─────────────────────────────────────────
  function updateMuteState() {
    iconVol.style.display = video.muted ? 'none' : '';
    iconMute.style.display = video.muted ? '' : 'none';
  }
  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    updateMuteState();
  });
  volSlider.addEventListener('input', () => {
    video.volume = volSlider.value;
    if (video.muted && volSlider.value > 0) {
      video.muted = false;
      updateMuteState();
    }
  });

  // ── Seek ──────────────────────────────────────────────────
  btnBack.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  btnFwd.addEventListener('click', () => { video.currentTime = video.currentTime + 10; });

  // ── Fullscreen ────────────────────────────────────────────
  function updateFsState() {
    const inFs = !!document.fullscreenElement;
    iconFsOn.style.display = inFs ? 'none' : '';
    iconFsOff.style.display = inFs ? '' : 'none';
  }
  btnFs.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', updateFsState);

  // ── Keyboard shortcuts ────────────────────────────────────
  document.addEventListener('keydown', e => {
    switch (e.key) {
      case ' ': case 'k': video.paused ? video.play() : video.pause(); e.preventDefault(); break;
      case 'ArrowLeft':  video.currentTime -= 10; break;
      case 'ArrowRight': video.currentTime += 10; break;
      case 'ArrowUp':    video.volume = Math.min(1, video.volume + 0.1); volSlider.value = video.volume; break;
      case 'ArrowDown':  video.volume = Math.max(0, video.volume - 0.1); volSlider.value = video.volume; break;
      case 'm': video.muted = !video.muted; updateMuteState(); break;
      case 'f': btnFs.click(); break;
    }
  });
})();
