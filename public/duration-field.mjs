// @codedna
// description: Free song-length field (m:ss or seconds) with a menu of suggested lengths, shared by the composer and the lyrics assistant.
// 
//
// 
//
// 
//
// 
//
// 
//
// exports: bindDurationField
// used_by: sonora-studio/public/app.js
//                   sonora-studio/public/prompt-ui.mjs
// rules:   The value is only ever read through read(): null means invalid. Valid text is normalised to m:ss on change; limits are 0:10-5:00 like the server.
// agent:   claude-sonnet-5-5 - 2026-10-08 - Created: the duration was a fixed dropdown (could not set 2:30).
import { parseDuration, formatDuration } from './song-duration.mjs';

/**
 * Wire a text input and an optional preset select.
 * Rules: presets write the input and fire input+change, so existing form listeners keep working.
 */
export function bindDurationField(input, preset, onChange = () => {}) {
  const sync = () => {
    const valid = parseDuration(input.value) !== null;
    input.setCustomValidity(valid ? '' : 'Enter a duration from 0:10 to 5:00, for example 2:30.');
    input.toggleAttribute('aria-invalid', !valid);
  };
  input.addEventListener('input', () => {
    sync();
    onChange();
  });
  input.addEventListener('change', () => {
    const seconds = parseDuration(input.value);
    if (seconds !== null) input.value = formatDuration(seconds);
    sync();
    onChange();
  });
  input.addEventListener('focus', () => input.select());
  preset?.addEventListener('change', () => {
    if (preset.value) {
      input.value = preset.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    preset.selectedIndex = 0;
  });
  const initial = parseDuration(input.value);
  if (initial !== null) input.value = formatDuration(initial);
  sync();
  return {
    read: () => parseDuration(input.value),
    write(seconds) {
      input.value = formatDuration(seconds);
      sync();
    },
  };
}
