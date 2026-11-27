// The Audio control: one button in the player's control bar (next to Save) that opens a panel
// with the presets, volume boost, normalizer, dialogue boost, bass/treble and mono, plus a live
// readout of what the effects are doing. Works on src/audio-fx.mjs; presets: src/audio-presets.mjs.
import { createPopover } from './player-popover.mjs';
import { NORMALIZER_NAMES } from './audio-dsp.mjs';
import {
  presetList, presetName, isUserPreset, isEditedBuiltin, editSound, savePreset, saveAsPreset,
  renamePreset, deletePreset, restoreDefault, nameProblem, suggestName, NAME_MAX
} from './audio-presets.mjs';

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

function hintFor(v) {
  const name = presetName(v, v.preset);
  if (v.preset === 'custom') return 'Your own settings · not saved';
  if (v.edits) return `Changed from ${name} · not saved`;
  if (isUserPreset(v.preset)) return 'Your preset';
  if (isEditedBuiltin(v, v.preset)) return `Your version of ${name}`;
  return PRESET_HINTS[v.preset] || '';
}

// The buttons under the presets for the current state: [action, label]
function actionsFor(v, confirmId) {
  const name = presetName(v, v.preset);
  if (v.preset === 'custom') return [['new', 'Save as preset…']];
  if (v.edits) return [['save', `Save to “${name}”`], ['new', 'Save as new…'], ['reset', 'Reset']];
  if (isUserPreset(v.preset)) return [['rename', 'Rename'], ['delete', confirmId === v.preset ? `Delete “${name}”?` : 'Delete']];
  if (isEditedBuiltin(v, v.preset)) return [['restore', 'Restore default']];
  return [];
}

