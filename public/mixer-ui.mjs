// @codedna
// description: Six-stem mixer: separate a song, balance each instrument in real time and export the mix as a new song.
//
// 
//
// 
//
// 
//
// exports: initStemMixer
// used_by: sonora-studio/public/app.js
// rules:   Escape stored titles; never autoplay; the browser graph (gain, balance pan, solo/mute, safety compressor) must stay equivalent to stemMixFilter in stems.mjs.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_stems | Mixer a stem with live Web Audio preview of 160k MP3 stems and FLAC export through the server.
const NAMES = {
  vocals: ['V', 'Voice'],
  drums: ['D', 'Batteria'],
  bass: ['B', 'Basso'],
  guitar: ['G', 'Chitarra'],
  piano: ['P', 'Piano'],
  other: ['A', 'Altro (tastiere, archi, effetti)'],
};
const ORDER = Object.keys(NAMES);
const blank = () => ({ gain: 1, pan: 0, mute: false, solo: false });
const fresh = () => Object.fromEntries(ORDER.map(n => [n, blank()]));

import { createTimeline } from './timeline-ui.mjs';
import {
  normalizeFx,
  dspActive,
  echoTaps,
  saturationCurve,
  widthMatrix,
  reverbImpulse,
  verbMix,
} from './fx.mjs';

