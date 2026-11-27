// Audio settings model and preset library (src/audio-presets.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, presetList, presetLabel, currentSound, selectPreset, editSound, savePreset,
  saveAsPreset, renamePreset, deletePreset, restoreDefault, nameProblem, suggestName, nextPreset
} from '../src/audio-presets.mjs';
import { resolveParams, PRESETS } from '../src/audio-dsp.mjs';

// what fx.set does with an operation's partial
const apply = (s, partial) => normalizeSettings({ ...s, ...partial });
const cinema = normalizeSettings({ preset: 'cinema' });

test('a moved slider keeps the preset selected, marked "*"; moving it back clears the mark', () => {
  const s = apply(cinema, editSound(cinema, 'bass', 5));
  assert.equal(s.preset, 'cinema');
  assert.deepEqual(s.edits, { ...PRESETS.cinema, bass: 5 });
  assert.equal(presetLabel(s), 'Cinema*');
  assert.equal(resolveParams(s).bass, 5);
  const back = apply(s, editSound(s, 'bass', PRESETS.cinema.bass));
  assert.equal(back.edits, null);
  assert.equal(presetLabel(back), 'Cinema');
});

test('Off stays "no processing": a slider moved while Off gives an unsaved Custom; flat again → Off', () => {
  const off = normalizeSettings();
  const s = apply(off, editSound(off, 'dialogue', 4));
  assert.equal(s.preset, 'custom');
  assert.equal(presetLabel(s), 'Custom*');
  assert.equal(resolveParams(s).dialogue, 4);
  assert.equal(apply(s, editSound(s, 'dialogue', 0)).preset, 'off');
});

test('Save to a built-in keeps "your version"; Restore default and saving the defaults remove it', () => {
  let s = apply(cinema, editSound(cinema, 'treble', -2));
  s = apply(s, savePreset(s));
  assert.equal(s.edits, null);
  assert.equal(presetLabel(s), 'Cinema');
  assert.equal(resolveParams(s).treble, -2);
  assert.equal(resolveParams({ ...s, preset: 'off' }).treble, 0);
  // another preset, then back: the saved version is used
  s = apply(s, selectPreset('night'));
  s = apply(s, selectPreset('cinema'));
  assert.equal(resolveParams(s).treble, -2);
  assert.equal(apply(s, restoreDefault(s, 'cinema')).presets.cinema, undefined);
  assert.equal(resolveParams(apply(s, restoreDefault(s, 'cinema'))).treble, PRESETS.cinema.treble);
  const same = apply(s, editSound(s, 'treble', PRESETS.cinema.treble));
  assert.equal(apply(same, savePreset(same)).presets.cinema, undefined);
});

test('Save as new: named, selected, listed after the built-ins; the original preset is untouched', () => {
  let s = apply(cinema, editSound(cinema, 'bass', 6));
  assert.equal(suggestName(s), 'Cinema 2');
  s = apply(s, saveAsPreset(s, '  Late   night ', 'u1'));
  assert.equal(s.preset, 'u1');
  assert.equal(s.edits, null);
  assert.deepEqual(s.presets.u1, { name: 'Late night', ...PRESETS.cinema, bass: 6 });
  assert.equal(presetLabel(s), 'Late night');
  assert.equal(resolveParams({ ...s, preset: 'cinema' }).bass, PRESETS.cinema.bass);
  assert.deepEqual(presetList(s).map(p => p.id), ['off', 'standard', 'cinema', 'dialogue', 'night', 'music', 'u1']);
  // a user preset edited and saved keeps its name
  const e = apply(s, editSound(s, 'dialogue', 9));
  assert.equal(presetLabel(e), 'Late night*');
  assert.deepEqual(apply(e, savePreset(e)).presets.u1, { name: 'Late night', ...PRESETS.cinema, bass: 6, dialogue: 9 });
  // unsaved Custom from Off suggests a generic name
  assert.equal(suggestName(normalizeSettings({ preset: 'custom', edits: { bass: 1 } })), 'My preset 1');
});

