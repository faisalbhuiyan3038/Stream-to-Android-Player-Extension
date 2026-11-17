// The Audio control: one button in the player's control bar (next to Save) that opens a panel
// with the presets, volume boost, normalizer, dialogue boost, bass/treble and mono, plus a live
// readout of what the effects are doing. Works on src/audio-fx.mjs.
import { createPopover } from './player-popover.mjs';
import { resolveParams, NORMALIZER_NAMES, PRESET_NAMES } from './audio-dsp.mjs';
import { PRESET_ORDER } from './audio-fx.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const PRESET_HINTS = {
  off: 'No processing',
  standard: 'Evens out loud and quiet parts gently',
  cinema: 'Keeps the impact, softens the extremes, clearer voices',
  dialogue: 'Quiet voices lifted, loud scenes tamed',
  night: 'Strongest leveling for low-volume listening',
  music: 'Volume boost only'
};

function icon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path class="sap-audio-speaker" d="M8 15h4l5-4.5v15L12 21H8z"/>
    <path class="sap-audio-wave" d="M21 14.5a5 5 0 0 1 0 7M24 11.5a9 9 0 0 1 0 13"/>
    <circle class="sap-audio-dot" cx="28" cy="9" r="3"/>`;
  return svg;
}

const signed = (v, unit = ' dB') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 10) / 10)}${unit}`;

export function createAudioControl({ fx, menuHost = document.body }) {
  const el = document.createElement('div');
  el.className = 'sap-audio';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sap-audio-btn';
  btn.appendChild(icon());
  el.appendChild(btn);

  const pop = createPopover({
    owner: el, anchor: btn, menuHost, className: 'sap-audio-menu',
    onToggle: (open) => { fx.report(open); if (open) render(); }
  });
  const menu = pop.menu;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Audio effects');
  menu.innerHTML = `
    <div class="sap-audio-head"><strong>Audio</strong><span class="sap-audio-status" aria-live="polite"></span></div>
    <div class="sap-audio-presets" role="radiogroup" aria-label="Preset"></div>
    <p class="sap-audio-hint"></p>
    <label class="sap-audio-row"><span>Volume boost <output data-for="boost"></output></span>
      <input type="range" data-key="boost" min="100" max="200" step="5"></label>
    <label class="sap-audio-row"><span>Normalizer <output data-for="normalizer"></output></span>
      <input type="range" data-key="normalizer" min="0" max="4" step="1"></label>
    <label class="sap-audio-row"><span>Dialogue boost <output data-for="dialogue"></output></span>
      <input type="range" data-key="dialogue" min="0" max="12" step="1"></label>
    <label class="sap-audio-row"><span>Bass <output data-for="bass"></output></span>
      <input type="range" data-key="bass" min="-8" max="8" step="1"></label>
    <label class="sap-audio-row"><span>Treble <output data-for="treble"></output></span>
      <input type="range" data-key="treble" min="-8" max="8" step="1"></label>
    <label class="sap-audio-check"><input type="checkbox" data-key="mono"> Mono (one earbud)</label>`;
  const presets = menu.querySelector('.sap-audio-presets');
  for (const name of [...PRESET_ORDER, 'custom']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sap-audio-preset';
    b.dataset.preset = name;
    b.setAttribute('role', 'radio');
    b.textContent = PRESET_NAMES[name];
    b.addEventListener('click', () => {
      if (name === 'custom') fx.set({ preset: 'custom', custom: resolveParams(fx.settings) });
      else fx.setPreset(name);
    });
    presets.appendChild(b);
  }
  const status = menu.querySelector('.sap-audio-status');
  const hint = menu.querySelector('.sap-audio-hint');
  const inputs = Object.fromEntries([...menu.querySelectorAll('[data-key]')].map(i => [i.dataset.key, i]));
  const outputs = Object.fromEntries([...menu.querySelectorAll('output[data-for]')].map(o => [o.dataset.for, o]));

  // Moving a slider of the sound itself switches to Custom (starting from what is playing now)
  for (const [key, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => {
      if (key === 'boost') return fx.set({ boost: +input.value / 100 });
      if (key === 'mono') return fx.set({ mono: input.checked });
      const p = resolveParams(fx.settings);
      fx.set({ preset: 'custom', custom: { normalizer: p.normalizer, dialogue: p.dialogue, bass: p.bass, treble: p.treble, [key]: +input.value } });
    });
  }

  function describe(st) {
    if (st.mode === 'waiting') return 'Starts when you tap the video';
    if (st.mode === 'unreadable') return 'Starts once the file is loaded';
    if (st.mode === 'error') return 'Unavailable';
    if (!st.wanted) return '';
    const s = st.state;
    if (!s) return st.mode === 'active' ? 'On' : '';
    const bits = [];
    if (st.params.normalizer) bits.push(`Leveler ${signed(s.levelerDb + s.compressorDb)}`);
    if (s.limiterDb < -0.5) bits.push(`Limiter ${signed(s.limiterDb)}`);
    if (s.channels >= 6) bits.push('5.1 source');
    return bits.join(' · ') || 'On';
  }

  function render() {
    const st = fx.status();
    const p = st.params;
    el.dataset.active = st.wanted ? (st.active ? 'on' : 'pending') : 'off';
    const label = st.wanted ? `Audio: ${st.presetName}${p.boost > 1 ? ` · ${Math.round(p.boost * 100)}%` : ''}` : 'Audio effects';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (!pop.isOpen) return;
    for (const b of presets.children) {
      const on = b.dataset.preset === st.settings.preset;
      b.setAttribute('aria-checked', String(on));
      b.hidden = b.dataset.preset === 'custom' && !on;
    }
    hint.textContent = st.settings.preset === 'custom' ? 'Your own settings' : PRESET_HINTS[st.settings.preset] || '';
    status.textContent = describe(st);
    const active = document.activeElement;
    const setVal = (key, v) => { if (inputs[key] !== active) inputs[key].value = String(v); };
    setVal('boost', Math.round(p.boost * 100));
    setVal('normalizer', p.normalizer);
    setVal('dialogue', p.dialogue);
    setVal('bass', p.bass);
    setVal('treble', p.treble);
    inputs.mono.checked = p.mono;
    outputs.boost.textContent = `${Math.round(p.boost * 100)}%`;
    outputs.normalizer.textContent = NORMALIZER_NAMES[p.normalizer];
    outputs.dialogue.textContent = p.dialogue ? signed(p.dialogue) : 'Off';
    outputs.bass.textContent = signed(p.bass);
    outputs.treble.textContent = signed(p.treble);
    pop.place();
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.isOpen) pop.close();
    else pop.open();
  });
  const off = fx.subscribe(render);
  render();

  return {
    el,
    menu,
    render,
    open: () => pop.open(),
    close: () => pop.close(),
    destroy() {
      off();
      pop.destroy();
      el.remove();
    }
  };
}

// Keys: Shift+↑/↓ volume boost ±10 %, A cycles the presets. Captured before the players' own
// keys (Shift+arrows would otherwise also change the volume or seek).
export function attachAudioKeys(fx) {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fx.boostBy(e.key === 'ArrowUp' ? 0.1 : -0.1);
    } else if (!e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fx.cyclePreset();
    }
  }, true);
}