export function initStemMixer({ api, toast, pauseLibrary, openView, onExported }) {
  const panel = document.querySelector('#stem-mixer');
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const time = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  panel.innerHTML = `<div class="editor-heading"><div><div class="section-eyebrow">04 / MIX</div><h1>Every instrument in its place.</h1><p>Split a track into vocals, drums, bass, guitar, piano and other stems. Adjust each level, mute a stem, and save the result as a new track. The original stays unchanged.</p></div></div>
    <div class="editor-source"><label for="mix-track">Track</label><div class="editor-source-row"><select id="mix-track"><option value="">Choose a completed track</option></select><button id="mix-separate" class="pill-button" disabled>Split into stems</button></div><p id="mix-status" class="field-hint">Separation takes about 1–2 minutes per minute of audio and runs only once.</p></div>
    <div id="mix-workspace" hidden>
      <div class="editor-timeline"><button id="mix-play" class="pill-button">▶ Listen</button><span id="mix-elapsed">0:00</span><input id="mix-seek" type="range" min="0" max="1000" value="0" aria-label="Posizione"><span id="mix-total">0:00</span></div>
      <div class="stem-track timeline-card"><div class="stem-head"><div><span class="stem-mark">⏱</span><strong>Timeline</strong></div></div><div id="mix-timeline"></div></div>
      <div class="stem-track ext-card"><div class="stem-head"><div><span class="stem-mark">🎙</span><strong>External audio: import or record</strong></div></div>
        <div class="ext-row"><button id="ext-import" class="pill-button">Import audio…</button><input id="ext-file" type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.aac" hidden>
          <label>Ingresso <select id="rec-device"><option value="">Predefinito</option></select></label>
          <label>Canali <select id="rec-channels"><option value="1">Ingresso 1 (mono)</option><option value="2">Ingresso 2 (mono)</option><option value="12">Ingressi 1+2 (stereo)</option><option value="3">Ingresso 3 (mono)</option><option value="4">Ingresso 4 (mono)</option><option value="34">Ingressi 3+4 (stereo)</option></select></label>
          <button id="rec-go" class="pill-button">● Registra</button><span id="rec-state" class="field-hint" aria-live="polite"></span></div>
        <div class="rec-level" hidden><i id="rec-level"></i></div>
        <label class="check"><input type="checkbox" id="rec-monitor"> Monitor yourself while recording (use headphones to prevent feedback)</label>
        <p class="field-hint">Record starts at the playhead, plays the track through your headphones and records to the selected timeline track, or creates a new one. The recording stays dry; track FX are applied afterward and remain editable. If it is slightly out of time, use track FX → Shift. With an audio interface, select it as the input and choose the correct channels (usually input 1 is the microphone and 2 is the instrument). For zero-latency monitoring, use the interface’s direct monitor and leave the checkbox above off. Turn it on only to hear the track effects.</p></div>
      <div class="editor-replace" id="mix-ai"><div class="section-eyebrow">ADD AN INSTRUMENT</div><h2>Let AI play it.</h2><p>Describe the instrument to add (for example, “warm, slow cello” or “clean electric guitar arpeggios”). AI starts from the instrumental, so the new part follows the track timing and harmony. It appears as a new track to mix.</p><label for="mix-ai-instrument">Which instrument?</label><input id="mix-ai-instrument" maxlength="120" placeholder="e.g. warm cello, long notes"><label for="mix-ai-strength">AI freedom: <output id="mix-ai-strength-label">85%</output></label><input id="mix-ai-strength" type="range" min="50" max="95" step="5" value="85"><p class="field-hint">Lower follows the backing more closely but makes the new part quieter. Higher makes it louder and freer.</p><label for="mix-ai-finish">Quality</label><select id="mix-ai-finish"><option value="fast">Fast (Turbo)</option><option value="final">Final (SFT, slower)</option></select><p id="mix-ai-range" class="field-hint"></p><button id="mix-ai-go" class="pill-button">Generate instrument</button><p id="mix-ai-status" class="field-hint" aria-live="polite"></p></div>
      <div class="editor-export"><button id="mix-export" class="pill-button">Save mix as a new track</button><button id="mix-reset" class="text-button">Reset adjustments</button></div>
      <p class="editor-note">Separation is not perfect: dense tracks can leave some of one instrument in another stem. Lowering a stem often sounds better than removing it entirely.</p>
    </div>`;
  const $ = id => panel.querySelector('#' + id);
  let state = {},
    selected = '',
    active = false,
    settings = fresh(),
    ctx = null,
    buffers = {},
    nodes = {},
    sources = [],
    master = null,
    playing = false,
    position = 0,
    startedAt = 0,
    timer = null;
  /** The cuts as they sound: every track's «Shift» (ms) nudges its clips in time; what falls before 0 is trimmed. */
  function playbackClips() {
    const out = {};
    for (const [name, list] of Object.entries(timeline.clips())) {
      const delta = normalizeFx(entry(name).fx).shift / 1000;
      out[name] = !delta
        ? list
        : list
            .map(c => {
              let { at, from, len } = c;
              at += delta;
              if (at < 0) {
                from -= at;
                len += at;
                at = 0;
              }
              return len > 0.02 ? { ...c, at, from, len } : null;
            })
            .filter(Boolean);
    }
    return out;
  }
  const duration = () => Math.max(0, ...Object.values(buffers).map(b => b.duration));
  const layers = () => session()?.layers || [];
  let lanes = []; // custom empty tracks of the current song: [{ id: 'lane-xxxx', name }]
  const isLane = name => name.startsWith('lane-');
  const keys = () => [...ORDER, ...layers().map(l => l.id), ...lanes.map(l => l.id)];
  const isSource = name => !isLane(name);
  const lanesKey = id => 'sonora-lanes-' + id;
  function saveLanes() {
    try {
      localStorage.setItem(lanesKey(selected), JSON.stringify(lanes));
    } catch {}
  }
  const entry = name => (settings[name] ??= blank());
  const label = name =>
    NAMES[name]
      ? NAMES[name][1]
      : lanes.find(l => l.id === name)?.name ||
        layers().find(l => l.id === name)?.name ||
        'Tool aggiunto';
  const mark = name => (NAMES[name] ? NAMES[name][0] : '+');
  let loading = false,
    paintedGrid = '',
    paintedKey = '';
  const storeKey = id => 'sonora-mixer-' + id;
  function saveSettings() {
    try {
      localStorage.setItem(storeKey(selected), JSON.stringify(settings));
    } catch {}
  }
  function loadSettings(id) {
    settings = fresh();
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey(id)) || 'null');
      if (saved) for (const n of Object.keys(saved)) Object.assign((settings[n] ??= blank()), saved[n] || {});
    } catch {}
  }
  const session = () => (state.stems?.sessions || []).find(s => s.id === selected);
  const clipsKey = id => 'sonora-clips-' + id;
  function saveClips() {
    try {
      localStorage.setItem(clipsKey(selected), JSON.stringify(timeline.clips()));
    } catch {}
  }
  const timeline = createTimeline({
    root: panel.querySelector('#mix-timeline'),
    keys: () => keys(),
    label: name => label(name),
    buffer: name => buffers[name],
    total: () => duration(),
    grid: () => session()?.grid || null,
    beatsPerBar: () => {
      const n = Number(state.jobs?.find(j => j.id === selected)?.input?.timesignature || 4);
      return n === 6 ? 6 : n || 4;
    },
    seek: t => seekTo(t),
    changed: () => {
      saveClips();
      if (playing) {
        pause();
        play();
      }
    },
    toggle: (name, key) => {
      entry(name)[key] = !entry(name)[key];
      applyAll();
      saveSettings();
      paintTracks();
      timeline.render();
    },
    flags: name => entry(name),
    setGain: (name, value) => {
      entry(name).gain = value;
      applyAll();
      saveSettings();
    },
    setPan: (name, value) => {
      entry(name).pan = value;
      applyAll();
      saveSettings();
    },
    downloadUrl: name =>
      isLane(name) ? null : `/api/stems/${selected}/audio?stem=${name}&format=flac&download=1`,
    removable: name => (isLane(name) ? 'lane' : isSource(name) && !NAMES[name] ? 'layer' : null),
    remove: name => (isLane(name) ? removeLane(name) : removeLayerById(name)),
    isSource: name => isSource(name),
    getFx: name => normalizeFx(entry(name).fx),
    getReduction: name => meters[name] || 0,
    setFx: (name, fx) => {
      const shifted = normalizeFx(entry(name).fx).shift !== normalizeFx(fx).shift;
      entry(name).fx = normalizeFx(fx);
      rebuildFx(name);
      saveSettings();
      // The time shift changes when clips start: apply it right away if the song is playing.
      if (shifted && playing && !recording) {
        pause();
        play();
      }
    },
    selected: range => paintAiRange(range),
    tempoChanged: () => {
      if (ctx) keys().forEach(rebuildFx);
    },
    notify: message => toast(message),
    addLane: () => addLane(),
  });
  // ---------- External audio: import a file or record a take ----------
  const uploadHeaders = (name, kind) => ({
    'X-Sonora': '1',
    'Content-Type': 'application/octet-stream',
    'x-audio-name': encodeURIComponent(name),
    'x-audio-kind': kind,
  });
  /** Sends a file or a WAV blob to the server and returns the stored entry { id, name, duration }. */
  async function uploadExternal(body, name, kind) {
    const response = await fetch(`/api/stems/${selected}/external`, {
      method: 'POST',
      headers: uploadHeaders(name, kind),
      body,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || 'Upload failed.');
    return value.external;
  }
  /** Puts an external source on a track as a clip starting at `at` (never longer than the song). */
  function placeExternal(lane, entry, at) {
    const start = Math.min(Math.max(0, at), Math.max(0, duration() - 0.1));
    timeline.addClip(lane, {
      src: entry.id,
      at: start,
      from: 0,
      len: Math.min(entry.duration, duration() - start),
    });
  }
  async function importFile(file) {
    if (!selected || !file) return;
    if (file.size > 150 * 1024 * 1024)
      return toast('File exceeds 150 MB. Compress it (MP3 or FLAC) or trim it.');
    $('rec-state').textContent = `Uploading «${file.name}»…`;
    try {
      const name = file.name.replace(/\.[^.]+$/, '') || 'Audio importato';
      const entry = await uploadExternal(file, name, 'import');
      const lane = makeLane(name);
      await onExported?.();
      if (lane) placeExternal(lane, entry, position);
      toast(`«${name}» imported to a new track at the playhead.`);
    } catch (e) {
      toast(e.message);
    } finally {
      $('rec-state').textContent = '';
    }
  }
  async function refreshDevices() {
    try {
      const select = $('rec-device'),
        chosen = select.value;
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      select.innerHTML =
        '<option value="">Predefinito</option>' +
        inputs
          .filter(d => d.deviceId && d.deviceId !== 'default')
          .map(
            (d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Ingresso ' + (i + 1))}</option>`
          )
          .join('');
      select.value = [...select.options].some(o => o.value === chosen) ? chosen : '';
    } catch {}
  }
  let recording = null,
    recReady = false;
  async function startRecording() {
    if (!selected || !Object.keys(buffers).length) return toast('Open a separated track first.');
    if (!navigator.mediaDevices?.getUserMidsa)
      return toast('This browser cannot record audio; a secure HTTPS connection is required.');
    let stream;
    try {
      const deviceId = $('rec-device').value;
      stream = await navigator.mediaDevices.getUserMidsa({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 8 },
        },
      });
    } catch (e) {
      return toast(
        e?.name === 'NotAllowedError'
          ? 'The browser cannot access the microphone. Allow access from the icon beside the address bar.'
          : `Ingresso audio unavailable (${e?.name || e}).`
      );
    }
    void refreshDevices();
    try {
      ensureContext();
      await ctx.resume();
      if (!recReady) {
        await ctx.audioWorklet.addModule('/rec-worklet.js');
        recReady = true;
      }
      const track = stream.getAudioTracks()[0],
        settings = track.getSettings(),
        available = Math.max(1, Number(settings.channelCount) || 1);
      // Which of the interface's inputs to keep: 1 or 2 channels, chosen in the menu (remembered for next time).
      const picked = $('rec-channels')
        .value.split('')
        .map(n => Number(n) - 1);
      if (picked.some(i => i >= available))
        throw new Error(
          `The selected input does not exist. This device has ${available} inputs; choose another channel.`
        );
      try {
        localStorage.setItem(
          'sonora-rec',
          JSON.stringify({ device: $('rec-device').value, channels: $('rec-channels').value })
        );
      } catch {}
      // Record on the track chosen in the timeline when it is one of yours, otherwise on a new one.
      let lane = timeline.currentLane();
      if (!lane || !isLane(lane)) lane = makeLane(`Recording ${lanes.length + 1}`);
      if (!lane) throw new Error('No tracks are available.');
      const source = ctx.createMidsaStreamSource(stream),
        node = new AudioWorkletNode(ctx, 'sonora-rec', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: available,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
        }),
        silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
      let monitor = null;
      if ($('rec-monitor').checked) {
        // Only the chosen inputs are heard (a mono input in both ears), through the effects of the target track.
        const split = ctx.createChannelSplitter(available),
          merge = ctx.createChannelMerger(2);
        monitor = ctx.createGain();
        source.connect(split);
        picked.forEach((index, n) => {
          split.connect(merge, index, picked.length === 1 ? 0 : n);
          if (picked.length === 1) split.connect(merge, index, 1);
        });
        merge.connect(monitor);
        monitor.connect(nodeFor(lane).fxIn);
        monitor.extra = [split, merge];
      }
      recording = {
        stream,
        source,
        node,
        silent,
        monitor,
        lane,
        picked,
        inputLatency: Number(settings.latency) || 0,
        first: null,
        chunks: [],
        startPosition: position,
        lastPaint: 0,
      };
      node.port.onmessage = e => {
        if (!recording) return;
        recording.first ??= e.data.time;
        const kept = recording.picked.map(i => e.data.channels[i]);
        recording.chunks.push(kept);
        const now = performance.now();
        if (now - recording.lastPaint > 80) {
          recording.lastPaint = now;
          let peak = 0;
          for (const channel of kept)
            for (let k = 0; k < channel.length; k += 4) peak = Math.max(peak, Math.abs(channel[k]));
          $('rec-level').style.width = Math.min(100, Math.sqrt(peak) * 100) + '%';
          const seconds = (recording.chunks.length * kept[0].length) / ctx.sampleRate;
          $('rec-state').textContent = `Recording… ${seconds.toFixed(1)} s`;
        }
      };
      // The song starts under the recording; `startedAt` (audio clock) lets the take be lined up afterwards.
      if (playing) pause();
      play();
      recording.when = startedAt;
      $('rec-go').textContent = '■ Stop and save';
      panel.querySelector('.rec-level').hidden = false;
    } catch (e) {
      stream.getTracks().forEach(t => t.stop());
      recording = null;
      toast(e?.message || 'Recording could not be started.');
    }
  }
  /** 16-bit PCM WAV of one or two channels. */
  function wavBlob(left, right, rate) {
    const channels = right ? 2 : 1,
      frames = left.length,
      view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
    const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * channels * 2, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * channels * 2, true);
    let at = 44;
    for (let i = 0; i < frames; i++)
      for (const channel of right ? [left, right] : [left]) {
        view.setInt16(at, Math.max(-1, Math.min(1, channel[i])) * 32767, true);
        at += 2;
      }
    return new Blob([view], { type: 'audio/wav' });
  }
  async function stopRecording(save = true) {
    const r = recording;
    if (!r) return;
    recording = null;
    r.node.port.postMessage('stop');
    for (const x of [r.source, r.node, r.silent, r.monitor, ...(r.monitor?.extra || [])]) {
      try {
        x?.disconnect();
      } catch {}
    }
    r.stream.getTracks().forEach(t => t.stop());
    pause();
    $('rec-go').textContent = '● Registra';
    panel.querySelector('.rec-level').hidden = true;
    $('rec-level').style.width = '0';
    if (!save) return void ($('rec-state').textContent = '');
    // Keep the samples from the moment the playhead position was heard and played back: the output and input latencies the
    // browser reports are subtracted, so a take played in time lands on the beat.
    const rate = ctx.sampleRate,
      correction = (ctx.outputLatency || ctx.baseLatency || 0) + r.inputLatency;
    const total = r.chunks.reduce((n, c) => n + c[0].length, 0);
    const skip = Math.max(0, Math.round((r.when + correction - r.first) * rate));
    if (!r.first || skip >= total - rate * 0.2) {
      $('rec-state').textContent = '';
      return toast('Recording is too short; nothing was saved.');
    }
    const left = new Float32Array(total - skip),
      right = r.picked.length > 1 ? new Float32Array(total - skip) : null;
    let at = 0;
    for (const c of r.chunks) {
      for (let i = 0; i < c[0].length; i++, at++) {
        if (at < skip) continue;
        left[at - skip] = c[0][i];
        if (right) right[at - skip] = c[1][i];
      }
    }
    $('rec-state').textContent = 'Saving recording…';
    try {
      const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const entry = await uploadExternal(wavBlob(left, right, rate), `Recording ${stamp}`, 'rec');
      await onExported?.();
      placeExternal(r.lane, entry, r.startPosition);
      toast('Recording saved to the track, starting where you selected Record.');
    } catch (e) {
      toast(e.message);
    } finally {
      $('rec-state').textContent = '';
    }
  }

  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  /** Tells whether the next AI instrument is for the whole song or only for the section highlighted on the timeline. */
  function paintAiRange(range = timeline.selection()) {
    $('mix-ai-range').textContent = range
      ? `The instrument will be generated only for the selected section: ${mmss(range.a)} – ${mmss(range.b)}. The rest of the track will be silent.`
      : 'The instrument will be generated for the whole track. To generate only one section, drag across the timeline ruler to select it.';
    $('mix-ai-go').textContent = range ? 'Generate only for the selected section' : 'Generate instrument';
  }
  async function removeLayerById(id) {
    if (!confirm(`Delete the instrument «${label(id)}» dal mixer?`)) return;
    try {
      await api(`/api/stems/${selected}/layer/${id}`, 'DELETE');
      delete buffers[id];
      timeline.forget(id);
      saveClips();
      delete settings[id];
      saveSettings();
      toast('Tool eliminato dal mixer.');
      if (playing) {
        pause();
        play();
      }
    } catch (err) {
      toast(err.message);
    }
  }
  /** Creates an empty custom track and returns its id (null when the limit is reached). */
  function makeLane(name) {
    if (lanes.length >= 12) {
      toast('Massimo 12 tracks aggiunte.');
      return null;
    }
    const id = 'lane-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    lanes = [...lanes, { id, name: name.slice(0, 40) }];
    saveLanes();
    paintTracks();
    timeline.render();
    return id;
  }
  function addLane() {
    const proposed = `Track ${lanes.length + 1}`;
    const name = (prompt('New track name:', proposed) || '').trim().slice(0, 40);
    if (!name || !makeLane(name)) return;
    toast(
      `«${name}» added. Select a clip and choose Copy, then select the track and choose Paste. You can also drag clips here.`
    );
  }
  function removeLane(id) {
    const name = label(id);
    if (!confirm(`Delete the track “${name}” and its clips?`)) return;
    lanes = lanes.filter(l => l.id !== id);
    delete settings[id];
    timeline.forget(id);
    saveLanes();
    saveClips();
    saveSettings();
    paintTracks();
    timeline.render();
    if (playing) {
      pause();
      play();
    }
  }
  /** Audible level of one stem: any solo wins over mute, like the server mixdown. */
  const audible = name => {
    const anySolo = keys().some(n => entry(n).solo);
    return anySolo ? entry(name).solo : !entry(name).mute;
  };
  function applyNode(name) {
    const n = nodes[name];
    if (!n) return;
    const { gain, pan } = entry(name);
    n.gain.gain.value = audible(name) ? gain : 0;
    n.left.gain.value = pan > 0 ? 1 - pan : 1;
    n.right.gain.value = pan < 0 ? 1 + pan : 1;
  }
  const applyAll = () => keys().forEach(applyNode);
  function ensureContext() {
    if (ctx) return;
    // The context runs at the device's own rate (needed to record cleanly); the tracks are decoded at 32 kHz to save memory
    // (see `decoder`) and resampled on the fly by the buffer sources.
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -1;
    master.knee.value = 0;
    master.ratio.value = 20;
    master.attack.value = 0.003;
    master.release.value = 0.1;
    master.connect(ctx.destination);
    applyAll();
  }
  const meters = {};
  let offline = null;
  /** Decoder at 32 kHz: 8 tracks of 3 minutes are ~0.4 GB at 44.1 kHz stereo, ~0.3 GB at 32 kHz as 32-bit floats. */
  const decoder = () => (offline ??= new OfflineAudioContext(2, 1, 32000));
  let workletLoading = null,
    workletReady = false;
  /** Loads the effects worklet once; tracks that need it are rebuilt as soon as it is there. */
  function ensureWorklet() {
    workletLoading ??= ctx.audioWorklet
      .addModule('/fx-worklet.js')
      .then(() => {
        workletReady = true;
        keys().forEach(rebuildFx);
      })
      .catch(e => toast('Advanced effects are not available in this browser: ' + (e?.message || e)));
    return workletLoading;
  }
  /**
   * Effects of one track, in the same order as the export: EQ → high/low-pass → saturation → stereo width → echo → reverb.
   * Rebuilt whenever a setting changes; a neutral setting leaves the track untouched (fxIn goes straight to the gain stage).
   */
  function rebuildFx(name) {
    const n = nodes[name];
    if (!n) return;
    n.fxIn.disconnect();
    try {
      n.dsp?.disconnect();
    } catch {}
    for (const x of n.fxNodes) {
      try {
        x.disconnect();
      } catch {}
    }
    n.fxNodes = [];
    const f = normalizeFx(entry(name).fx);
    let tail = n.fxIn;
    const keep = node => {
      n.fxNodes.push(node);
      return node;
    };
    const chain = node => {
      tail.connect(keep(node));
      tail = node;
    };
    const biquad = (type, frequency, gain, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = frequency;
      if (gain !== undefined) b.gain.value = gain;
      if (q !== undefined) b.Q.value = q;
      chain(b);
    };
    if (f.low) biquad('lowshelf', 120, f.low);
    if (f.mid) biquad('peaking', 1000, f.mid, 1);
    if (f.high) biquad('highshelf', 8000, f.high);
    if (f.hp > 20) biquad('highpass', f.hp, undefined, -3.0103);
    if (f.lp < 20000) biquad('lowpass', f.lp, undefined, -3.0103);
    if (dspActive(f)) {
      // Compressor, distortion, wah, envelope filter, chorus and flanger: the same code the export runs (dsp-fx.mjs).
      if (!workletReady) void ensureWorklet();
      else {
        if (!n.dsp) {
          n.dsp = new AudioWorkletNode(ctx, 'sonora-fx', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
          });
          n.dsp.port.onmessage = e => {
            meters[name] = e.data.reduction;
          };
        }
        n.dsp.port.postMessage({ params: f, bpm: timeline.bpm() || 100 });
        tail.connect(n.dsp);
        tail = n.dsp;
      }
    } else if (n.dsp) {
      n.dsp.port.postMessage({ reset: true });
      meters[name] = 0;
    }
    if (f.sat > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturationCurve(f).curve;
      shaper.oversample = '2x';
      chain(shaper);
    }
    if (f.width !== 1) {
      const { a, b } = widthMatrix(f);
      const split = keep(ctx.createChannelSplitter(2)),
        merge = keep(ctx.createChannelMerger(2));
      tail.connect(split);
      for (const [from, to, amount] of [
        [0, 0, a],
        [1, 0, b],
        [0, 1, b],
        [1, 1, a],
      ]) {
        const g = keep(ctx.createGain());
        g.gain.value = amount;
        split.connect(g, from);
        g.connect(merge, 0, to);
      }
      tail = merge;
    }
    if (f.echo > 0) {
      const sum = keep(ctx.createGain());
      tail.connect(sum);
      for (const tap of echoTaps(f)) {
        const delay = keep(ctx.createDelay(1)),
          g = keep(ctx.createGain());
        delay.delayTime.value = tap.ms / 1000;
        g.gain.value = tap.gain;
        tail.connect(delay);
        delay.connect(g);
        g.connect(sum);
      }
      tail = sum;
    }
    if (f.verb > 0) {
      const { dry, wet } = verbMix(f),
        ir = reverbImpulse(f.room, ctx.sampleRate),
        buffer = ctx.createBuffer(2, ir.length, ctx.sampleRate);
      buffer.copyToChannel(ir.left, 0);
      buffer.copyToChannel(ir.right, 1);
      const conv = keep(ctx.createConvolver()),
        dryGain = keep(ctx.createGain()),
        wetGain = keep(ctx.createGain()),
        sum = keep(ctx.createGain());
      conv.normalize = false;
      conv.buffer = buffer;
      dryGain.gain.value = dry;
      wetGain.gain.value = wet;
      tail.connect(dryGain);
      tail.connect(conv);
      conv.connect(wetGain);
      dryGain.connect(sum);
      wetGain.connect(sum);
      tail = sum;
    }
    tail.connect(n.gain);
  }
  /** One gain + balance chain per track, created the first time a track is heard. */
  function nodeFor(name) {
    if (nodes[name]) return nodes[name];
    const gain = ctx.createGain(),
      split = ctx.createChannelSplitter(2),
      left = ctx.createGain(),
      right = ctx.createGain(),
      merge = ctx.createChannelMerger(2);
    const fxIn = ctx.createGain();
    fxIn.connect(gain);
    gain.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    left.connect(merge, 0, 0);
    right.connect(merge, 0, 1);
    merge.connect(master);
    nodes[name] = { gain, left, right, fxIn, fxNodes: [] };
    applyNode(name);
    rebuildFx(name);
    return nodes[name];
  }
  function stop() {
    for (const s of sources) {
      try {
        s.stop();
      } catch {}
    }
    sources = [];
  }
  function pause() {
    if (playing) position = Math.min(duration(), position + ctx.currentTime - startedAt);
    stop();
    playing = false;
    clearInterval(timer);
    $('mix-play').textContent = '▶ Listen';
  }
  function play() {
    if (!Object.keys(buffers).length) return;
    pauseLibrary();
    ensureContext();
    void ctx.resume();
    if (position >= duration() - 0.05) position = 0;
    const when = ctx.currentTime + 0.05,
      cuts = playbackClips();
    // Every cut is its own source, started at its place on the timeline with 5 ms fades against clicks.
    for (const [name, list] of Object.entries(cuts)) {
      for (const clip of list) {
        const buffer = buffers[clip.src || name];
        if (!buffer || clip.at + clip.len <= position) continue;
        const startAt = Math.max(position, clip.at),
          offset = clip.from + (startAt - clip.at),
          length = clip.len - (startAt - clip.at),
          begin = when + (startAt - position);
        const source = ctx.createBufferSource(),
          fade = ctx.createGain();
        source.buffer = buffer;
        // Envelope in timeline time: linear fade in over `fi`, fade out over `fo`, 5 ms minimum against clicks.
        const fi = Math.max(0.005, clip.fi || 0),
          fo = Math.max(0.005, clip.fo || 0),
          clipEnd = clip.at + clip.len,
          level = t => Math.max(0, Math.min(1, (t - clip.at) / fi, (clipEnd - t) / fo));
        fade.gain.setValueAtTime(level(startAt), begin);
        for (const t of [clip.at + fi, clipEnd - fo]) {
          if (t > startAt && t < clipEnd) fade.gain.linearRampToValueAtTime(level(t), begin + (t - startAt));
        }
        fade.gain.linearRampToValueAtTime(0, begin + (clipEnd - startAt));
        source.connect(fade);
        fade.connect(nodeFor(name).fxIn);
        source.start(begin, offset, length);
        sources.push(source);
      }
    }
    startedAt = when;
    playing = true;
    $('mix-play').textContent = '❚❚ Pause';
    timer = setInterval(() => {
      const now = position + ctx.currentTime - startedAt;
      if (now >= duration()) {
        pause();
        position = 0;
        paintTime(0);
      } else paintTime(now);
    }, 100);
  }
  function paintTime(now) {
    timeline.setPlayhead(now);
    $('mix-elapsed').textContent = time(now);
    $('mix-seek').value = duration() ? Math.round((now / duration()) * 1000) : 0;
  }
  function seekTo(t) {
    const was = playing;
    if (was) pause();
    position = Math.min(duration(), Math.max(0, t));
    paintTime(position);
    if (was) play();
  }
  const seek = fraction => seekTo(fraction * duration());
  async function loadStems() {
    const s = session();
    if (!s || s.status !== 'ready' || loading) return;
    const missing = [...s.stems, ...layers().map(l => l.id), ...(s.externals || []).map(x => x.id)].filter(
      n => !buffers[n]
    );
    if (!missing.length) return;
    loading = true;
    const forSong = selected;
    $('mix-status').textContent = 'Loading stems…';
    try {
      ensureContext();
      let done = 0;
      // Download and decoding run in parallel, with a visible counter: a song with AI layers has many tracks.
      await Promise.all(
        missing.map(async name => {
          const response = await fetch(`/api/stems/${forSong}/audio?stem=${name}&format=mp3`);
          if (!response.ok)
            throw new Error(`Tool «${label(name)}» unavailable (${response.status}).`);
          const buffer = await decoder().decodeAudioData(await response.arrayBuffer());
          if (forSong === selected) buffers[name] = buffer;
          done++;
          if (forSong === selected)
            $('mix-status').textContent = `Loading stems… ${done}/${missing.length}`;
        })
      );
      if (forSong !== selected) return;
      $('mix-total').textContent = time(duration());
      $('mix-status').textContent = 'Ready. Press Play and adjust the sliders.';
      applyAll();
      timeline.render();
      timeline.ensureFit();
      if (!s.grid) api(`/api/stems/${forSong}/grid`, 'POST', {}).catch(() => {});
    } catch (e) {
      const message = e?.message || 'Could not load the stems.';
      if (forSong === selected)
        $('mix-status').textContent = 'Error: ' + message + ' Select the track again to retry.';
      toast(message);
    } finally {
      loading = false;
      // The song was changed while loading: load the new one now.
      if (forSong !== selected) void loadStems();
    }
  }
  /** The timeline lanes are the only per-track controls now (volume, pan, mute, solo, remove, download). */
  function paintTracks() {
    paintedKey = keys().join('|');
    timeline.render();
  }
  function render(next) {
    if (next) state = next;
    const jobs = (state.jobs || []).filter(
      j =>
        j.status === 'done' &&
        j.kind !== 'layer' &&
        j.assets?.flac === `${j.id}.flac` &&
        true
    );
    const select = $('mix-track');
    // A marker before each title tells at a glance whether the stems already exist: ✓ separated, … in progress, ✗ failed.
    const stateOf = id => (state.stems?.sessions || []).find(x => x.id === id)?.status;
    const badge = id => {
      const st = stateOf(id);
      return st === 'ready'
        ? '✓ '
        : st === 'queued' || st === 'processing'
          ? '… '
          : st === 'failed'
            ? '✗ '
            : '   ';
    };
    const key = jobs.map(j => j.id + j.title + stateOf(j.id)).join('|') + '|' + selected;
    if (select.dataset.key !== key) {
      select.dataset.key = key;
      select.innerHTML =
        '<option value="">Choose a track (✓ = already separated)</option>' +
        jobs
          .map(
            j =>
              `<option value="${j.id}"${j.id === selected ? ' selected' : ''}>${badge(j.id)}${esc(j.title)}</option>`
          )
          .join('');
    }
    const s = session();
    const busy = s && ['queued', 'processing'].includes(s.status);
    $('mix-separate').disabled = !selected || busy || s?.status === 'ready';
    $('mix-separate').textContent =
      s?.status === 'ready' ? 'Already separated' : busy ? 'Separation in progress…' : 'Split into stems';
    if (busy) $('mix-status').textContent = s.phase;
    else if (s?.status === 'failed')
      $('mix-status').textContent = 'Error: ' + (s.error || 'stem separation failed') + ' Try again.';
    $('mix-workspace').hidden = !(s?.status === 'ready');
    if (keys().join('|') !== paintedKey) {
      paintTracks();
      timeline.render();
    }
    const gridKey = JSON.stringify(s?.grid || null);
    if (gridKey !== paintedGrid) {
      paintedGrid = gridKey;
      timeline.render();
      if (ctx) keys().forEach(rebuildFx);
    }
    const layerJobs = (state.jobs || []).filter(j => j.kind === 'layer' && j.parentId === selected);
    const working = layerJobs.find(
      j => !['done', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(j.status)
    );
    const failed = ['failed', 'interrupted', 'uncertain'].includes(layerJobs[0]?.status)
      ? layerJobs[0]
      : null;
    $('mix-ai-go').disabled = !!working;
    $('mix-ai-status').textContent = working
      ? `${working.title.split(' · ').pop()}: ${working.phase}${working.progress ? ` · ${working.progress.value}/${working.progress.max} steps` : ''}`
      : failed
        ? 'The last stem failed: ' + (failed.error || 'Try again.')
        : '';
    if (s?.status === 'ready' && active) void loadStems();
    if (s?.status === 'ready' && active) timeline.ensureFit();
  }
  function choose(id) {
    if (id === selected) return;
    if (recording) void stopRecording(false);
    pause();
    selected = id;
    buffers = {};
    position = 0;
    paintTime(0);
    try {
      lanes = JSON.parse(localStorage.getItem(lanesKey(id)) || '[]').filter(l =>
        /^lane-[a-z0-9]{3,12}$/.test(l?.id)
      );
    } catch {
      lanes = [];
    }
    loadSettings(id);
    try {
      timeline.load(JSON.parse(localStorage.getItem(clipsKey(id)) || 'null'));
    } catch {
      timeline.load(null);
    }
    paintTracks();
    $('mix-status').textContent = id
      ? 'Separation takes about 1–2 minutes per minute of audio and runs only once.'
      : '';
    render();
  }
  panel.addEventListener('change', e => {
    if (e.target.id === 'ext-file') {
      const file = e.target.files?.[0];
      e.target.value = '';
      void importFile(file);
    } else if (e.target.id === 'mix-track') choose(e.target.value);
  });
  panel.addEventListener('input', e => {
    if (e.target.id === 'mix-ai-strength') $('mix-ai-strength-label').textContent = e.target.value + '%';
    else if (e.target.id === 'mix-seek') seek(Number(e.target.value) / 1000);
  });
  panel.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.id === 'ext-import') $('ext-file').click();
    else if (button.id === 'rec-go') {
      button.disabled = true;
      try {
        if (recording) await stopRecording(true);
        else await startRecording();
      } finally {
        button.disabled = false;
      }
    } else if (button.id === 'mix-ai-go') {
      const instrument = $('mix-ai-instrument').value.trim();
      if (!instrument) return toast('Enter the instrument you want to add.');
      button.disabled = true;
      try {
        await api(`/api/stems/${selected}/layer`, 'POST', {
          instrument,
          ...(timeline.selection() ? { start: timeline.selection().a, end: timeline.selection().b } : {}),
          strength: Number($('mix-ai-strength').value) / 100,
          finish: $('mix-ai-finish').value,
        });
        $('mix-ai-instrument').value = '';
        toast('Generation started. The instrument will appear below when it is ready.');
      } catch (err) {
        toast(err.message);
        button.disabled = false;
      }
    } else if (button.id === 'mix-play') playing ? pause() : play();
    else if (button.id === 'mix-reset') {
      settings = fresh();
      for (const l of layers()) settings[l.id] = blank();
      timeline.load(null);
      saveClips();
      timeline.render();
      applyAll();
      saveSettings();
      paintTracks();
    } else if (button.id === 'mix-separate') {
      button.disabled = true;
      try {
        await api(`/api/stems/${selected}/separate`, 'POST', {});
      } catch (err) {
        toast(err.message);
      }
    } else if (button.id === 'mix-export') {
      button.disabled = true;
      button.textContent = 'Creating mix…';
      try {
        await api(`/api/stems/${selected}/export`, 'POST', {
          tracks: Object.fromEntries(keys().map(n => [n, entry(n)])),
          clips: playbackClips(),
          bpm: Math.round((timeline.bpm() || 100) * 100) / 100,
          lanes: lanes.map(l => l.id),
        });
        toast('Mix saved as a new track in your library.');
        onExported?.();
      } catch (err) {
        toast(err.message);
      } finally {
        button.disabled = false;
        button.textContent = 'Save mix as a new track';
      }
    }
  });
  paintTracks();
  paintAiRange(null);
  try {
    const saved = JSON.parse(localStorage.getItem('sonora-rec') || 'null');
    if (saved?.channels && [...$('rec-channels').options].some(o => o.value === saved.channels))
      $('rec-channels').value = saved.channels;
  } catch {}
  void refreshDevices();
  // Space bar plays/pauses while the mixer is open, except when typing in a text field.
  const typing = el =>
    el?.isContentEditable ||
    el?.tagName === 'TEXTAREA' ||
    el?.tagName === 'SELECT' ||
    (el?.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox');
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || !active || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target))
      return;
    if (panel.hidden || $('mix-workspace').hidden || !Object.keys(buffers).length) return;
    e.preventDefault();
    playing ? pause() : play();
  });
  // A focused button would also "click" on space release: swallow that so it does not fire a second action.
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && active && !typing(e.target) && e.target.tagName === 'BUTTON')
      e.preventDefault();
  });
  return {
    render,
    setActive(value) {
      active = value;
      if (!value) pause();
      else render();
    },
    open(id) {
      openView();
      $('mix-track').dataset.key = '';
      choose(id);
      render();
    },
    pause,
  };
}
