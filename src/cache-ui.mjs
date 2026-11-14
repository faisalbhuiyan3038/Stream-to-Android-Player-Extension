// The whole-video download's badge on the player: progress while it downloads, then "Whole video
// loaded" with a Save button. Visible while paused and for a few seconds after the pointer moves
// or the screen is touched, so it does not sit on top of a film.

const MB = 1048576;
const size = n => n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= 10 * MB ? `${Math.round(n / MB)} MB` : `${(n / MB).toFixed(1)} MB`;

// onSave(mode): 'whole' or 'partial'. canSavePart(): whether "Loaded part" is offered.
// While the video is still loading, Save opens a choice: the whole video (saved as soon as it is
// loaded) or the part loaded so far. `pending` shows that a save is waiting for the download.
export function createCacheBadge(container, video, { onSave, canSavePart = () => true } = {}) {
  const el = document.createElement('div');
  el.className = 'sap-cache';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  const bar = document.createElement('span');
  bar.className = 'sap-cache-bar';
  const fill = document.createElement('span');
  bar.appendChild(fill);
  const button = (label, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    return b;
  };
  const save = button('Save', 'sap-save');
  const whole = button('Whole video', 'sap-save-whole');
  const part = button('Loaded part', 'sap-save-part');
  whole.hidden = true;
  part.hidden = true;
  el.append(text, bar, save, whole, part);
  container.appendChild(el);

  let last = null;
  let pending = false;
  let choosing = false;
  const showChoice = (on) => {
    choosing = on;
    whole.hidden = !on;
    part.hidden = !on || !canSavePart();
    save.textContent = on ? 'Cancel' : pending ? 'Cancel save' : 'Save';
    save.classList.toggle('sap-secondary', on || pending);
  };
  const fire = (mode, b) => {
    showChoice(false);
    if (onSave) onSave(mode, b);
  };
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    wake();
    if (choosing) return showChoice(false);
    if (pending) {
      api.pending = false;
      return;
    }
    if (last && last.complete) return fire('whole', save);
    showChoice(true);
  });
  whole.addEventListener('click', (e) => { e.stopPropagation(); fire('whole', whole); });
  part.addEventListener('click', (e) => { e.stopPropagation(); fire('partial', part); });

  let wakeUntil = Date.now() + 4000;
  const visible = () => !video || video.paused || pending || choosing || Date.now() < wakeUntil;
  const refresh = () => el.classList.toggle('sap-hidden', !visible());
  const wake = () => { wakeUntil = Date.now() + 3000; refresh(); };
  for (const ev of ['pointermove', 'pointerdown', 'touchstart', 'keydown']) container.addEventListener(ev, wake, { passive: true });
  if (video) for (const ev of ['play', 'pause']) video.addEventListener(ev, refresh);
  const timer = setInterval(refresh, 1000);

  const render = () => {
    const p = last;
    if (!p) return;
    const pct = p.total ? Math.floor(p.done / p.total * 100) : 0;
    fill.style.width = `${pct}%`;
    el.classList.toggle('complete', !!p.complete);
    if (p.complete) {
      text.textContent = `Whole video loaded · ${size(p.bytes)}`;
    } else if (pending) {
      text.textContent = `Saving when loaded · ${pct}%`;
    } else if (p.windowMode) {
      text.textContent = 'Loading ahead · storage limit reached';
    } else if (p.retrying) {
      text.textContent = `Loading ${pct}% · retrying…`;
    } else {
      const speed = p.speed > 0 ? ` · ${p.speed >= MB ? `${(p.speed / MB).toFixed(1)} MB/s` : `${Math.max(1, Math.round(p.speed / 1024))} KB/s`}` : '';
      text.textContent = `Loading whole video ${pct}%${speed}`;
    }
    el.dataset.state = p.complete ? 'complete' : pending ? 'pending' : p.windowMode ? 'window' : p.retrying ? 'retrying' : 'loading';
  };

  const api = {
    el,
    update(p) {
      last = p;
      render();
    },
    get progress() { return last; },
    get pending() { return pending; },
    set pending(on) {
      pending = !!on;
      showChoice(false);
      render();
      refresh();
    },
    message(m) { text.textContent = m; wake(); },
    destroy() { clearInterval(timer); el.remove(); }
  };
  return api;
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