// The panel itself (presets, sliders, status): inside a player's popover, or inline in the
// toolbar popup (src/popup-audio.js, whose `fx` follows the current tab).
// `st.text` in a status overrides the status line.
// Moving a sound slider keeps the preset selected with a "*" (not saved); the user then saves it
// into that preset, saves it as a new one, or resets it.
export function createAudioPanel(menu, { fx, unreadableText = 'Starts once the file is loaded' }) {
  menu.setAttribute('aria-label', 'Audio effects');
  menu.innerHTML = `
    <div class="sap-audio-head"><strong>Audio</strong><span class="sap-audio-status" aria-live="polite"></span></div>
    <div class="sap-audio-presets" role="radiogroup" aria-label="Preset"></div>
    <p class="sap-audio-hint" aria-live="polite"></p>
    <div class="sap-audio-actions" hidden></div>
    <div class="sap-audio-name" hidden>
      <div class="sap-audio-name-row">
        <input type="text" class="sap-audio-name-input" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" enterkeyhint="done" aria-label="Preset name">
        <button type="button" class="sap-audio-act sap-audio-primary" data-act="name-ok">Save</button>
        <button type="button" class="sap-audio-act" data-act="name-cancel">Cancel</button>
      </div>
      <p class="sap-audio-error" aria-live="assertive"></p>
    </div>
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
  const status = menu.querySelector('.sap-audio-status');
  const hint = menu.querySelector('.sap-audio-hint');
  const actions = menu.querySelector('.sap-audio-actions');
  const nameBox = menu.querySelector('.sap-audio-name');
  const nameInput = menu.querySelector('.sap-audio-name-input');
  const nameOk = menu.querySelector('[data-act="name-ok"]');
  const nameError = menu.querySelector('.sap-audio-error');
  const inputs = Object.fromEntries([...menu.querySelectorAll('[data-key]')].map(i => [i.dataset.key, i]));
  const outputs = Object.fromEntries([...menu.querySelectorAll('output[data-for]')].map(o => [o.dataset.for, o]));

  let chipsKey = '';
  let actionsKey = '';
  let form = null; // { mode: 'new' | 'rename', id }: the name field is open
  let confirmId = null; // a user preset whose Delete was tapped once
  let confirmTimer = 0;

  const focusChip = (id) => { const b = presets.querySelector(`[data-preset="${CSS.escape(id)}"]`); if (b) b.focus(); };
  const focusAct = (act) => { const b = actions.querySelector(`[data-act="${act}"]`); if (b && !actions.hidden) { b.focus(); return true; } return false; };
  const change = (partial, focusId) => {
    fx.set(partial);
    render();
    if (focusId) focusChip(focusId);
  };

  function chip({ id, name }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sap-audio-preset';
    b.dataset.preset = id;
    b.dataset.name = name;
    b.title = name;
    b.setAttribute('role', 'radio');
    // the selected one again: nothing (unsaved changes are only dropped by Reset)
    b.addEventListener('click', () => {
      if (id === fx.settings.preset) return;
      closeForm();
      fx.setPreset(id);
      render();
    });
    return b;
  }

  // Moving a slider of the sound itself keeps the preset, marked as changed
  for (const [key, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => {
      if (key === 'boost') return fx.set({ boost: +input.value / 100 });
      if (key === 'mono') return fx.set({ mono: input.checked });
      fx.set(editSound(fx.settings, key, +input.value));
    });
  }

  actions.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const v = fx.settings;
    const act = b.dataset.act;
    if (act === 'new' || act === 'rename') return openForm(act, v.preset);
    if (act === 'delete' && confirmId !== v.preset) {
      confirmId = v.preset;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmId = null; render(); }, 4000);
      return render();
    }
    confirmId = null;
    if (act === 'save') change(savePreset(v), v.preset);
    else if (act === 'reset') change({ edits: null }, v.preset);
    else if (act === 'restore') change(restoreDefault(v, v.preset), v.preset);
    else if (act === 'delete') change(deletePreset(v, v.preset), fx.settings.preset);
  });

  function showError(text) {
    nameError.textContent = text;
    nameInput.setAttribute('aria-invalid', String(!!text));
  }
  function openForm(mode, id) {
    form = { mode, id };
    nameOk.textContent = mode === 'rename' ? 'Rename' : 'Save';
    nameInput.value = mode === 'rename' ? presetName(fx.settings, id) : suggestName(fx.settings);
    showError('');
    render();
    nameInput.focus();
    nameInput.select();
  }
  function closeForm({ refocus = false } = {}) {
    if (!form) return;
    form = null;
    showError('');
    render();
    if (refocus && !focusAct('new')) focusAct('rename');
  }
  function submitForm() {
    if (!form) return;
    const v = fx.settings;
    const renaming = form.mode === 'rename';
    const problem = nameProblem(v, nameInput.value, renaming ? form.id : null);
    if (problem) {
      showError(problem);
      nameInput.focus();
      return;
    }
    const partial = renaming ? renamePreset(v, form.id, nameInput.value) : saveAsPreset(v, nameInput.value);
    const id = renaming ? form.id : partial.preset;
    form = null;
    showError('');
    change(partial, id);
  }
  nameInput.addEventListener('input', () => showError(''));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitForm();
    } else if (e.key === 'Escape') {
      // closes the name field only, not the whole panel
      e.preventDefault();
      e.stopPropagation();
      closeForm({ refocus: true });
    }
  });
  nameOk.addEventListener('click', () => submitForm());
  menu.querySelector('[data-act="name-cancel"]').addEventListener('click', () => closeForm({ refocus: true }));

  function describe(st) {
    if (st.text) return st.text;
    if (st.mode === 'waiting') return 'Starts when you tap the video';
    if (st.mode === 'unreadable') return unreadableText;
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

  function renderPresets(v) {
    const list = presetList(v);
    if (v.preset === 'custom') list.push({ id: 'custom', name: 'Custom' });
    // rebuilt only when the list changes (this runs a few times a second: keeps focus and hover)
    const key = JSON.stringify(list);
    if (key !== chipsKey) {
      chipsKey = key;
      presets.replaceChildren(...list.map(chip));
    }
    for (const b of presets.children) {
      const on = b.dataset.preset === v.preset;
      const changed = on && !!v.edits;
      b.setAttribute('aria-checked', String(on));
      b.dataset.changed = String(changed);
      b.textContent = b.dataset.name + (changed ? '*' : '');
      if (changed) b.setAttribute('aria-label', `${b.dataset.name} (changed, not saved)`);
      else b.removeAttribute('aria-label');
    }
  }

  function renderActions(v) {
    if (form && form.mode === 'rename' && !Object.prototype.hasOwnProperty.call(v.presets, form.id)) form = null; // deleted elsewhere
    if (confirmId && confirmId !== v.preset) confirmId = null;
    const list = form ? [] : actionsFor(v, confirmId);
    // rebuilt only when the set of buttons changes (a label change keeps focus)
    const key = list.map(a => a[0]).join();
    if (key !== actionsKey) {
      actionsKey = key;
      actions.replaceChildren(...list.map(([act]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `sap-audio-act${act === 'save' ? ' sap-audio-primary' : ''}`;
        b.dataset.act = act;
        return b;
      }));
    }
    list.forEach(([act, label], i) => {
      const b = actions.children[i];
      b.textContent = label;
      b.dataset.confirm = String(act === 'delete' && confirmId === v.preset);
    });
    actions.hidden = !list.length;
    nameBox.hidden = !form;
  }

  function render(st = fx.status()) {
    const p = st.params;
    renderPresets(st.settings);
    renderActions(st.settings);
    hint.textContent = hintFor(st.settings);
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
  }
  return { render };
}

// The players' control: a button in the control bar that opens the panel in a popover
export function createAudioControl({ fx, menuHost = document.body, unreadableText }) {
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
  const panel = createAudioPanel(menu, { fx, unreadableText });

  function render() {
    const st = fx.status();
    const p = st.params;
    el.dataset.active = st.wanted ? (st.active ? 'on' : 'pending') : 'off';
    const label = st.wanted ? `Audio: ${st.presetName}${p.boost > 1 ? ` · ${Math.round(p.boost * 100)}%` : ''}` : 'Audio effects';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (!pop.isOpen) return;
    panel.render(st);
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