test('names: empty, taken (built-in, own, "Custom"; any case) refused; renaming to its own name is fine', () => {
  const s = apply(cinema, saveAsPreset(cinema, 'Late night', 'u1'));
  assert.equal(nameProblem(s, '   '), 'Enter a name');
  assert.equal(nameProblem(s, 'cinema'), 'That name is already used');
  assert.equal(nameProblem(s, 'LATE NIGHT'), 'That name is already used');
  assert.equal(nameProblem(s, 'custom'), 'That name is already used');
  assert.equal(nameProblem(s, 'late night', 'u1'), '');
  assert.equal(nameProblem(s, 'Movies'), '');
  assert.equal(apply(s, renamePreset(s, 'u1', 'Movies')).presets.u1.name, 'Movies');
  assert.equal(apply(s, saveAsPreset(s, 'x'.repeat(80), 'u2')).presets.u2.name.length, 30);
});

test('deleting the selected preset keeps its sound playing as an unsaved Custom', () => {
  let s = apply(cinema, editSound(cinema, 'bass', 6));
  s = apply(s, saveAsPreset(s, 'Mine', 'u1'));
  const d = apply(s, deletePreset(s, 'u1'));
  assert.equal(d.presets.u1, undefined);
  assert.equal(d.preset, 'custom');
  assert.deepEqual(resolveParams(d), resolveParams(s));
  // another one deleted: the selection stays
  const other = apply({ ...s, preset: 'night' }, deletePreset({ ...s, preset: 'night' }, 'u1'));
  assert.equal(other.preset, 'night');
});

test('cycling goes through the built-ins, then the user presets, then back to Off', () => {
  const s = apply(cinema, saveAsPreset(cinema, 'Mine', 'u1'));
  assert.equal(nextPreset({ ...s, preset: 'music' }), 'u1');
  assert.equal(nextPreset({ ...s, preset: 'u1' }), 'off');
  assert.equal(nextPreset({ ...s, preset: 'custom' }), 'off');
});

test('stored data: the old single Custom slot migrates; bad values are dropped or clamped', () => {
  const old = normalizeSettings({ preset: 'custom', boost: 1.5, custom: { normalizer: 2, dialogue: 3, bass: 0, treble: 0 } });
  assert.equal(old.preset, 'custom');
  assert.deepEqual(old.edits, { normalizer: 2, dialogue: 3, bass: 0, treble: 0 });
  assert.equal(old.custom, undefined);
  // the background passes raw stored settings to the offscreen capture: still resolved
  assert.equal(resolveParams({ preset: 'custom', custom: { dialogue: 5 } }).dialogue, 5);
  // a legacy record with only the default custom slot and another preset: no stray edits
  assert.equal(normalizeSettings({ preset: 'night', custom: { normalizer: 2, dialogue: 3, bass: 0, treble: 0 } }).edits, null);

  const bad = normalizeSettings({
    preset: 'u9',
    boost: 9,
    edits: 'x',
    presets: {
      toString: { bass: 1 }, off: { bass: 3 }, cinema: { ...PRESETS.cinema },
      u1: { name: '', bass: 1 }, u2: { name: 'Ok', normalizer: 7.6, dialogue: 99, bass: -50, treble: 'loud' },
      'u-x': { name: 'Bad id' }, u3: null
    }
  });
  assert.equal(bad.preset, 'off'); // the selected preset no longer exists
  assert.equal(bad.boost, 2);
  assert.equal(bad.edits, null);
  assert.deepEqual(Object.keys(bad.presets), ['u2']);
  assert.deepEqual(bad.presets.u2, { name: 'Ok', normalizer: 4, dialogue: 12, bass: -12, treble: 0 });
  // a deleted preset that still had unsaved changes keeps them as Custom
  assert.equal(normalizeSettings({ preset: 'u9', edits: { bass: 2 } }).preset, 'custom');
  assert.equal(resolveParams({ preset: 'toString' }).normalizer, 0);
  assert.deepEqual(currentSound(normalizeSettings()), PRESETS.off);
});
