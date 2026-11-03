// @codedna
// description: The YuE2 part of "Crea musica": write the melody-and-chords plan, see and hear it, change chords (picker and genre progressions), then sing the song from that plan.
//
// exports: initYue2Ui
// used_by: public/app.js
// rules:   The ABC text in #yue-abc is the single source of truth; the chord grid, the picker and the progressions only rewrite chord symbols through abc-plan.mjs, and the structure tools (shorter parts, tempo, instrument that follows the chords, per-part text) go through abc-edit.mjs. A plan is bound to the lyrics it was made for: if the lyrics change, generating is blocked until the plan is remade or discarded. Sound is created only after a click (browser autoplay rules).
// agent:   Codex | OpenAI | 2026-11-03 | Simplified chord-first composition, local sampling freedom and draft controls.
//          claude-haiku-5-5 | anthropic | 2026-11-03 | One mode switch (Decide Yue2 / Scelgo gli accordi / Uso una melodia); variety left out when a plan is sent; "Crea un nuovo piano" asks before replacing.
//          claude-sonnet-5-5 | anthropic | 2026-10-11 | s_20261011_yue2 | Created for YuE2 (plan, chord grid, ABC text, reuse of a finished song's plan); piano roll, playback, chord picker and genre progressions added after the first user test. 2026-10-12: structure, tempo, instrument and per-part ABC editing added.
//          Codex | OpenAI | 2026-10-15 | Cover lyric blocks and estimated syllable counts beside vocal sections.
//          Codex | OpenAI | 2026-10-15 | Space pauses and resumes the score while its vertical note-follow remains enabled.
import { parsePlan, setChord, isChord, planSummary, chordsOnly } from './abc-plan.mjs';
import { parseScore, drawRoll, playScore, chordMidis } from './abc-play.mjs';
import {
  QUALITIES,
  ROOTS,
  PRESETS,
  composeChord,
  progressionChords,
  applyProgression,
} from './chord-presets.mjs';
import { BED_KEYS, writeBed } from './chord-bed.mjs';
import { parseDuration } from './song-duration.mjs';
import { planToMidi, readMidi, midiToPlan } from './midi-io.mjs';
import { renderScore, followScore } from './score-view.mjs';
import { coverSectionFit, alignCoverLyrics } from './cover-lyrics.mjs';
import {
  INSTRUMENT_STYLES,
  sectionStats,
  trimSection,
  setTempo,
  revoiceInstrument,
  sectionSlices,
  readPart,
  editBar,
  changeItems,
  noteName,
  durationLabel,
  transposeScore,
  locateNote,
} from './abc-edit.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LABELS = {
  intro: 'Intro',
  verse: 'Verse',
  'pre-chorus': 'Pre-chorus',
  chorus: 'Chorus',
  bridge: 'Bridge',
  interlude: 'Interlude',
  outro: 'Outro',
};
const escape = value =>
  String(value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const same = (a, b) => String(a).trim().replace(/\r\n/g, '\n') === String(b).trim().replace(/\r\n/g, '\n');
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const sectionLabel = name => LABELS[name.toLowerCase()] || name;

/**
 * @param api        fetch helper that throws on errors
 * @param state      () => the app state
 * @param readFields () => { tags, lyrics, seed } from the create form
 * @param selectModel (value) => switch the music model on the server
 * @param applyInput (patch) => fill the create form
 */
export function initYue2Ui({ api, toast, state, readFields, selectModel, applyInput }) {
  let simpleDirty = true;
  let melodySupported = false;
  let planned = null; // the lyrics the current plan was made for
  let mode = 'new'; // 'new' (YuE2 writes the plan) or 'cover' (the plan comes from an existing song)
  let cover = null; // { id, title, seconds, chords } of the original song kept on the server
  let loraHosts = { local: false, runpod: false }; // where YuE2 LoRA can be used
  let loraEngineReady = true; // on RunPod: is yue2.cpp installed on the volume (from the last report)
  let loras = []; // the catalogue from /api/yue2/adapters
  const chosen = new Map(); // id -> { ar, nar } of the LoRA ticked for the next song
  let hosts = { runpod: false, local: false }; // where YuE2 can run: RunPod and/or this computer's GPU
  let audio = null; // { ctx, run, frame, from }
  let score = null;
  let roll = null;
  let startAt = 0;
  const active = () => state().health?.musicModel === 'yue2';
  /** 'local' when this PC is chosen (or the only option), otherwise 'runpod'. */
  const host = () =>
    hosts.local && (!hosts.runpod || $('#yue-host').value === 'local') ? 'local' : 'runpod';
  function paintHost() {
    const both = hosts.runpod && hosts.local;
    $('#yue-host-row').hidden = true;
    if (!both) $('#yue-host').value = hosts.local ? 'local' : 'runpod';
    $('#yue-host-hint').hidden = host() !== 'local';
    // Rules: LoRA only exist for yue2.cpp on this PC; on RunPod the list is hidden and nothing chosen is sent.
    $('#yue-lora').hidden = !loraHosts[host()];
    $('#yue-melody-freedom').disabled = !melodySupported || host() !== 'local';
    $('#yue-freedom-hint').textContent =
      melodySupported && host() === 'local'
        ? 'Controls how random the composition is, also between variants. The chosen chords stay in the plan; it is not an exact measure of similarity and the arrangement can change too.'
        : 'The melodic freedom control is available on this PC with yue2.cpp. The chosen chords and the number of variants also work on RunPod.';
  }

  /* ---------- LoRA (yue2.cpp on this PC) ---------- */
  const mb = bytes => `${Math.round(bytes / 1e6)} MB`;
  let loraTimer = null;
  async function loadLoras() {
    if (!loraHosts[host()]) return;
    try {
      const result = await api('/api/yue2/adapters?host=' + host());
      loras = result.adapters || [];
      loraEngineReady = host() !== 'runpod' || !!result.cpp;
    } catch {
      return;
    }
    for (const id of [...chosen.keys()]) if (!loras.some(a => a.id === id && a.installed)) chosen.delete(id);
    paintLoras();
    clearTimeout(loraTimer);
    if (loras.some(a => a.downloading)) loraTimer = setTimeout(loadLoras, 1500);
  }
  function strengthInput(a, half, value) {
    const label = half === 'ar' ? 'Composition' : 'Sound';
    const shown = Math.round(value * 100) / 100;
    return `<label class="yue-lora-strength">${label}<input type="range" min="-2" max="2" step="0.05" value="${value}" data-lora-strength="${half}" data-id="${a.id}" aria-label="Strength on ${label.toLowerCase()}, ${escape(a.name)}"><output>${shown}</output></label>`;
  }
  function paintLoras() {
    const groups = [...new Set(loras.map(a => a.kind))];
    $('#yue-lora-count').textContent =
      `${host() === 'runpod' ? '· on RunPod' : '· on this PC'}${chosen.size ? ` · ${chosen.size} in use` : ''}`;
    const note = !loraEngineReady
      ? '<p class="field-hint">On RunPod the LoRAs need the new engine (yue2.cpp), which is not installed yet. You can already install them: they will work as soon as the engine is ready.</p>'
      : host() === 'runpod'
        ? '<p class="field-hint">On RunPod the installation starts the GPU for about a minute.</p>'
        : '';
    $('#yue-lora-list').innerHTML =
      note +
      groups
        .map(
          kind =>
            `<div class="yue-lora-group"><strong>${escape(kind)}</strong>${loras
              .filter(a => a.kind === kind)
              .sort((x, y) => Number(y.installed) - Number(x.installed))
              .map(a => {
                const use = chosen.get(a.id);
                const action = a.installed
                  ? `<label class="yue-check"><input type="checkbox" data-lora-use="${a.id}"${use ? ' checked' : ''}><span>Use</span></label>${a.trained ? '' : `<button type="button" class="text-button" data-lora-remove="${a.id}">Remove</button>`}`
                  : a.downloading
                    ? `<span class="field-hint">Downloading… ${a.progress}%</span>`
                    : a.trained
                      ? '<span class="field-hint">File not available on the RunPod volume</span>'
                      : `<button type="button" class="pill-button" data-lora-install="${a.id}">Install · ${mb(a.bytes)}</button>${a.error ? `<span class="error">${escape(a.error)}</span>` : ''}`;
                const sliders = use
                  ? `<div class="yue-lora-sliders">${a.scales.ar || use.ar ? strengthInput(a, 'ar', use.ar) : ''}${a.scales.nar || use.nar ? strengthInput(a, 'nar', use.nar) : ''}</div>`
                  : '';
                return `<div class="yue-lora-row${use ? ' on' : ''}"><div class="yue-lora-head"><span><b>${escape(a.name)}</b> ${a.page ? `<a href="${escape(a.page)}" target="_blank" rel="noopener noreferrer" class="field-hint">by ${escape(a.author)}</a>` : `<span class="field-hint">by ${escape(a.author)}</span>`}${a.trigger ? ` <code title="Keyword: Sonora adds it by itself at the start of the style">${escape(a.trigger)}</code>` : ''}</span><span class="yue-lora-actions">${action}</span></div><p class="field-hint">${escape(a.description)}</p>${sliders}</div>`;
              })
              .join('')}</div>`
        )
        .join('');
  }
  $('#yue-lora').addEventListener('toggle', () => {
    if ($('#yue-lora').open) loadLoras();
  });
  $('#yue-lora-list').addEventListener('click', async event => {
    const install = event.target.closest('[data-lora-install]');
    const remove = event.target.closest('[data-lora-remove]');
    try {
      if (install) {
        install.disabled = true;
        if (host() === 'runpod') install.textContent = 'Installing on RunPod…';
        await api(`/api/yue2/adapters/${install.dataset.loraInstall}?host=${host()}`, 'POST', {});
        await loadLoras();
      }
      if (remove) {
        const a = loras.find(x => x.id === remove.dataset.loraRemove);
        if (!window.confirm(`Remove the LoRA «${a?.name}» from this PC? You can install it again.`)) return;
        chosen.delete(remove.dataset.loraRemove);
        await api(`/api/yue2/adapters/${remove.dataset.loraRemove}?host=${host()}`, 'DELETE');
        await loadLoras();
      }
    } catch (error) {
      toast(error.message);
      await loadLoras();
    }
  });
  $('#yue-lora-list').addEventListener('change', event => {
    const use = event.target.closest('[data-lora-use]');
    if (!use) return;
    const a = loras.find(x => x.id === use.dataset.loraUse);
    if (use.checked) {
      if (chosen.size >= 4) {
        use.checked = false;
        toast('Up to 4 LoRAs at a time.');
        return;
      }
      chosen.set(a.id, { ar: a.scales.ar, nar: a.scales.nar });
    } else chosen.delete(a.id);
    paintLoras();
  });
  $('#yue-lora-list').addEventListener('input', event => {
    const slider = event.target.closest('[data-lora-strength]');
    if (!slider) return;
    const use = chosen.get(slider.dataset.id);
    if (!use) return;
    use[slider.dataset.loraStrength] = Number(slider.value);
    slider.nextElementSibling.textContent = String(Math.round(Number(slider.value) * 100) / 100);
  });
  const abc = () => $('#yue-abc').value;
  const status = (message, failed = false) => {
    $('#yue-status').textContent = message;
    $('#yue-status').classList.toggle('error', failed);
  };

  /* ---------- sound ---------- */
  function context() {
    audio ||= {};
    audio.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return audio.ctx;
  }
  function stopPlayback() {
    followScore(null);
    if (audio?.run) audio.run.stop();
    if (audio) {
      audio.run = null;
      audio.pausedAt = null;
      cancelAnimationFrame(audio.frame);
    }
    $('#yue-play').textContent = '▶ Listen to the plan';
    $('#yue-play').hidden = false;
    $('#yue-stop').hidden = true;
    $('#yue-playhead').hidden = true;
  }
  function pausePlayback() {
    if (!audio?.run) return;
    audio.pausedAt = Math.min(score.seconds, audio.run.pause());
    audio.run = null;
    cancelAnimationFrame(audio.frame);
    $('#yue-play').textContent = '▶ Resume the plan';
    $('#yue-play').hidden = false;
    $('#yue-time').textContent = `${clock(audio.pausedAt)} / ${clock(score.seconds)} · paused`;
  }
  function resumePlayback() {
    if (audio?.pausedAt == null) return;
    const from = audio.pausedAt;
    audio.pausedAt = null;
    audio.run = playScore(score, { ctx: context(), from, onEnd: stopPlayback });
    $('#yue-play').hidden = true;
    audio.frame = requestAnimationFrame(frame);
  }
  function frame() {
    if (!audio?.run || !score || !roll) return;
    const position = audio.run.position();
    const x = position * roll.pxPerSecond;
    $('#yue-playhead').style.left = x + 'px';
    $('#yue-time').textContent = `${clock(position)} / ${clock(score.seconds)}`;
    const wrap = $('#yue-roll-wrap');
    if (x < wrap.scrollLeft || x > wrap.scrollLeft + wrap.clientWidth - 40)
      wrap.scrollLeft = Math.max(0, x - 60);
    // the score follows the music: the notes playing now light up and stay in view (in the big window, the window scrolls)
    if ($('#yue-score-box').open)
      followScore(position, $('#yue-big-dialog').open ? $('#yue-big-dialog') : document.scrollingElement);
    audio.frame = requestAnimationFrame(frame);
  }
  function play(from = startAt) {
    stopPlayback();
    score = parseScore(abc());
    if (!score.seconds) return status('The plan has no notes to listen to.', true);
    roll = drawRoll($('#yue-roll'), score, rollSize());
    const ctx = context();
    audio.run = playScore(score, { ctx, from, onEnd: stopPlayback });
    $('#yue-play').hidden = true;
    $('#yue-stop').hidden = false;
    $('#yue-playhead').hidden = false;
    audio.frame = requestAnimationFrame(frame);
  }
  function preview(symbol) {
    const voicing = chordMidis(symbol);
    if (!voicing) return;
    try {
      const ctx = context();
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      const notes = [...voicing.notes.map(n => n - 12), voicing.bass];
      notes.forEach((midi, index) => {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = index === notes.length - 1 ? 'sine' : 'triangle';
        osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
        const level = index === notes.length - 1 ? 0.14 : 0.07;
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(level, now + 0.03);
        env.gain.linearRampToValueAtTime(0, now + 1.1);
        osc.connect(env).connect(master);
        osc.start(now);
        osc.stop(now + 1.15);
      });
      setTimeout(() => master.disconnect(), 1400);
    } catch {
      /* no sound available: the chord is still changed */
    }
  }

  /* ---------- piano roll and chord grid ---------- */
  function repaint() {
    const text = abc();
    if (!text.trim()) {
      $('#yue-editor').hidden = true;
      $('#yue-chords').innerHTML = '';
      return;
    }
    $('#yue-editor').hidden = false;
    score = parseScore(text);
    roll = drawRoll($('#yue-roll'), score, rollSize());
    $('#yue-time').textContent = score.seconds ? `Plan length: about ${clock(score.seconds)}` : '';
    paintGrid();
    paintPresets();
    paintStructure();
    paintCoverFit();
    if (!keepPart) paintPartEditor();
    paintBars();
    paintScore();
  }
  /* ---------- the editor in a big window ---------- */
  // in the big window the piano roll is drawn larger, so notes and chords can be read
  function rollSize() {
    return document.body.classList.contains('yue-big-open') ? { pxPerSecond: 40, height: 320 } : {};
  }
  // Rules: the same elements move into the dialog and back (every listener keeps working); nothing is copied.
  function openBig() {
    const body = $('#yue-big-body');
    body.append($('#yue-editor'), $('#yue-picker'));
    $('#yue-big').hidden = true;
    $('#yue-big-dialog').showModal();
    document.body.classList.add('yue-big-open');
    requestAnimationFrame(() => {
      repaint();
      if (!$('#yue-score-box').open) $('#yue-score-box').open = true;
      paintScore();
    });
  }
  function closeBig() {
    closePicker();
    $('#yue-editor-home').after($('#yue-editor'));
    $('#yue-panel').append($('#yue-picker'));
    $('#yue-big').hidden = false;
    document.body.classList.remove('yue-big-open');
    if ($('#yue-big-dialog').open) $('#yue-big-dialog').close();
    requestAnimationFrame(() => {
      repaint();
      paintScore();
    });
  }
  $('#yue-big').addEventListener('click', openBig);
  $('#yue-big-close').addEventListener('click', closeBig);
  $('#yue-big-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    closeBig();
  });

  /* ---------- sheet music (abcjs) and MIDI ---------- */
  let scoreText = '';
  async function paintScore() {
    if (!$('#yue-score-box').open || !abc().trim()) return;
    try {
      scoreText = await renderScore($('#yue-score'), abc(), index => {
        const where = locateNote(scoreText, index);
        if (!where) return status('This note is changed in the ABC text.', true);
        // open the bar editor on the clicked note
        $('#yue-part').value = String(where.section + 1);
        showPart();
        selection = { voice: where.voice, bar: where.bar, item: where.item };
        $('#yue-bars-box').open = true;
        paintBars();
        const part = readPart(abc(), where.section);
        const found = selectedItem(part);
        if (found?.item.kind === 'note') tone(found.item.midi);
        $('#yue-note-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    } catch (error) {
      $('#yue-score').textContent = error.message;
    }
  }
  $('#yue-score-box').addEventListener('toggle', paintScore);
  $('#yue-midi-save').addEventListener('click', () => {
    try {
      const blob = new Blob([planToMidi(abc())], { type: 'audio/midi' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${($('#title').value || 'piano').trim().replace(/[\\/:*?"<>|]+/g, '-') || 'piano'}.mid`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    } catch (error) {
      status(error.message, true);
    }
  });
  let midiFile = null;
  $('#yue-midi-file').addEventListener('change', async () => {
    const file = $('#yue-midi-file').files[0];
    $('#yue-midi-file').value = '';
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('The MIDI file is too large (2 MB maximum).');
      midiFile = readMidi(new Uint8Array(await file.arrayBuffer()));
      const label = (t, i) =>
        `${i + 1}. ${t.name || 'Unnamed track'}${t.drums ? ' (drums)' : ''} · ${t.notes.length} notes`;
      const pitched = midiFile.tracks.map((t, i) => [t, i]).filter(([t]) => !t.drums);
      if (!pitched.length)
        throw new Error('The file has only drums: it needs at least one track with notes.');
      // the voice: a track named like one (voce, vocal, melody, lead…), else the most one-note-at-a-time track, higher pitch breaking ties;
      // the instrument: the busiest of the others
      const average = t => t.notes.reduce((sum, n) => sum + n.midi, 0) / t.notes.length;
      const together = t =>
        t.notes.filter((n, i) => i && n.tick < t.notes[i - 1].end).length / t.notes.length;
      const named = t => /voc|voce|voice|melod|lead|canto|sing|vox/i.test(t.name || '');
      const rank = t => (named(t) ? 100 : 0) - together(t) * 50 + average(t) / 10;
      const voice = [...pitched].sort((a, b) => rank(b[0]) - rank(a[0]))[0][1];
      const other =
        pitched
          .filter(([, i]) => i !== voice)
          .sort((a, b) => b[0].notes.length - a[0].notes.length)[0]?.[1] ?? -1;
      $('#yue-midi-vocal').innerHTML = pitched
        .map(([t, i]) => `<option value="${i}">${escape(label(t, i))}</option>`)
        .join('');
      $('#yue-midi-ins').innerHTML =
        '<option value="-1">None (YuE2 decides)</option>' +
        pitched.map(([t, i]) => `<option value="${i}">${escape(label(t, i))}</option>`).join('');
      $('#yue-midi-vocal').value = String(voice);
      $('#yue-midi-ins').value = String(other);
      $('#yue-midi-info').textContent =
        `${file.name}: ${midiFile.tracks.length} tracks, ${midiFile.bpm} beats per minute, ${midiFile.meter.join('/')}. Choose which track sings the voice.`;
      $('#yue-midi-import').hidden = false;
    } catch (error) {
      status(error.message, true);
    }
  });
  $('#yue-midi-cancel').addEventListener('click', () => {
    midiFile = null;
    $('#yue-midi-import').hidden = true;
  });
  $('#yue-midi-apply').addEventListener('click', () => {
    if (!midiFile) return;
    try {
      const plan = midiToPlan(midiFile, {
        vocal: Number($('#yue-midi-vocal').value),
        instrument: Number($('#yue-midi-ins').value),
        lyrics: readFields().lyrics,
      });
      stopPlayback();
      $('#yue-cot').value = 'full';
      setPlan(plan.abc, readFields().lyrics.trim() ? readFields().lyrics : null);
      $('#yue-midi-import').hidden = true;
      midiFile = null;
      status(
        `Plan from the MIDI: ${plan.bars} bars in ${plan.key}, ${plan.bpm} bpm, chords estimated bar by bar. Listen to it, check the chords and write the lyrics to sing over the melody.`
      );
    } catch (error) {
      status(error.message, true);
    }
  });
  /* ---------- the notes of one part, bar by bar ---------- */
  let selection = null; // { voice, bar, item }
  const sectionOfPart = () => (Number($('#yue-part').value) || 0) - 1;
  function tone(midi, seconds = 0.6) {
    try {
      const ctx = context();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.18, now + 0.02);
      env.gain.linearRampToValueAtTime(0, now + seconds);
      osc.connect(env).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + seconds + 0.05);
    } catch {
      /* no sound available */
    }
  }
  function chipsFor(part, voice, index, bar) {
    if (!bar) return '<span class="yue-chip silent">—</span>';
    if (bar.silent)
      return `<span class="yue-chip silent">rest${bar.span > 1 ? ` (${bar.span} bars)` : ''}</span>`;
    if (!bar.items)
      return '<span class="yue-chip raw" title="Advanced notation: change it in the ABC text">ABC text</span>';
    return bar.items
      .map((item, i) => {
        if (item.kind === 'label') return `<span class="yue-label">${escape(item.text)}</span>`;
        const label =
          item.kind === 'rest'
            ? '·'
            : item.kind === 'stack'
              ? item.midis.map(m => noteName(m, part.flats)).join(' ')
              : noteName(item.midi, part.flats);
        const title = `${item.kind === 'rest' ? 'Rest' : label} · ${durationLabel(item.units, part.beatUnits)}${item.tie ? ' · tied to the next' : ''}`;
        const chosen =
          selection && selection.voice === voice.name && selection.bar === index && selection.item === i;
        return `<button type="button" class="yue-chip ${item.kind}${chosen ? ' selected' : ''}" data-voice="${escape(voice.name)}" data-bar="${index}" data-i="${i}" data-units="${item.units}" title="${escape(title)}">${escape(label)}</button>`;
      })
      .join('');
  }
  function paintBars() {
    const host = $('#yue-bars-view');
    const section = sectionOfPart();
    let part = null;
    try {
      if (section >= 0 && sectionStats(abc()).length === sectionSlices(abc()).length - 1)
        part = readPart(abc(), section);
    } catch {
      part = null;
    }
    if (!part) {
      host.innerHTML =
        section < 0
          ? '<p class="field-hint">Choose a part of the song to see its notes.</p>'
          : '<p class="field-hint">I cannot show this part: use the ABC text below.</p>';
      $('#yue-note-editor').hidden = true;
      return;
    }
    const cards = [];
    for (let b = 1; b <= part.total; b++) {
      const rows = part.voices
        .map((voice, vi) => {
          const bar = voice.bars.find(x => b >= x.index && b < x.index + x.span);
          return `<div class="yue-voice-row"><span class="yue-voice-name">${escape(voice.role)}</span><span class="yue-chips">${chipsFor(part, voice, bar?.index, bar)}</span></div>`;
        })
        .join('');
      cards.push(`<div class="yue-barcard"><div class="yue-bar-title">Bar ${b}</div>${rows}</div>`);
    }
    host.innerHTML = cards.join('');
    for (const chip of host.querySelectorAll('.yue-chip[data-units]'))
      chip.style.flexGrow = chip.dataset.units;
    paintEditor(part);
  }
  function selectedItem(part) {
    if (!selection) return null;
    const voice = part.voices.find(v => v.name === selection.voice);
    const bar = voice?.bars.find(b => b.index === selection.bar);
    const item = bar?.items?.[selection.item];
    return item && item.kind !== 'label' ? { item, voice, bar } : null;
  }
  function paintEditor(part) {
    const found = selectedItem(part);
    $('#yue-note-editor').hidden = !found;
    if (!found) return;
    const { item, voice } = found;
    const what =
      item.kind === 'rest'
        ? 'Rest'
        : item.kind === 'stack'
          ? 'Notes together'
          : noteName(item.midi, part.flats);
    $('#yue-ne-title').textContent =
      `Bar ${selection.bar} · ${voice.role} · ${what} · ${durationLabel(item.units, part.beatUnits)}`;
    $('#yue-ne-pc').disabled = $('#yue-ne-oct').disabled = item.kind === 'stack';
    if (item.kind === 'note') {
      $('#yue-ne-pc').value = String(((item.midi % 12) + 12) % 12);
      $('#yue-ne-oct').value = String(Math.floor(item.midi / 12) - 1);
    }
    $('#yue-ne-rest').disabled = item.kind === 'rest';
  }
  function runOp(op, arg) {
    if (!selection) return false;
    const section = sectionOfPart();
    try {
      const part = readPart(abc(), section);
      const found = selectedItem(part);
      if (!found || !found.bar.items) throw new Error('This bar is changed in the ABC text.');
      const next = changeItems(found.bar.items, selection.item, op, arg);
      stopPlayback();
      $('#yue-abc').value = editBar(abc(), section, selection.voice, selection.bar, next);
      repaint();
      status('Note changed. Press «Listen to the plan» to hear the result.');
      return true;
    } catch (error) {
      status(error.message, true);
      return false;
    }
  }
  let keepPart = false;
  /** Tempo, the length of every part and a warning when the intro is long. */
  function paintStructure() {
    let stats = [];
    try {
      stats = sectionStats(abc());
    } catch {
      /* a plan being typed by hand: nothing to show */
    }
    const tempo = parsePlan(abc()).header.bpm;
    if (tempo && document.activeElement !== $('#yue-tempo')) $('#yue-tempo').value = tempo;
    const key = /^K:\s*(.*)$/m.exec(abc())?.[1]?.trim() || 'C';
    $('#yue-key-now').textContent = `now ${key}`;
    $('#yue-parts').innerHTML = stats
      .map(part => {
        const options = [1, 2, 3, 4, 6, 8, 12, 16].filter(n => n < part.bars);
        return `<div class="yue-part-row"><span>${escape(sectionLabel(part.name))} · ${part.bars} ${part.bars === 1 ? 'bar' : 'bars'} · ${Math.round(part.seconds)} s</span>${
          options.length
            ? `<select data-part="${part.index}" aria-label="Shorten ${escape(sectionLabel(part.name))} a">${options.map(n => `<option value="${n}">to ${n} ${n === 1 ? 'bar' : 'bars'}</option>`).join('')}</select><button type="button" class="text-button" data-cut="${part.index}">Shorten</button>`
            : ''
        }</div>`;
      })
      .join('');
    const first = stats[0];
    const note = $('#yue-intro-note');
    if (first && first.name.toLowerCase() === 'intro' && first.bars > 4 && first.seconds > 10) {
      const short = Math.round((first.seconds / first.bars) * 4);
      $('#yue-intro-text').textContent =
        `The intro lasts ${Math.round(first.seconds)} seconds (${first.bars} bars) before the voice starts.`;
      $('#yue-intro-cut').textContent = `Shorten it to 4 bars (about ${short} s)`;
      note.hidden = false;
    } else note.hidden = true;
  }
  /** The text of the plan one part at a time, so nobody has to scroll through the whole thing. */
  function paintPartEditor() {
    const select = $('#yue-part');
    const slices = sectionSlices(abc());
    const before = select.value === '' ? 1 : Number(select.value) || 0;
    select.innerHTML = slices
      .map(
        (slice, index) =>
          `<option value="${index}">${index === 0 ? 'Settings (tempo, key)' : `${index}. ${escape(sectionLabel(slice.name))}`}</option>`
      )
      .join('');
    select.value = String(before < slices.length ? before : slices.length > 1 ? 1 : 0);
    showPart();
  }
  function showPart() {
    const slices = sectionSlices(abc());
    const slice = slices[Number($('#yue-part').value) || 0] || slices[0];
    $('#yue-part-text').value = abc().replace(/\r\n/g, '\n').slice(slice.start, slice.end);
  }
  /** Run an edit of the plan, show the result and say what happened. */
  function applyEdit(change, message) {
    try {
      stopPlayback();
      $('#yue-abc').value = change(abc());
      repaint();
      status(message);
      return true;
    } catch (error) {
      status(error.message, true);
      return false;
    }
  }
  function paintGrid() {
    const text = abc();
    const plan = parsePlan(text);
    $('#yue-summary').textContent = plan.slots.length
      ? planSummary(text)
      : $('#yue-cot').value === 'melody'
        ? 'This plan has only the melody, without chords: that is what a cover needs. You can correct the notes below.'
        : 'No chords recognised: you can still edit the plan in the ABC text below.';
    $('#yue-chords').innerHTML = plan.sections
      .filter(section => section.slots.length)
      .map(section => {
        const bars = new Map();
        for (const slot of section.slots) bars.set(slot.bar, [...(bars.get(slot.bar) || []), slot]);
        const label = sectionLabel(section.name);
        return `<div class="yue-section"><strong>${escape(label)}</strong><div class="yue-bars">${[
          ...bars.entries(),
        ]
          .map(
            ([bar, slots]) =>
              `<span class="yue-bar" title="Bar ${bar}">${slots
                .map(
                  slot =>
                    `<input class="yue-chord" data-slot="${slot.id}" value="${escape(slot.chord)}" size="6" maxlength="14" spellcheck="false" autocomplete="off" aria-label="Chord, ${escape(label)}, bar ${bar}">`
                )
                .join('')}</span>`
          )
          .join('')}</div></div>`;
      })
      .join('');
  }
  function paintPresets() {
    const plan = parsePlan(abc());
    const names = [...new Set(plan.sections.filter(s => s.slots.length).map(s => s.name))];
    for (const target of [$('#yue-preset-target'), $('#yue-voice-target')]) {
      const before = target.value;
      target.innerHTML =
        '<option value="">The whole song</option>' +
        names
          .map(name => `<option value="${escape(name)}">Only: ${escape(sectionLabel(name))}</option>`)
          .join('');
      if ([...target.options].some(o => o.value === before)) target.value = before;
    }
    updatePresetPreview();
  }
  function currentPreset() {
    return PRESETS[Number($('#yue-preset').value)] || null;
  }
  function updatePresetPreview() {
    const preset = currentPreset();
    if (!preset) return;
    const key = parsePlan(abc()).header.key || 'C';
    $('#yue-preset-preview').textContent = `In ${key}: ${progressionChords(key, preset.degrees).join(' – ')}`;
    if (!$('#yue-preset-per').dataset.touched) $('#yue-preset-per').value = String(preset.bars);
  }

  function changeChord(input, value) {
    if (!isChord(value)) {
      input.classList.add('invalid');
      status('Invalid chord: pick one from the selector or write for example D, Bm, F#m7, G/B.', true);
      return false;
    }
    input.classList.remove('invalid');
    try {
      $('#yue-abc').value = setChord(abc(), Number(input.dataset.slot), value);
      input.value = value;
      status(
        'Chord changed. The instrument does not follow it on its own: if you want, use «Instrument: make it follow the chords». Then press «Listen to the plan».'
      );
      score = parseScore(abc());
      roll = drawRoll($('#yue-roll'), score, rollSize());
      $('#yue-summary').textContent = planSummary(abc());
      return true;
    } catch (error) {
      status(error.message, true);
      return false;
    }
  }

  /* ---------- chord picker ---------- */
  let pickerInput = null;
  function buildPicker() {
    $('#yue-picker-roots').innerHTML = ROOTS.map(
      r => `<button type="button" class="yue-pick" data-root="${r}">${r}</button>`
    ).join('');
    $('#yue-picker-qualities').innerHTML = QUALITIES.map(
      q =>
        `<button type="button" class="yue-pick" data-quality="${escape(q.symbol)}" title="${escape(q.label)}">${escape(q.symbol || 'maj')}<small>${escape(q.label)}</small></button>`
    ).join('');
  }
  function splitChord(chord) {
    const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(chord) || ['', 'C', '', ''];
    return { root: m[1], quality: m[2], bass: m[3] || '' };
  }
  function pickerState(input) {
    pickerInput = input;
    const { root, quality } = splitChord(input.value.trim());
    $('#yue-picker').dataset.root = root;
    $('#yue-picker').dataset.quality = quality;
    for (const b of $$('#yue-picker-roots .yue-pick'))
      b.classList.toggle('selected', b.dataset.root === root);
    for (const b of $$('#yue-picker-qualities .yue-pick'))
      b.classList.toggle('selected', b.dataset.quality === quality);
  }
  function openPicker(input) {
    const picker = $('#yue-picker');
    pickerState(input);
    picker.hidden = false;
    // the picker is placed inside whatever holds it: the panel, or the big window
    const panel = picker.parentElement.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    picker.style.top = box.bottom - panel.top + 6 + 'px';
    picker.style.left = Math.max(0, Math.min(box.left - panel.left, panel.width - picker.offsetWidth)) + 'px';
  }
  function closePicker() {
    $('#yue-picker').hidden = true;
    pickerInput = null;
  }

  /* ---------- events ---------- */
  buildPicker();
  $('#yue-chords').addEventListener('input', event => {
    const input = event.target.closest('.yue-chord');
    if (input) changeChord(input, input.value.trim());
  });
  $('#yue-chords').addEventListener('focusin', event => {
    const input = event.target.closest('.yue-chord');
    if (input) openPicker(input);
  });
  $('#yue-picker').addEventListener('click', event => {
    const button = event.target.closest('.yue-pick');
    if (!button || !pickerInput) return;
    const picker = $('#yue-picker');
    const root = button.dataset.root ?? picker.dataset.root;
    const quality = button.dataset.quality ?? picker.dataset.quality;
    const chord = composeChord(root, quality, splitChord(pickerInput.value.trim()).bass);
    if (chord && changeChord(pickerInput, chord)) {
      pickerState(pickerInput);
      preview(chord);
    }
  });
  $('#yue-picker-close').addEventListener('click', closePicker);
  document.addEventListener('mousedown', event => {
    if (!$('#yue-picker').hidden && !event.target.closest('#yue-picker, .yue-chord')) closePicker();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePicker();
  });
  let timer = null;
  const repaintSoon = fromPart => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      $('#yue-clear').hidden = mode === 'cover' || !abc().trim();
      stopPlayback();
      keepPart = fromPart;
      repaint();
      keepPart = false;
    }, 400);
  };
  $('#yue-abc').addEventListener('input', () => repaintSoon(false));
  $('#yue-part').addEventListener('change', () => {
    selection = null;
    showPart();
    paintBars();
  });
  $('#yue-ne-pc').innerHTML = Array.from(
    { length: 12 },
    (_, pc) => `<option value="${pc}">${noteName(60 + pc).replace(/\d+$/, '')}</option>`
  ).join('');
  $('#yue-ne-oct').innerHTML = [1, 2, 3, 4, 5, 6, 7].map(o => `<option value="${o}">${o}</option>`).join('');
  $('#yue-bars-view').addEventListener('click', event => {
    const chip = event.target.closest('.yue-chip[data-voice]');
    if (!chip) return;
    selection = { voice: chip.dataset.voice, bar: Number(chip.dataset.bar), item: Number(chip.dataset.i) };
    paintBars();
    const part = readPart(abc(), sectionOfPart());
    const found = selectedItem(part);
    if (found?.item.kind === 'note') tone(found.item.midi);
  });
  const changePitch = () => {
    const midi = 12 * (Number($('#yue-ne-oct').value) + 1) + Number($('#yue-ne-pc').value);
    if (runOp('pitch', midi)) tone(midi);
  };
  $('#yue-ne-pc').addEventListener('change', changePitch);
  $('#yue-ne-oct').addEventListener('change', changePitch);
  $('#yue-ne-rest').addEventListener('click', () => runOp('rest'));
  $('#yue-ne-split').addEventListener('click', () => runOp('split'));
  $('#yue-ne-merge').addEventListener('click', () => runOp('merge'));
  $('#yue-ne-close').addEventListener('click', () => {
    selection = null;
    paintBars();
  });
  $('#yue-ne-play').addEventListener('click', () => {
    const found = selectedItem(readPart(abc(), sectionOfPart()));
    if (!found) return;
    if (found.item.kind === 'note') tone(found.item.midi, 0.8);
    if (found.item.kind === 'stack') found.item.midis.forEach(midi => tone(midi, 0.8));
  });
  $('#yue-part-text').addEventListener('input', () => {
    const slices = sectionSlices(abc());
    const slice = slices[Number($('#yue-part').value) || 0];
    if (!slice) return;
    let value = $('#yue-part-text').value.replace(/\r\n/g, '\n');
    if (slice.end < abc().replace(/\r\n/g, '\n').length && !value.endsWith('\n')) value += '\n';
    $('#yue-abc').value =
      abc().replace(/\r\n/g, '\n').slice(0, slice.start) +
      value +
      abc().replace(/\r\n/g, '\n').slice(slice.end);
    repaintSoon(true);
  });
  for (const name of INSTRUMENT_STYLES)
    $('#yue-voice-style').insertAdjacentHTML(
      'beforeend',
      `<option value="${name.id}">${escape(name.label)}</option>`
    );
  $('#yue-voice-apply').addEventListener('click', () => {
    const where = $('#yue-voice-target').value || null;
    applyEdit(
      text => revoiceInstrument(text, { style: $('#yue-voice-style').value, section: where }),
      'The instrument now plays on the chords. Press «Listen to the plan» to hear it.'
    );
  });
  $('#yue-transpose').innerHTML = Array.from({ length: 25 }, (_, i) => i - 12)
    .filter(n => n !== 0)
    .map(
      n =>
        `<option value="${n}"${n === 2 ? ' selected' : ''}>${n > 0 ? '+' : '−'}${Math.abs(n)} ${Math.abs(n) === 1 ? 'semitone' : 'semitones'}${Math.abs(n) === 12 ? ' (one octave)' : ''}</option>`
    )
    .join('');
  $('#yue-transpose-apply').addEventListener('click', () => {
    const step = Number($('#yue-transpose').value);
    applyEdit(
      text => transposeScore(text, step),
      `Key moved by ${step > 0 ? '+' : '−'}${Math.abs(step)}: notes, chords and key together. The voice goes higher: listen to the plan to hear whether it fits.`
    );
  });
  $('#yue-tempo-apply').addEventListener('click', () =>
    applyEdit(
      text => setTempo(text, $('#yue-tempo').value),
      'Tempo changed. The length of the song changes accordingly.'
    )
  );
  $('#yue-parts').addEventListener('click', event => {
    const button = event.target.closest('[data-cut]');
    if (!button) return;
    const index = Number(button.dataset.cut);
    const keep = Number(button.parentElement.querySelector('select')?.value);
    applyEdit(
      text => trimSection(text, index, keep),
      `Part shortened to ${keep} ${keep === 1 ? 'bar' : 'bars'}.`
    );
  });
  $('#yue-intro-cut').addEventListener('click', () =>
    applyEdit(text => trimSection(text, 0, 4), 'Intro shortened to 4 bars. Listen to the plan to check.')
  );
  $('#yue-clear').addEventListener('click', () => {
    stopPlayback();
    $('#yue-use-chords').checked = false;
    $('#yue-bed').hidden = true;
    setPlan('', null);
    status('Plan discarded: YuE2 will decide the melody and chords on its own.');
  });
  const followSidebar = backend => {
    $('#yue-host').value = backend === 'runpod' ? 'runpod' : 'local';
  };
  $('#generation-backend').addEventListener('change', event => {
    followSidebar(event.target.value);
    paintHost();
    if ($('#yue-lora').open) loadLoras();
  });
  $('#yue-host').addEventListener('change', () => {
    paintHost();
    if ($('#yue-lora').open) loadLoras();
  });
  $('#yue-cot').addEventListener('change', () => {
    const off = $('#yue-cot').value === 'off';
    $('#yue-plan').disabled = off;
    if (off) status('Without a plan YuE2 sings without writing the melody and chords first.');
  });
  $('#yue-play').addEventListener('click', () =>
    audio?.pausedAt == null ? play(startAt) : resumePlayback()
  );
  $('#yue-stop').addEventListener('click', stopPlayback);
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || !active() || (!audio?.run && audio?.pausedAt == null))
      return;
    // Keep Space for typing and form fields; elsewhere it is the playback shortcut, even after opening the score.
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')
    )
      return;
    event.preventDefault();
    if (audio.run) pausePlayback();
    else resumePlayback();
  });
  $('#yue-roll').addEventListener('click', event => {
    if (!roll || !score) return;
    const rect = $('#yue-roll').getBoundingClientRect();
    startAt = Math.max(0, (event.clientX - rect.left) / roll.pxPerSecond);
    $('#yue-time').textContent = `Starting at ${clock(startAt)}`;
    if (audio?.run) play(startAt);
  });
  $('#yue-preset').innerHTML = [...new Set(PRESETS.map(p => p.genre))]
    .map(
      genre =>
        `<optgroup label="${escape(genre)}">${PRESETS.map((p, i) => [p, i])
          .filter(([p]) => p.genre === genre)
          .map(([p, i]) => `<option value="${i}">${escape(p.name)}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  $('#yue-preset').addEventListener('change', () => {
    delete $('#yue-preset-per').dataset.touched;
    updatePresetPreview();
  });
  $('#yue-preset-per').addEventListener('change', () => ($('#yue-preset-per').dataset.touched = '1'));
  $('#yue-preset-apply').addEventListener('click', () => {
    const preset = currentPreset();
    if (!preset || !abc().trim()) return;
    const section = $('#yue-preset-target').value || null;
    const voice = $('#yue-preset-voice').value;
    let note = '';
    applyEdit(text => {
      let out = applyProgression(text, {
        degrees: preset.degrees,
        section,
        barsPerChord: Number($('#yue-preset-per').value) || 1,
      });
      if (voice) {
        try {
          out = revoiceInstrument(out, { style: voice, section });
        } catch (error) {
          note = ` The instrument was not changed: ${error.message}`;
        }
      }
      return out;
    }, '');
    if (!$('#yue-status').classList.contains('error'))
      status(
        (voice && !note ? 'Pattern applied to the instrument too.' : 'Pattern applied.') +
          ' The voice melody did not change and may not fit the new chords: press «Listen to the plan».' +
          note
      );
  });
  /* ---------- chord bed: the user's chords over rests, YuE2 writes the melody ---------- */
  const roles = [
    ['verse', 'Verses'],
    ['chorus', 'Choruses'],
    ['bridge', 'Bridge'],
  ];
  $('#yue-progression-rows').innerHTML = roles
    .map(
      ([id, label]) => `
    <div class="yue-progression"><label for="yue-bed-${id}">${label}</label>
    <select id="yue-bed-${id}" aria-label="Loop for ${label.toLowerCase()}"></select>
    <input id="yue-custom-${id}" name="yueCustom${id}" aria-label="Chords ${label.toLowerCase()}" value="${id === 'chorus' ? 'F G Am C' : id === 'bridge' ? 'Dm Am F G' : 'C G Am F'}" maxlength="400" spellcheck="false"></div>`
    )
    .join('');
  $('#yue-bed-key').innerHTML = BED_KEYS.map(
    k => `<option value="${k}">${escape(k.endsWith('m') ? k.slice(0, -1) + ' minor' : k + ' major')}</option>`
  ).join('');
  $('#yue-simple-root').innerHTML = ROOTS.map(k => `<option>${k}</option>`).join('');
  $('#yue-simple-quality').innerHTML = QUALITIES.map(
    q => `<option value="${q.symbol}">${q.label}</option>`
  ).join('');
  function paintBedParts() {
    const key = $('#yue-bed-key').value;
    for (const [id] of roles) {
      const select = $('#yue-bed-' + id);
      const before = select.value;
      select.innerHTML =
        '<option value="custom">Custom · write the chords</option>' +
        PRESETS.map(
          (p, i) =>
            `<option value="${i}">${escape(p.genre + ' · ' + p.name + ' — ' + progressionChords(key, p.degrees).join(' '))}</option>`
        ).join('');
      select.value = before || 'custom';
      if (select.value !== 'custom')
        $('#yue-custom-' + id).value = progressionChords(key, PRESETS[Number(select.value)].degrees).join(
          ' '
        );
    }
    simpleDirty = true;
  }
  paintBedParts();
  $('#yue-bed-key').addEventListener('change', paintBedParts);
  for (const [id] of roles) {
    $('#yue-bed-' + id).addEventListener('change', () => {
      const preset = PRESETS[Number($('#yue-bed-' + id).value)];
      if (preset)
        $('#yue-custom-' + id).value = progressionChords($('#yue-bed-key').value, preset.degrees).join(' ');
      simpleDirty = true;
    });
    $('#yue-custom-' + id).addEventListener('input', () => {
      $('#yue-bed-' + id).value = 'custom';
      simpleDirty = true;
    });
  }
  $('#yue-bed').addEventListener('input', () => {
    simpleDirty = true;
  });
  $('#lyrics').addEventListener('input', () => {
    simpleDirty = true;
  });
  $('#yue-use-chords').addEventListener('change', () => {
    $('#yue-bed').hidden = !$('#yue-use-chords').checked;
    simpleDirty = true;
    if (!$('#yue-use-chords').checked) setPlan('', null);
  });
  $('#yue-add-chord').addEventListener('click', () => {
    const id = $('#yue-simple-target').value;
    const input = $('#yue-custom-' + id);
    input.value = (
      input.value.trim() +
      ' ' +
      composeChord($('#yue-simple-root').value, $('#yue-simple-quality').value)
    ).trim();
    $('#yue-bed-' + id).value = 'custom';
    simpleDirty = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  /** Rules: the song is as long as its plan, so the length is chosen here: 0 = follow the sung lines, otherwise seconds from 0:10 to 5:00. */
  function bedTarget() {
    if ($('#yue-bed-length').value !== 'manual') return 0;
    const seconds = parseDuration($('#yue-bed-seconds').value);
    if (seconds === null) throw new Error('Write a song length from 0:10 to 5:00, for example 3:00.');
    return seconds;
  }
  function paintBedEstimate() {
    $('#yue-bed-seconds').disabled = $('#yue-bed-length').value !== 'manual';
    const out = $('#yue-bed-estimate');
    const lyrics = readFields().lyrics;
    if (!lyrics.trim()) {
      out.textContent = 'Write the lyrics to see how long the song will be.';
      return;
    }
    try {
      const bed = writeBed({
        bpm: Number($('#yue-bed-bpm').value),
        key: $('#yue-bed-key').value,
        meter: $('#yue-bed-meter').value,
        lyrics,
        seed: 1,
        targetSeconds: bedTarget(),
      });
      out.textContent = `The song will last about ${clock(bed.seconds)} (${bed.bars} bars). Choose Manual to set the length yourself.`;
    } catch (error) {
      out.textContent = error.message;
    }
  }
  $('#yue-bed').addEventListener('input', paintBedEstimate);
  $('#yue-bed').addEventListener('change', paintBedEstimate);
  $('#lyrics').addEventListener('input', paintBedEstimate);
  $('#yue-use-chords').addEventListener('change', paintBedEstimate);
  function prepareBed() {
    const fields = readFields();
    if (!fields.lyrics.trim()) throw new Error('Write the lyrics of the song first.');
    const bed = writeBed({
      bpm: Number($('#yue-bed-bpm').value),
      key: $('#yue-bed-key').value,
      meter: $('#yue-bed-meter').value,
      lyrics: fields.lyrics,
      seed: 1,
      targetSeconds: bedTarget(),
      custom: roles.map(([id]) => $('#yue-custom-' + id).value),
    });
    stopPlayback();
    $('#yue-cot').value = 'full';
    setPlan(bed.abc, fields.lyrics);
    simpleDirty = false;
    status(
      `Chords ready: ${clock(bed.seconds)} long, the same plan for all variants. You can create the song.`
    );
  }
  $('#yue-bed-write').addEventListener('click', () => {
    try {
      prepareBed();
      $('#yue-advanced').open = true;
      repaint();
    } catch (error) {
      status(error.message, true);
    }
  });
  $('#yue-advanced').addEventListener('toggle', () => {
    if ($('#yue-advanced').open && abc().trim()) repaint();
  });

  /* ---------- cover: the melody of an existing song ---------- */
  function paintCoverFit() {
    const box = $('#yue-cover-fit');
    box.hidden = mode !== 'cover' || !abc().trim();
    if (box.hidden) return;
    const list = $('#yue-cover-fit-list');
    const button = $('#yue-cover-align');
    try {
      const { sections, extraBlocks } = coverSectionFit(abc(), readFields().lyrics);
      list.innerHTML =
        sections
          .map(section => {
            const label = escape(sectionLabel(section.name));
            const melody =
              section.notes === null
                ? 'unreadable notes'
                : section.notes === 0
                  ? 'voice resting'
                  : `melody notes: ${section.notes}`;
            const words =
              section.notes > 0
                ? ` · ${section.syllables === null ? 'syllables cannot be estimated' : `estimated syllables: ${section.syllables}`}`
                : '';
            return `<div class="yue-cover-fit-row"><strong>${section.index + 1}. ${label}</strong><span>${melody}${words}</span></div>`;
          })
          .join('') +
        (extraBlocks.length
          ? `<p class="error">${extraBlocks.length} ${extraBlocks.length === 1 ? 'lyrics block not matched' : 'lyrics blocks not matched'}. Fix them before fitting the tags.</p>`
          : '');
      button.disabled =
        !sections.length || sections.some(section => section.notes === null) || extraBlocks.length > 0;
    } catch (error) {
      list.textContent = 'I cannot read the vocal parts: ' + error.message;
      button.disabled = true;
    }
  }
  $('#lyrics').addEventListener('input', () => {
    $('#yue-cover-fit-status').textContent = '';
    paintCoverFit();
  });
  $('#yue-cover-align').addEventListener('click', () => {
    try {
      const aligned = alignCoverLyrics(abc(), readFields().lyrics);
      applyInput({ lyrics: aligned });
      $('#lyrics').dispatchEvent(new Event('input', { bubbles: true }));
      $('#yue-cover-fit-status').textContent =
        'Tags fitted to the score. Check the words and pauses before creating the cover.';
      paintCoverFit();
    } catch (error) {
      $('#yue-cover-fit-status').textContent = error.message;
    }
  });
  const COVER_PARTS = {
    both: ['Extract melody and chords', 'melody and chords'],
    melody: ['Extract the melody', 'the melody'],
    chords: ['Extract the chords', 'the chords'],
  };
  const coverLabel = () => COVER_PARTS[$('#yue-cover-parts').value][0];
  /** The choice in the mode switch: YuE2 decides, I choose the chords, or a melody (cover). */
  const choiceNow = () => (mode === 'cover' ? 'cover' : $('#yue-use-chords').checked ? 'chords' : 'new');
  function paintCover() {
    $('#yue-cover').hidden = mode !== 'cover';
    for (const b of $$('[data-yue-mode]')) {
      b.classList.toggle('selected', b.dataset.yueMode === choiceNow());
      b.setAttribute('aria-pressed', String(b.dataset.yueMode === choiceNow()));
    }
    // Rules: in cover mode the plan comes from the original song, so the "write a plan" controls are hidden: they would replace it.
    const covering = mode === 'cover';
    $('#yue-cot-row').hidden = covering;
    $('#yue-plan').hidden = covering;
    $('#yue-simple').hidden = covering;
    $('#yue-bed').hidden = covering || !$('#yue-use-chords').checked;
    $('#yue-clear').hidden = covering || !abc().trim();
    // Rules: "Crea il piano" makes a new plan and replaces the current one, so its label says so.
    $('#yue-plan').textContent = abc().trim() ? 'Create a new plan' : 'Create the plan';
    $('#yue-panel-title').textContent = covering ? 'Melody and chords of the cover' : 'Chords and melody';
    $('#yue-panel-hint').textContent = covering
      ? abc().trim()
        ? 'Here is the melody extracted from the original song. Listen to it, change the chords or notes that are wrong, then press Create your song.'
        : 'Once you have extracted the melody from the original song (step 1, at the top) you will find it here, ready to listen to and correct.'
      : choiceNow() === 'chords'
        ? 'Set the loops for verses, choruses and bridge, then press «Check the chords»: all the variants will use the same plan.'
        : 'YuE2 writes the melody and chords on its own: each variant can be different. If you want a fixed plan, create it here and listen to it before singing.';
    $('#yue-cover-source').hidden = !cover;
    $('#yue-cover-pick').hidden = !!cover;
    if (cover) {
      $('#yue-cover-name').textContent = cover.title;
      $('#yue-cover-meta').textContent =
        `${clock(cover.seconds)} · ${cover.chords ? 'melody and chords extracted' : 'melody extracted'}`;
      const src = `/api/yue2/cover/${cover.id}/audio`;
      if ($('#yue-cover-audio').getAttribute('src') !== src) $('#yue-cover-audio').setAttribute('src', src);
    } else $('#yue-cover-audio').removeAttribute('src');
    $('#yue-cover-run').textContent = cover ? `${coverLabel()} again` : coverLabel();
    paintCoverFit();
    paintHarmony();
    paintBedEstimate();
  }
  function setMode(next) {
    if (next === choiceNow()) return;
    stopPlayback();
    const before = choiceNow();
    // a plan belongs to the choice it was made in: switching drops it (the original song stays remembered)
    if (abc().trim()) {
      setPlan('', null);
      status(
        next === 'cover'
          ? 'Plan discarded: in a cover the melody comes from the original song.'
          : before === 'cover'
            ? 'Cover melody discarded: YuE2 now writes a new song.'
            : 'Plan discarded: you changed how the melody and chords are made.'
      );
    }
    mode = next === 'cover' ? 'cover' : 'new';
    if (mode === 'cover') $('#yue-use-chords').checked = false;
    if (mode === 'new') {
      $('#yue-use-chords').checked = next === 'chords';
      $('#yue-use-chords').dispatchEvent(new Event('change'));
      $('#yue-cot').value = 'full';
    }
    $('#yue-plan').disabled = $('#yue-cot').value === 'off';
    paintCover();
  }
  for (const b of $$('[data-yue-mode]')) b.addEventListener('click', () => setMode(b.dataset.yueMode));
  $('#yue-cover-parts').addEventListener('change', paintCover);
  $('#yue-cover-change').addEventListener('click', () => {
    cover = null;
    $('#yue-cover-file').value = '';
    $('#yue-cover-status').textContent = '';
    paintCover();
  });
  $('#yue-cover-run').addEventListener('click', async () => {
    const file = $('#yue-cover-file').files[0];
    const out = $('#yue-cover-status');
    const button = $('#yue-cover-run');
    const parts = $('#yue-cover-parts').value;
    const chords = parts !== 'melody';
    out.classList.remove('error');
    if (!file && !cover) {
      out.textContent = 'Choose the audio file of the song first.';
      out.classList.add('error');
      return;
    }
    button.disabled = true;
    out.textContent = `${cover ? 'Extracting' : 'Loading the song and extracting'} ${COVER_PARTS[parts][1]}… this can take a few minutes (longer the first time).`;
    try {
      const headers = { 'X-Sonora': '1', 'x-yue-host': host(), 'x-cover-chords': chords ? '1' : '0' };
      const response = await fetch('/api/yue2/cover/melody', {
        method: 'POST',
        headers: cover
          ? { ...headers, 'x-cover-id': cover.id }
          : {
              ...headers,
              'x-audio-name': encodeURIComponent(file.name),
              'Content-Type': file.type || 'application/octet-stream',
            },
        body: cover ? '' : file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Transcription failed.');
      cover = {
        id: result.coverId,
        title: result.title,
        seconds: result.audioSeconds,
        chords: !!result.chords,
        ...(result.trimmedTo ? { trimmed: true } : {}),
      };
      // Rules: with chords the plan is sung with cot=full (melody and chords), without them with cot=melody.
      // Rules: chords only keeps the chords and rests: YuE2 writes the melody over them (cot=full), as in «I choose the chords».
      $('#yue-cot').value = result.chords ? 'full' : 'melody';
      setPlan(parts === 'chords' ? chordsOnly(result.abc) : result.abc, null);
      if (!$('#title').value.trim()) applyInput({ title: `${result.title} · cover` });
      out.textContent = `${parts === 'chords' ? 'Chords ready' : result.chords ? 'Melody and chords ready' : 'Melody ready'}${result.trimmedTo ? ` (the song is long: I used the first ${clock(result.trimmedTo)}, and the cover will fade out at the end)` : ''}. Now write the lyrics and the new style below, then check the melody at the bottom.`;
      status(
        parts === 'chords'
          ? 'Chords extracted. YuE2 will write a new melody over them: listen with «Listen to the plan», fix the chords in the boxes, then create the song.'
          : result.chords
            ? 'Melody and chords extracted. Listen to them with «Listen to the plan», fix the chords in the boxes and the notes in the bar editor before creating the song.'
            : 'Melody extracted. Listen to it with «Listen to the plan» and fix the wrong notes before creating the song.'
      );
    } catch (error) {
      out.textContent = error.message;
      out.classList.add('error');
    } finally {
      button.disabled = false;
      paintCover();
    }
  });
  $('#yue-plan').addEventListener('click', async () => {
    const fields = readFields();
    if (!fields.tags.trim() || !fields.lyrics.trim()) {
      status('Write the style and the lyrics first: the plan is built from them.', true);
      return;
    }
    if (
      abc().trim() &&
      !window.confirm(
        'Creating a new plan replaces the current one, including any changes to chords and notes. Continue?'
      )
    )
      return;
    const button = $('#yue-plan');
    button.disabled = true;
    status(
      host() === 'local'
        ? 'Writing the melody and chords on your PC… this can take a few minutes.'
        : 'Writing the melody and chords… the first time the GPU has to start up, which can take a few minutes.'
    );
    try {
      const result = await api('/api/yue2/plan', 'POST', {
        tags: fields.tags,
        lyrics: fields.lyrics,
        yueCot: $('#yue-cot').value,
        yueHost: host(),
        seed: fields.seed,
        ...(loraList().length ? { yueAdapters: loraList() } : {}),
        ...(harmony() ? { yueHarmony: harmony() } : {}),
      });
      setPlan(result.abc, fields.lyrics);
      status(
        `Plan ready (${result.seconds} s). Press «Listen to the plan», change the chords you want and create the song.`
      );
    } catch (error) {
      status(error.message, true);
    } finally {
      button.disabled = $('#yue-cot').value === 'off';
    }
  });

  /** Chord variety and section order for a plan YuE2 writes itself (yue2.cpp `harmony`), or null when all is at rest. */
  function harmony() {
    const strength = Number($('#yue-harmony-variety').value) || 0;
    const outside = $('#yue-harmony-outside').checked;
    const value = {
      ...(strength ? { strength } : {}),
      ...(outside ? { identity: 'root', outsideBonus: 2 } : strength ? { identity: 'spelling' } : {}),
      ...($('#yue-harmony-sections').checked ? { sectionStrength: 8 } : {}),
      ...($('#yue-harmony-follow').checked ? { follow: true } : {}),
    };
    return value.strength || value.outsideBonus || value.sectionStrength || value.follow ? value : null;
  }
  function paintHarmony() {
    const on = harmony();
    // Rules: the variety only shapes a plan YuE2 writes. With a plan already here it is not sent, so the state says it waits for the next plan.
    const planned = mode !== 'cover' && !!abc().trim();
    $('#yue-harmony-state').textContent = planned ? '· used in the next plan' : on ? '· active' : '';
    // in a cover the plan comes from the original song, and with «Scelgo gli accordi» you pick the chords yourself: these controls would do nothing
    $('#yue-harmony').hidden = mode === 'cover' || choiceNow() === 'chords';
  }
  for (const id of [
    '#yue-harmony-variety',
    '#yue-harmony-outside',
    '#yue-harmony-sections',
    '#yue-harmony-follow',
  ])
    $(id).addEventListener('change', paintHarmony);
  function setHarmony(value) {
    $('#yue-harmony-variety').value = String(value?.strength >= 10 ? 10 : value?.strength ? 4 : 0);
    $('#yue-harmony-outside').checked = !!value?.outsideBonus;
    $('#yue-harmony-sections').checked = !!value?.sectionStrength;
    $('#yue-harmony-follow').checked = !!value?.follow;
    paintHarmony();
  }
  /** The LoRA ticked for the next song, only when it is made on this PC. */
  const loraList = () =>
    loraHosts[host()] ? [...chosen].map(([id, s]) => ({ id, ar: s.ar, nar: s.nar })) : [];
  function setPlan(text, lyrics) {
    $('#yue-abc').value = text;
    planned = lyrics;
    startAt = 0;
    repaint();
    paintCover();
  }

  return {
    active,
    restoreSimple(input) {
      $('#yue-use-chords').checked = !!input.yueUseChords;
      $('#yue-melody-freedom').value = input.yueFreedomPreference || input.yueMelodyFreedom || 'medium';
      $('#yue-bed').hidden = !$('#yue-use-chords').checked;
      for (const [id] of roles) $('#yue-bed-' + id).value = 'custom';
      simpleDirty = true;
    },
    /** Extra fields for /api/generate when YuE2 is the model. */
    extraInput() {
      const draft = {
        yueUseChords: $('#yue-use-chords').checked,
        yueFreedomPreference: $('#yue-melody-freedom').value,
      };
      if (!active()) return draft;
      const cot = $('#yue-cot').value;
      const plan = cot !== 'off' && abc().trim() ? abc() : '';
      return {
        ...draft,
        yueCot: cot,
        yueHost: host(),
        ...(mode !== 'cover' && melodySupported && host() === 'local'
          ? { yueMelodyFreedom: $('#yue-melody-freedom').value }
          : {}),
        ...(plan ? { abc: plan } : {}),
        ...(mode === 'cover' && cover && plan ? { cover } : {}),
        ...(loraList().length ? { yueAdapters: loraList() } : {}),
        // Rules: a plan that is sent already has its chords, so the variety is left out (the server ignores it then too).
        ...(harmony() && mode !== 'cover' && !plan ? { yueHarmony: harmony() } : {}),
      };
    },
    /** A message when the form cannot be sent as it is, otherwise ''. */
    problem() {
      if (
        active() &&
        mode !== 'cover' &&
        $('#yue-use-chords').checked &&
        (simpleDirty || !abc().trim() || $('#yue-cot').value !== 'full')
      ) {
        try {
          prepareBed();
        } catch (error) {
          return error.message;
        }
      }
      if (active() && mode === 'cover' && !abc().trim())
        return 'For the cover, first extract the melody from the original song (step 1).';
      if (!active() || !abc().trim() || $('#yue-cot').value === 'off') return '';
      if (planned !== null && !same(planned, readFields().lyrics))
        return 'The lyrics changed after the plan was created: create the plan again or discard it.';
      return '';
    },
    /** Which of RunPod / this PC can run YuE2, from /api/config. */
    setConfig(config) {
      melodySupported = !!config.yue2MelodyFreedom;
      hosts = { runpod: !!config.yue2Runpod, local: !!config.yue2Local };
      loraHosts = { local: !!config.yue2Lora, runpod: !!config.yue2LoraRunpod };
      followSidebar(config.generationBackend);
      paintHost();
    },
    /** Show or hide what belongs to YuE2 and what only ACE-Step understands. */
    render() {
      const on = active();
      $('#yue-panel').hidden = !on;
      $('#yue-mode-box').hidden = !on;
      if (on) paintCover();
      if (!on && audio?.run) stopPlayback();
      const keep = el => !!el.querySelector('#variants') || el.classList.contains('tech-details');
      $$('#create-form .opt-list > *').forEach(el => el.classList.toggle('yue-hidden', on && !keep(el)));
      $$('#create-form .tech-details .form-row, #create-form .tech-details > p.field-hint').forEach(el =>
        el.classList.toggle('yue-hidden', on)
      );
      for (const selector of ['.adv-head', '.mode-switch'])
        $$('#create-form ' + selector).forEach(el => el.classList.toggle('yue-hidden', on));
    },
    /**
     * Open a finished YuE2 song in the form with its own plan (and, for a cover, its original song), ready to be changed.
     * Rules: with { keepForm: true } the other fields were already filled by the caller (Riusa parametri) and are not touched.
     */
    async loadFromJob(job, { keepForm = false } = {}) {
      if (!active()) await selectModel('yue2');
      if (!keepForm)
        applyInput({
          title: job.title,
          tags: job.input.tags,
          lyrics: job.input.lyrics,
          seed: job.input.seed,
        });
      stopPlayback();
      mode = job.input.cover ? 'cover' : 'new';
      $('#yue-use-chords').checked = false;
      $('#yue-melody-freedom').value = job.input.yueFreedomPreference || input.yueMelodyFreedom || 'medium';
      $('#yue-advanced').open = true;
      cover = job.input.cover || null;
      $('#yue-cover-status').textContent = '';
      $('#yue-cot').value = job.yue?.cot || job.input.yueCot || 'full';
      if (hosts.runpod && hosts.local)
        $('#yue-host').value = job.remote?.host === 'local' ? 'local' : 'runpod';
      chosen.clear();
      for (const a of job.input.yueAdapters || []) chosen.set(a.id, { ar: a.ar, nar: a.nar });
      setHarmony(job.input.yueHarmony);
      paintHost();
      if (chosen.size) {
        $('#yue-lora').open = true;
        await loadLoras();
      }
      $('#yue-plan').disabled = $('#yue-cot').value === 'off';
      const plan = job.yue?.abc || job.input.abc || '';
      setPlan(plan, cover ? null : job.input.lyrics);
      status(
        cover
          ? 'Cover loaded with its original song and the melody already extracted: nothing to reload. Change the lyrics, style or chords and create the song.'
          : plan
            ? 'Song plan loaded: listen to it, change the chords and press Create your song.'
            : 'Settings loaded. Create a plan or let YuE2 decide.'
      );
      if (!keepForm) toast('Song loaded into the form.');
    },
  };
}
