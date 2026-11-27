// The whole-video download's control: one button in the player's own control bar (so it fades
// with the other controls and never sits on the picture). A thin ring around the icon fills as
// the video loads and it shows a tick when everything is in. Tapping it saves (when complete) or
// opens a small menu with the status and the choices: the whole video (saved as soon as it is
// loaded) or the part loaded so far. Once saved, a tap opens the menu instead ("Save another
// copy"): every save writes the whole file again, and a few of a 2 GB video fill a disk.
//   onSave(mode, button): 'whole' | 'partial'. canSavePart(): whether "Loaded part" is offered.
//   menuHost: the element the menu is attached to (the one that goes fullscreen).

import { createPopover } from './player-popover.mjs';

const MB = 1048576;
const size = n => n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= 10 * MB ? `${Math.round(n / MB)} MB` : `${(n / MB).toFixed(1)} MB`;
const SVG = 'http://www.w3.org/2000/svg';
const RING = 2 * Math.PI * 16;

function icon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<circle class="sap-ring-bg" cx="18" cy="18" r="16"/>
    <circle class="sap-ring" cx="18" cy="18" r="16" transform="rotate(-90 18 18)" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/>
    <path class="sap-arrow" d="M18 10v11m-4.5-4.5L18 21l4.5-4.5M12 25h12"/>
    <path class="sap-tick" d="M12.5 18.5l3.8 3.8 7.2-8"/>`;
  return svg;
}

export function createSaveControl({ onSave, canSavePart = () => true, menuHost = document.body } = {}) {
  const el = document.createElement('div');
  el.className = 'sap-cache';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sap-save';
  btn.appendChild(icon());
  el.appendChild(btn);

  const pop = createPopover({ owner: el, anchor: btn, menuHost, className: 'sap-save-menu' });
  const menu = pop.menu;
  const status = document.createElement('p');
  status.className = 'sap-save-status';
  const mk = (label, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    return b;
  };
  const whole = mk('Save whole video', 'sap-save-whole');
  const part = mk('Save loaded part', 'sap-save-part');
  const cancel = mk('Don’t save', 'sap-save-cancel');
  menu.append(status, whole, part, cancel);

  let last = null;
  let pending = false;
  let saved = false;
  const pctOf = p => (p && p.total ? Math.floor(p.done / p.total * 100) : 0);
  const describe = () => {
    const p = last;
    if (!p) return 'Loading the whole video';
    const pct = pctOf(p);
    if (p.complete && saved) return `Saved · another copy needs ${size(p.bytes)} more space`;
    if (p.complete) return `Whole video loaded · ${size(p.bytes)} · tap to save`;
    if (pending) return `Will save when loaded · ${pct}%`;
    if (p.windowMode) return `Loading ahead · storage limit reached · ${pct}% kept`;
    const speed = p.speed > 0 ? ` · ${p.speed >= MB ? `${(p.speed / MB).toFixed(1)} MB/s` : `${Math.max(1, Math.round(p.speed / 1024))} KB/s`}` : '';
    return `Loading whole video ${pct}%${p.retrying ? ' · retrying' : speed}`;
  };

  const render = () => {
    const p = last || {};
    const pct = pctOf(p);
    el.querySelector('.sap-ring').setAttribute('stroke-dashoffset', String(RING * (1 - (p.complete ? 1 : pct / 100))));
    el.dataset.state = p.complete ? 'complete' : pending ? 'pending' : p.windowMode ? 'window' : p.retrying ? 'retrying' : 'loading';
    const text = describe();
    btn.title = text;
    btn.setAttribute('aria-label', text);
    status.textContent = text;
    whole.hidden = pending || (!!p.complete && !saved);
    whole.textContent = p.complete && saved ? 'Save another copy' : 'Save whole video';
    part.hidden = pending || !!p.complete || !canSavePart();
    cancel.hidden = !pending;
    if (!menu.hidden) pop.place();
  };
  const close = () => pop.close();
  const open = () => {
    render();
    pop.open();
  };
  const fire = (mode, b) => {
    close();
    if (onSave) onSave(mode, b);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    if (last && last.complete && !saved) return fire('whole', btn);
    open();
  });
  whole.addEventListener('click', (e) => { e.stopPropagation(); fire('whole', whole); });
  part.addEventListener('click', (e) => { e.stopPropagation(); fire('partial', part); });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); api.pending = false; close(); });

  const api = {
    el,
    menu,
    update(p) {
      last = p;
      render();
    },
    get progress() { return last; },
    get pending() { return pending; },
    // the whole video was saved once (attachSaver sets it)
    get saved() { return saved; },
    set saved(on) {
      saved = !!on;
      render();
    },
    set pending(on) {
      pending = !!on;
      render();
    },
    destroy() {
      pop.destroy();
      el.remove();
    }
  };
  render();
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
