// The audio settings (storage.local `audioFx`) and the preset library: the built-in presets, the
// user's edited versions of them and the presets they saved under their own names. Pure (no DOM),
// shared by the players, the popup, websites and the offscreen capture; tests/audio-presets.test.mjs.
//
//   { preset: 'cinema' | 'custom' | 'u…', boost: 1…2, mono,
//     edits: { normalizer, dialogue, bass, treble } | null,   unsaved changes of the preset ("Cinema*")
//     presets: { cinema: {…sound},                            "Save to Cinema" (built-in, edited)
//                u1k3x: { name: 'Late night', …sound } } }    the user's own, in creation order
//
// 'custom' = an unsaved sound with no preset behind it (sliders moved while Off: Off stays "no
// processing"). Boost and Mono belong to no preset. Every operation returns a partial for `fx.set`,
// which runs it through normalizeSettings: edits equal to the preset's sound are dropped (no "*"),
// a built-in saved back to its defaults is no longer "your version".
import { PRESETS, PRESET_NAMES, presetSound } from './audio-dsp.mjs';

export const PRESET_ORDER = ['off', 'standard', 'cinema', 'dialogue', 'night', 'music'];
export const SOUND_KEYS = ['normalizer', 'dialogue', 'bass', 'treble'];
export const NAME_MAX = 30;
export const AUDIO_DEFAULTS = { preset: 'off', boost: 1, mono: false, edits: null, presets: {} };

const RANGES = { normalizer: [0, 4], dialogue: [0, 12], bass: [-12, 12], treble: [-12, 12] };
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const isBuiltin = id => own(PRESETS, id);
export const isUserPreset = id => typeof id === 'string' && /^u[a-z0-9]{1,20}$/.test(id);

function cleanSound(o) {
  const out = {};
  for (const k of SOUND_KEYS) {
    const [lo, hi] = RANGES[k];
    const v = +(o && o[k]) || 0;
    out[k] = Math.min(hi, Math.max(lo, k === 'normalizer' ? Math.round(v) : v));
  }
  return out;
}
const sameSound = (a, b) => SOUND_KEYS.every(k => (+a[k] || 0) === (+b[k] || 0));
const cleanName = n => String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// Stored data is untrusted (older versions, other tabs, hand edits): rebuilt field by field
export function normalizeSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  const presets = {};
  if (src.presets && typeof src.presets === 'object') {
    for (const [id, p] of Object.entries(src.presets)) {
      if (!p || typeof p !== 'object') continue;
      if (isBuiltin(id) && id !== 'off') {
        const v = cleanSound(p);
        if (!sameSound(v, PRESETS[id])) presets[id] = v;
      } else if (isUserPreset(id)) {
        const name = cleanName(p.name);
        if (name) presets[id] = { name, ...cleanSound(p) };
      }
    }
  }
  let preset = typeof src.preset === 'string' ? src.preset : 'off';
  let edits = src.edits && typeof src.edits === 'object' ? cleanSound(src.edits) : null;
  // before 1.8 there was one Custom slot: { preset: 'custom', custom: {…} }
  if (preset === 'custom' && !edits && src.custom && typeof src.custom === 'object') edits = cleanSound(src.custom);
  if (preset !== 'custom' && !isBuiltin(preset) && !own(presets, preset)) preset = edits ? 'custom' : 'off'; // deleted elsewhere
  if (preset === 'off' && edits) preset = 'custom';
  if (preset === 'custom' && (!edits || sameSound(edits, PRESETS.off))) { preset = 'off'; edits = null; }
  if (edits && preset !== 'custom' && sameSound(edits, presetSound({ presets }, preset))) edits = null;
  return {
    preset,
    boost: Math.min(2, Math.max(1, Math.round((+src.boost || 1) * 100) / 100)),
    mono: !!src.mono,
    edits,
    presets
  };
}

// What is playing now (the preset with its unsaved changes)
export const currentSound = s => cleanSound(s.edits || presetSound(s, s.preset));

export function presetName(s, id) {
  if (isUserPreset(id) && own(s.presets, id)) return s.presets[id].name;
  return PRESET_NAMES[id] || id;
}
// "Cinema*" while it has unsaved changes ('custom' is always unsaved)
export const presetLabel = s => presetName(s, s.preset) + (s.edits ? '*' : '');
export const isEditedBuiltin = (s, id) => isBuiltin(id) && own(s.presets, id);

// Chips / menus: the built-ins, then the user's presets
export function presetList(s) {
  return [
    ...PRESET_ORDER.map(id => ({ id, name: PRESET_NAMES[id], user: false })),
    ...Object.keys(s.presets).filter(isUserPreset).map(id => ({ id, name: s.presets[id].name, user: true }))
  ];
}

export const selectPreset = id => ({ preset: id, edits: null });

// A sound slider moved: the preset stays selected, with the change unsaved ("Cinema*")
export function editSound(s, key, value) {
  return { preset: s.preset, edits: { ...currentSound(s), [key]: value } };
}

// Keep the changes in the selected preset (built-in: "your version", restorable)
export function savePreset(s) {
  if (!s.edits || s.preset === 'custom' || s.preset === 'off') return {};
  const keep = isUserPreset(s.preset) ? { name: s.presets[s.preset].name } : {};
  return { presets: { ...s.presets, [s.preset]: { ...keep, ...s.edits } }, edits: null };
}

// '' when the name can be used, else why not
export function nameProblem(s, name, exceptId = null) {
  const n = cleanName(name).toLowerCase();
  if (!n) return 'Enter a name';
  if (n === 'custom' || presetList(s).some(p => p.id !== exceptId && p.name.toLowerCase() === n)) return 'That name is already used';
  return '';
}

// A free name to start from: "Cinema 2", "My preset 1"
export function suggestName(s) {
  const base = s.preset === 'custom' || s.preset === 'off' ? 'My preset' : presetName(s, s.preset);
  for (let i = s.preset === 'custom' || s.preset === 'off' ? 1 : 2; ; i++) {
    const n = `${base.slice(0, NAME_MAX - 4)} ${i}`;
    if (!nameProblem(s, n)) return n;
  }
}

// What is playing now saved under a new name, and selected
export function saveAsPreset(s, name, id = newPresetId(s)) {
  return { presets: { ...s.presets, [id]: { name: cleanName(name), ...currentSound(s) } }, preset: id, edits: null };
}
export function newPresetId(s) {
  let id;
  do id = `u${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; while (own(s.presets, id));
  return id;
}

export function renamePreset(s, id, name) {
  if (!isUserPreset(id) || !own(s.presets, id)) return {};
  return { presets: { ...s.presets, [id]: { ...s.presets[id], name: cleanName(name) } } };
}

// The selected one deleted: its sound keeps playing as an unsaved Custom (no sudden change)
export function deletePreset(s, id) {
  const presets = { ...s.presets };
  delete presets[id];
  return s.preset === id ? { presets, preset: 'custom', edits: currentSound(s) } : { presets };
}

export function restoreDefault(s, id) {
  const presets = { ...s.presets };
  delete presets[id];
  return s.preset === id ? { presets, edits: null } : { presets };
}

// The A key / Alt+Shift+A: built-ins, then the user's presets
export function nextPreset(s) {
  const ids = presetList(s).map(p => p.id);
  return ids[(ids.indexOf(s.preset) + 1) % ids.length];
}
