// The whole-video download's badge on the player: progress while it downloads, then "Whole video
// loaded" with a Save button. Visible while paused and for a few seconds after the pointer moves
// or the screen is touched, so it does not sit on top of a film.

const MB = 1048576;
const size = n => n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= 10 * MB ? `${Math.round(n / MB)} MB` : `${(n / MB).toFixed(1)} MB`;

export function createCacheBadge(container, video, { onSave } = {}) {
  const el = document.createElement('div');
  el.className = 'sap-cache';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  const bar = document.createElement('span');
  bar.className = 'sap-cache-bar';
  const fill = document.createElement('span');
  bar.appendChild(fill);
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  save.hidden = true;
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onSave) onSave(save);
  });
  el.append(text, bar, save);
  container.appendChild(el);

  let wakeUntil = Date.now() + 4000;
  let last = null;
  const visible = () => !video || video.paused || Date.now() < wakeUntil;
  const refresh = () => el.classList.toggle('sap-hidden', !visible());
  const wake = () => { wakeUntil = Date.now() + 3000; refresh(); };
  for (const ev of ['pointermove', 'pointerdown', 'touchstart', 'keydown']) container.addEventListener(ev, wake, { passive: true });
  if (video) for (const ev of ['play', 'pause']) video.addEventListener(ev, refresh);
  const timer = setInterval(refresh, 1000);

  return {
    el,
    update(p) {
      last = p;
      const pct = p.total ? Math.floor(p.done / p.total * 100) : 0;
      fill.style.width = `${pct}%`;
      el.classList.toggle('complete', !!p.complete);
      save.hidden = !p.complete;
      if (p.complete) {
        text.textContent = `Whole video loaded · ${size(p.bytes)}`;
      } else if (p.windowMode) {
        text.textContent = `Loading ahead · storage limit reached`;
      } else if (p.retrying) {
        text.textContent = `Loading ${pct}% · retrying…`;
      } else {
        const speed = p.speed > 0 ? ` · ${(p.speed / MB).toFixed(1)} MB/s` : '';
        text.textContent = `Loading whole video ${pct}%${speed}`;
      }
      el.dataset.state = p.complete ? 'complete' : p.windowMode ? 'window' : p.retrying ? 'retrying' : 'loading';
    },
    get progress() { return last; },
    message(m) { text.textContent = m; wake(); },
    destroy() { clearInterval(timer); el.remove(); }
  };
}

// Calls fn at most once per `ms` (and once more at the end of a burst)
export function throttle(fn, ms) {
  let t = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - t >= ms) {
      t = now;
      fn(...args);
    } else if (!pending) {
      pending = setTimeout(() => { pending = null; t = Date.now(); fn(...args); }, ms - (now - t));
    }
  };
}
