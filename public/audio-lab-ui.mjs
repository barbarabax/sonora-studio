// @codedna
// description: Audio Lab panel: real-time mastering chain with live A/B monitor, 10-band EQ, spectrum, analysis and export.
// 
//
// 
//
// 
//
// exports: initAudioLab
// used_by: sonora-studio/public/app.js
// rules:   Escape stored titles; never autoplay; AI requests only after an explicit click; the live chain must match audio_lab_dsp.py.
// agent:   Claude - 2026-10-04 - Audio Lab integration; real-time layout moof thed on barichord.com/lab.
import {
  EQ_BANDS,
  EQ_Q,
  EQ_RANGE,
  HIGH_PASS_HZ,
  BUTTERWORTH_Q,
  COMPRESSORS,
  REVERBS,
  WET_LOWPASS,
  NEUTRAL,
  qToDb,
  impulse,
  integratedLufs,
} from './audio-lab-dsp.mjs';

const PRESETS = {
  neutral: ['Neutro', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  vocal: ['More forward vocals', [0, 0, 0, -1, -1, 0, 1.5, 2.5, 1, 0]],
  warm: ['Calore', [1, 1.5, 1.5, 1, 0, 0, -0.5, -1, -1, -0.5]],
  bright: ['Brillantezza', [0, 0, 0, 0, 0, 0, 0.5, 1.5, 2.5, 3]],
  mud: ['Meno fango', [0, 0, -0.5, -2, -1.5, 0, 0, 0, 0, 0]],
  bass: ['Fuller bass', [2, 2.5, 1.5, 0, 0, 0, 0, 0, 0, 0]],
  smile: ['Curva a sorriso', [2, 1.5, 0.5, 0, -1, -1, 0, 1, 2, 2]],
};
const LOUDNESS = [
  [-20, '-20 LUFS · molto dinamico'],
  [-18, '-18 LUFS · dinamico'],
  [-16, '-16 LUFS · Apple Music'],
  [-14, '-14 LUFS · Spotify, YouTube'],
  [-12, '-12 LUFS · louder'],
  [-10, '-10 LUFS · club'],
  [-9, '-9 LUFS · molto forte'],
];
const PEAKS = [
  [-2, '-2 dBTP · extra sicuro (MP3/AAC)'],
  [-1, '-1 dBTP · sicuro'],
  [-0.5, '-0,5 dBTP'],
  [-0.1, '-0,1 dBTP · massimo'],
];
const MODE_LABELS = {
  compressor: {
    off: 'Spento',
    gentle: 'Delicato · -18 dB 2:1',
    tight: 'Compatto · -22 dB 3,5:1',
    punch: 'Incisivo · -24 dB 5:1',
  },
  reverb: { off: 'Spento', small: 'Piccolo', studio: 'Studio', large: 'Ampio' },
};
const ICONS = {
  start: 'M6 5v14 M18 5 9 12l9 7V5Z',
  back: 'M11 5 3 12l8 7V5Z M21 5l-8 7 8 7V5Z',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M7 5h3v14H7z M14 5h3v14h-3z',
  stop: 'M6 6h12v12H6z',
  forward: 'M13 5l8 7-8 7V5Z M3 5l8 7-8 7V5Z',
  end: 'M18 5v14 M6 5l9 7-9 7V5Z',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const MONITOR = {
  processed: 'Elaborato',
  original: 'Original',
  master: 'Master esportato',
  reference: 'Reference',
};
const ROWS = [
  ['Loudness integrata', 'loudness.integrated', 'LUFS'],
  ['True peak', 'loudness.truePeak', 'dBTP'],
  ['Sample peak', 'loudness.samplePeak', 'dBFS'],
  ['PLR · picco meno loudness', 'loudness.plr', 'dB'],
  ['Fattore di cresta', 'loudness.crest', 'dB'],
  ['Loudness range (LRA)', 'loudness.lra', 'LU'],
  ['Sub · 20–60 Hz', 'spectrum.bands.sub', '%'],
  ['Bass · 60–250 Hz', 'spectrum.bands.bass', '%'],
  ['Mids · 250 Hz–2 kHz', 'spectrum.bands.lowMid', '%'],
  ['Presenza · 2–6 kHz', 'spectrum.bands.presence', '%'],
  ['Aria · 6–20 kHz', 'spectrum.bands.air', '%'],
  ['Pendenza spettrale', 'spectrum.tilt', 'dB/ottava', 2],
  ['Centroide spettrale', 'spectrum.centroid', 'Hz', 0],
  ['Correlazione stereo', 'stereo.correlation', '', 2],
  ['Bass correlation · below 150 Hz', 'stereo.lowCorrelation', '', 2],
  ['Ampiezza stereo', 'stereo.width', '%'],
  ['Bilanciamento sinistra/destra', 'stereo.balance', 'dB'],
  ['Perdita in mono', 'stereo.monoLoss', 'dB'],
  ['Clipped sections', 'integrity.clippedRuns', '', 0],
  ['DC offset', 'integrity.dcOffset', '%', 3],
  ['Silenzio iniziale', 'integrity.headSilence', 's', 2],
  ['Silenzio finale', 'integrity.tailSilence', 's', 2],
  ['Noise floor', 'integrity.noiseFloor', 'dBFS'],
];

export function initAudioLab({ api, toast, pauseLibrary, openView }) {
  const panel = document.querySelector('#audio-lab');
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const time = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  const number = (value, digits = 1) =>
    value === null || value === undefined || !Number.isFinite(Number(value))
      ? '—'
      : Number(value).toLocaleString('en-GB', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });
  const signed = (value, digits = 1) => (Number(value) > 0 ? '+' : '') + number(value, digits);
  const pick = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
  const date = value =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  const options = list => list.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const store = {
    get: key => {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
  panel.innerHTML = `<div class="lab-shell">
    <aside class="lab-side">
      <section class="lab-card"><div class="lab-card-title">EQ grafico · 10 bande<button id="lab-eq-reset" class="lab-mini">Azzera EQ</button></div>
        <div class="lab-eq">${EQ_BANDS.map((f, i) => `<label class="lab-band"><output id="lab-eq-${i}-value">0</output><input id="lab-eq-${i}" data-band="${i}" type="range" min="-${EQ_RANGE}" max="${EQ_RANGE}" step="0.5" value="0" aria-label="Banda ${f} Hz"><span>${f < 1000 ? f : f / 1000 + 'k'}</span></label>`).join('')}</div>
        <div class="lab-preset-row"><select id="lab-preset" aria-label="EQ preset"></select><button id="lab-preset-save" class="lab-mini" title="Save as preset">Save</button><button id="lab-preset-delete" class="lab-mini" title="Delete personal preset">Delete</button></div></section>
      <section class="lab-card"><div class="lab-card-title">Bilanciamento frequenze<span id="lab-balance-source" class="lab-hint-inline"></span></div>
        <div class="lab-balance">${['low', 'mid', 'high'].map(k => `<div><i id="lab-balance-${k}"></i><span>${{ low: 'BASS', mid: 'MIDS', high: 'TREBLE' }[k]}</span></div>`).join('')}</div></section>
      <section class="lab-card"><div class="lab-card-title">Effetti</div>
        <label for="lab-compressor">Compressor</label><select id="lab-compressor">${options(Object.entries(MODE_LABELS.compressor))}</select>
        <label for="lab-width">Ampiezza stereo <output id="lab-width-value"></output></label><input id="lab-width" type="range" min="0.5" max="1.5" step="0.05" value="1">
        <label for="lab-reverb">Riverbero</label><select id="lab-reverb">${options(Object.entries(MODE_LABELS.reverb))}</select>
        <p class="lab-note">30 Hz filter → EQ → compressor → stereo width → reverb. Reverb does not extend the track.</p></section>
    </aside>
    <div class="lab-main">
      <div class="lab-drop"><div class="lab-drop-row"><select id="lab-source" aria-label="Track da masterizzare"></select><label class="lab-file" for="lab-import">Upload another audio file</label><input id="lab-import" type="file" accept="audio/*" hidden></div>
        <div class="lab-status-row"><p id="lab-status" role="status">Choose a track from your library, an editor mix or upload a file (up to 150 MB and 10 minutes).</p><button id="lab-cancel" class="lab-mini" hidden>Cancel</button><button id="lab-analyze" class="lab-mini" hidden>Re-analyze</button><button id="lab-remove" class="lab-mini" hidden>Remove session</button></div><p id="lab-error" class="error" hidden></p></div>
      <div id="lab-workspace" hidden>
        <details class="lab-card lab-ai" open><summary>AI analysis · <span id="lab-ai-provider">AI</span> <span class="lab-hint-inline">optional; uses your credits</span></summary>
          <p id="lab-ai-explain" class="lab-note">Runs only when you select the button.</p>
          <label class="lab-check lab-listen-check" id="lab-listen-row" hidden><input id="lab-listen" type="checkbox" checked> Let AI listen to an excerpt (45 sec of track, 30 sec of reference)</label>
          <div class="lab-ai-row"><input id="lab-goal" maxlength="500" placeholder="Optional goal, e.g. clearer vocals or a streaming master"><button id="lab-advice" class="pill-button">Ask AI for suggestions</button></div><p id="lab-ai-status" class="lab-note"></p><div id="lab-advice-result"></div>
          <div class="lab-ai-row lab-ref-row"><label class="pill-button subtle lab-file-inline" for="lab-ref-import">Load a reference</label><input id="lab-ref-import" type="file" accept="audio/*" hidden><span id="lab-ref-status" class="lab-note"></span></div></details>
        <section class="lab-card lab-player">
          <div class="lab-wave-label">PROCESSED · EQ + EFFECTS <span id="lab-render-status"></span></div><canvas id="lab-wave-processed" class="lab-wave" aria-label="Forma d’onda elaborata, clic per spostarti"></canvas>
          <canvas id="lab-ruler" class="lab-ruler" aria-hidden="true"></canvas>
          <div class="lab-wave-label">ORIGINAL</div><canvas id="lab-wave-original" class="lab-wave" aria-label="Forma d’onda originale, clic per spostarti"></canvas>
          <div class="lab-transport"><button data-transport="start" aria-label="Start">${svg('start')}</button><button data-transport="back" aria-label="Back 10 seconds">${svg('back')}</button><button id="lab-play" class="lab-play" aria-label="Play">${svg('play')}</button><button data-transport="stop" aria-label="Stop">${svg('stop')}</button><button data-transport="forward" aria-label="Forward 10 seconds">${svg('forward')}</button><button data-transport="end" aria-label="Last 10 seconds">${svg('end')}</button><span id="lab-clock" class="lab-clock">0:00 / 0:00</span></div>
          <div class="lab-monitor-row"><label class="lab-check"><input id="lab-match" type="checkbox" checked> Level compensato</label><span class="lab-hint-inline">Listening</span><div class="lab-monitor" role="group" aria-label="Che cosa ascolti">${Object.entries(
            MONITOR
          )
            .map(([k, v]) => `<button data-monitor="${k}">${v}</button>`)
            .join('')}</div></div>
          <p id="lab-level-note" class="lab-note"></p>
          <div class="lab-wave-label">MONITOR DI SPETTRO <span class="lab-hint-inline"><b class="lab-key-proc"></b>elaborato <b class="lab-key-orig"></b>originale</span></div><canvas id="lab-spectrum" class="lab-spectrum" aria-hidden="true"></canvas></section>
        <section class="lab-card lab-output"><div class="lab-output-grid">
          <div><label for="lab-target">Loudness obiettivo</label><select id="lab-target">${options(LOUDNESS)}</select></div>
          <div><label for="lab-ceiling">Limite di picco</label><select id="lab-ceiling">${options(PEAKS)}</select></div>
          <div><label for="lab-metadata">Metadati</label><select id="lab-metadata">${options([
            ['keep', 'Conserva titolo e tag'],
            ['strip', 'Remove all tags'],
          ])}</select></div>
          <div class="lab-export-box"><button id="lab-export" class="pill-button lab-export">Export master</button><label class="lab-check"><input id="lab-to-library" type="checkbox" checked> Add to library</label></div></div>
          <p class="lab-note">Real-time playback uses the same processing chain as the master export. Export adds loudness normalization and a true-peak limiter, then saves 24-bit FLAC and 320 kbps MP3.</p>
          <div id="lab-masters" class="lab-masters"></div></section>
        <details class="lab-card"><summary>All measurements</summary><div class="lab-table-wrap"><table id="lab-table" class="lab-table"></table></div>
          <p class="lab-note">EBU R128 / ITU-R BS.1770 loudness and true peak with 4× oversampling; LRA follows EBU Tech 3342. Tempo and key are estimates. Measurements alone do not prove a musical improvement; listen and decide.</p></details>
      </div>
    </div>
    <aside class="lab-side" id="lab-facts-column"><section class="lab-card"><div class="lab-card-title">Analisi in ingresso</div><div id="lab-facts"><p class="lab-note">No track analyzed.</p></div></section></aside>
  </div>`;
  const $ = id => panel.querySelector('#' + id);
  let state = {},
    sessionId = null,
    appliedSession = null,
    active = false,
    aiAvailable = false,
    aiInfo = {},
    adviceSig = '',
    tableSig = '',
    factsSig = '',
    mastersSig = '',
    sourceOptions = '',
    masterId = null;
  let ctx = null,
    live = null,
    buffers = {},
    bytes = {},
    loadedSession = null,
    loading = false,
    sources = [],
    playing = false,
    startedAt = 0,
    offset = 0,
    monitor = 'processed',
    frame = null,
    processedLufs = null,
    processedPeak = null,
    renderToken = 0,
    renderTimer = null,
    peakCache = {};
  const session = () => state.audioLab?.sessions.find(s => s.id === sessionId);
  const busy = s => ['queued', 'processing'].includes(s?.status);
  const master = () => session()?.renders.find(r => r.id === masterId);

  // ---------------------------------------------------------------- settings
  function values() {
    return {
      eq: EQ_BANDS.map((_, i) => Number($('lab-eq-' + i).value)),
      compressor: $('lab-compressor').value,
      reverb: $('lab-reverb').value,
      width: Number($('lab-width').value),
      targetLufs: Number($('lab-target').value),
      ceiling: Number($('lab-ceiling').value),
      metadata: $('lab-metadata').value,
    };
  }
  function ensureOption(select, value, label) {
    if (![...select.options].some(o => Number(o.value) === Number(value))) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.append(o);
    }
    select.value = String(value);
  }
  function setValues(v, { silent = false } = {}) {
    v = { ...NEUTRAL, ...v };
    EQ_BANDS.forEach((_, i) => {
      $('lab-eq-' + i).value = v.eq[i] ?? 0;
    });
    $('lab-compressor').value = v.compressor;
    $('lab-reverb').value = v.reverb;
    $('lab-width').value = v.width;
    $('lab-metadata').value = v.metadata;
    ensureOption($('lab-target'), v.targetLufs, `${number(v.targetLufs)} LUFS`);
    ensureOption($('lab-ceiling'), v.ceiling, `${number(v.ceiling)} dBTP`);
    labels();
    if (!silent) changed();
  }
  function labels() {
    EQ_BANDS.forEach((_, i) => {
      $('lab-eq-' + i + '-value').textContent = signed(
        $('lab-eq-' + i).value,
        Number($('lab-eq-' + i).value) % 1 ? 1 : 0
      );
    });
    $('lab-width-value').textContent =
      Math.round(Number($('lab-width').value) * 100) +
      '%' +
      (Number($('lab-width').value) === 1 ? ' · originale' : '');
  }
  function changed() {
    labels();
    const v = values();
    if (live) live.chain.apply(v);
    if (sessionId) store.set('sonora-lab-draft-' + sessionId, v);
    scheduleRender();
    updateLevels();
    adviceView(session());
  }
  function presetOptions() {
    const custom = store.get('sonora-lab-presets-v1') || {};
    $('lab-preset').innerHTML =
      '<option value="">Load a preset…</option>' +
      Object.entries(PRESETS)
        .map(([k, [label]]) => `<option value="builtin:${k}">${label}</option>`)
        .join('') +
      (Object.keys(custom).length
        ? `<optgroup label="I tuoi preset">${Object.keys(custom)
            .map(name => `<option value="custom:${esc(name)}">${esc(name)}</option>`)
            .join('')}</optgroup>`
        : '');
  }

  // ---------------------------------------------------------------- audio engine
  function buildChain(c, v) {
    const fixed = n => {
      n.channelCount = 2;
      n.channelCountMode = 'explicit';
      n.channelInterpretation = 'speakers';
      return n;
    };
    const biquad = (type, f, q) => {
      const b = fixed(c.createBiquadFilter());
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const hp = biquad('highpass', HIGH_PASS_HZ, qToDb(BUTTERWORTH_Q));
    const eq = EQ_BANDS.map(f => {
      const b = biquad('peaking', f, EQ_Q);
      b.gain.value = 0;
      return b;
    });
    const comp = new AudioWorkletNode(c, 'sonora-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { preset: COMPRESSORS[v.compressor] || null },
    });
    const split = c.createChannelSplitter(2),
      merge = c.createChannelMerger(2),
      [ll, rl, lr, rr] = [0, 0, 0, 0].map(() => c.createGain());
    split.connect(ll, 0);
    split.connect(lr, 0);
    split.connect(rl, 1);
    split.connect(rr, 1);
    ll.connect(merge, 0, 0);
    rl.connect(merge, 0, 0);
    lr.connect(merge, 0, 1);
    rr.connect(merge, 0, 1);
    const dry = c.createGain(),
      conv = c.createConvolver(),
      wet = c.createGain(),
      out = c.createGain();
    conv.normalize = false;
    const wetFilters = Array.from({ length: WET_LOWPASS[1] }, () =>
      biquad('lowpass', WET_LOWPASS[0], qToDb(BUTTERWORTH_Q))
    );
    [hp, ...eq, comp, split].reduce((a, b) => {
      a.connect(b);
      return b;
    });
    merge.connect(dry);
    merge.connect(conv);
    [conv, ...wetFilters, wet].reduce((a, b) => {
      a.connect(b);
      return b;
    });
    dry.connect(out);
    wet.connect(out);
    let reverbMode = null,
      compressor = v.compressor;
    function apply(v, instant = false) {
      const set = (param, x) =>
        instant ? (param.value = x) : param.setTargetAtTime(x, c.currentTime, 0.015);
      eq.forEach((b, i) => set(b.gain, EQ_BANDS[i] < c.sampleRate * 0.49 ? v.eq[i] : 0));
      if (v.compressor !== compressor) {
        compressor = v.compressor;
        comp.port.postMessage(COMPRESSORS[v.compressor] || null);
      }
      set(ll.gain, (1 + v.width) / 2);
      set(rr.gain, (1 + v.width) / 2);
      set(lr.gain, (1 - v.width) / 2);
      set(rl.gain, (1 - v.width) / 2);
      if (REVERBS[v.reverb] && v.reverb !== reverbMode) {
        const ir = Float32Array.from(impulse(c.sampleRate, v.reverb)),
          buffer = c.createBuffer(2, ir.length, c.sampleRate);
        buffer.copyToChannel(ir, 0);
        buffer.copyToChannel(ir, 1);
        conv.buffer = buffer;
      }
      reverbMode = v.reverb;
      const mix = REVERBS[v.reverb]?.[1] ?? 0;
      set(dry.gain, 1 - mix);
      set(wet.gain, mix);
    }
    apply(v, true);
    return { input: hp, output: out, apply };
  }
  async function ensureContext(rate) {
    if (ctx && ctx.sampleRate === rate) return;
    stop();
    if (ctx) await ctx.close();
    ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
    buffers = {};
    peakCache = {};
    await ctx.audioWorklet.addModule('/audio-lab-worklet.js');
    const gain = () => ctx.createGain(),
      analyser = () => {
        const a = ctx.createAnalyser();
        a.fftSize = 4096;
        a.smoothingTimeConstant = 0.75;
        return a;
      };
    live = {
      chain: buildChain(ctx, values()),
      trim: { processed: gain(), original: gain(), master: gain(), reference: gain() },
      mon: { processed: gain(), original: gain(), master: gain(), reference: gain() },
      analyser: { processed: analyser(), original: analyser() },
      bus: gain(),
      limiter: ctx.createDynamicsCompressor(),
    };
    // Monitoring safety only (not part of the master): catches overs when the real-level view boosts the signal.
    live.limiter.threshold.value = -1;
    live.limiter.knee.value = 0;
    live.limiter.ratio.value = 20;
    live.limiter.attack.value = 0.001;
    live.limiter.release.value = 0.1;
    live.chain.output.connect(live.trim.processed);
    for (const k of Object.keys(MONITOR)) {
      live.trim[k].connect(live.mon[k]);
      live.mon[k].connect(live.bus);
      live.mon[k].gain.value = k === monitor ? 1 : 0;
    }
    live.trim.processed.connect(live.analyser.processed);
    live.trim.original.connect(live.analyser.original);
    live.bus.connect(live.limiter).connect(ctx.destination);
  }
  async function decode(name, route) {
    if (buffers[name]) return buffers[name];
    bytes[route] ??= await fetch(route).then(r => {
      if (!r.ok) throw new Error('Audio unavailable.');
      return r.arrayBuffer();
    });
    buffers[name] = await ctx.decodeAudioData(bytes[route].slice(0));
    return buffers[name];
  }
  const route = (s, kind, id) => `/api/audio-lab/${s.id}/audio?kind=${kind}${id ? '&id=' + id : ''}`;
  async function loadSession(s) {
    if (loadedSession === s.id || loading) return;
    loading = true;
    const id = s.id;
    $('lab-play').disabled = true;
    $('lab-render-status').textContent = '· loading audio…';
    try {
      bytes = {};
      await ensureContext(s.analysis.technical.sampleRate || 48000);
      buffers = {};
      peakCache = {};
      await decode('original', route(s, 'source'));
      if (sessionId !== id) return;
      loadedSession = id;
      offset = 0;
      processedLufs = null;
      live.chain.apply(values(), true);
      $('lab-play').disabled = false;
      drawAll();
      scheduleRender(0);
      updateLevels();
    } catch (e) {
      toast(e.message);
    } finally {
      loading = false;
      if (loadedSession !== id) $('lab-render-status').textContent = '';
    }
  }
  async function loadExtra(name) {
    const s = session();
    if (!s || !ctx) return false;
    if (name === 'reference' && !s.reference) return false;
    if (name === 'master' && !master()) return false;
    const key = name === 'master' ? 'master:' + masterId : 'reference:' + s.reference.createdAt;
    if (buffers[name] && buffers[name + 'Key'] === key) return true;
    const resume = playing;
    if (resume) pause();
    try {
      delete buffers[name];
      await decode(name, name === 'master' ? route(s, 'render', masterId) : route(s, 'reference'));
      Object.defineProperty(buffers, name + 'Key', { value: key, writable: true, configurable: true });
    } catch (e) {
      toast(e.message);
      return false;
    }
    if (resume) void play();
    return true;
  }
  const duration = () => buffers.original?.duration || 0;
  const position = () => (playing ? Math.min(duration(), ctx.currentTime - startedAt) : offset);
  function startSources(at) {
    const t = ctx.currentTime + 0.03;
    sources = [];
    const make = (buffer, targets) => {
      if (!buffer || at >= buffer.duration) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      for (const n of targets) src.connect(n);
      src.start(t, at);
      sources.push(src);
    };
    make(buffers.original, [live.chain.input, live.trim.original]);
    make(buffers.master, [live.trim.master]);
    make(buffers.reference, [live.trim.reference]);
    startedAt = t - at;
  }
  async function play() {
    if (!buffers.original) return;
    if (playing) {
      pause();
      return;
    }
    pauseLibrary();
    await ctx.resume();
    if (offset >= duration() - 0.05) offset = 0;
    startSources(offset);
    playing = true;
    $('lab-play').innerHTML = svg('pause');
    $('lab-play').setAttribute('aria-label', 'Pause');
    tick();
  }
  function pause() {
    if (!playing) return;
    offset = position();
    for (const s of sources)
      try {
        s.stop();
      } catch {}
    sources = [];
    playing = false;
    cancelAnimationFrame(frame);
    $('lab-play').innerHTML = svg('play');
    $('lab-play').setAttribute('aria-label', 'Play');
    drawAll();
  }
  function stop() {
    pause();
    offset = 0;
    if (buffers.original) drawAll();
  }
  function seek(at) {
    const resume = playing;
    pause();
    offset = Math.max(0, Math.min(duration(), at));
    drawAll();
    if (resume) void play();
  }
  function tick() {
    drawAll();
    drawSpectrum();
    if (playing && position() >= duration()) {
      pause();
      offset = 0;
      drawAll();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  async function setMonitor(name) {
    if (name === 'master' && !(await loadExtra('master')))
      return toast('Export a master before listening here.');
    if (name === 'reference' && !(await loadExtra('reference')))
      return toast('Load a reference track first.');
    monitor = name;
    panel
      .querySelectorAll('[data-monitor]')
      .forEach(b => b.classList.toggle('selected', b.dataset.monitor === name));
    if (live)
      for (const [k, g] of Object.entries(live.mon))
        g.gain.setTargetAtTime(k === name ? 1 : 0, ctx.currentTime, 0.008);
    updateLevels();
    drawAll();
  }

  // Loudness of each source: Python measured the original, master and reference; the browser renders
  // the processed chain offline and measures it with the same BS.1770 meter.
  function levels() {
    const s = session(),
      v = values(),
      src = s?.analysis?.loudness?.integrated;
    return {
      original: src,
      processed: processedLufs ?? src,
      master: master()?.analysis?.loudness?.integrated,
      reference: s?.reference?.analysis?.loudness?.integrated,
      target: v.targetLufs,
    };
  }
  function updateLevels() {
    if (!live) return;
    const L = levels(),
      match = $('lab-match').checked,
      known = Object.entries(L).filter(
        ([k, v]) =>
          k !== 'target' &&
          Number.isFinite(v) &&
          (k !== 'master' || buffers.master) &&
          (k !== 'reference' || buffers.reference)
      );
    const floor = Math.min(...known.map(([, v]) => v));
    for (const k of Object.keys(MONITOR)) {
      let db = 0;
      if (Number.isFinite(L[k])) {
        if (match) db = floor - L[k];
        else if (k === 'processed') db = L.target - L.processed;
      }
      live.trim[k].gain.setTargetAtTime(10 ** (db / 20), ctx.currentTime, 0.05);
    }
    const exportGain = Number.isFinite(L.processed) ? L.target - L.processed : null;
    $('lab-level-note').textContent = match
      ? `Loudness-matched playback: all sources use the same loudness (${number(floor)} LUFS), so louder audio does not win the comparison.`
      : `Original level versus processed level at ${number(L.target)} LUFS, as in the export${exportGain != null ? ` (${signed(exportGain)} dB)` : ''}. A safety limiter prevents distortion during playback.`;
    renderFacts(true);
  }
  function scheduleRender(delay = 600) {
    clearTimeout(renderTimer);
    if (!buffers.original) return;
    $('lab-render-status').textContent = '· aggiornamento…';
    renderTimer = setTimeout(async () => {
      const token = ++renderToken,
        v = values(),
        src = buffers.original;
      try {
        const off = new OfflineAudioContext(2, src.length, src.sampleRate);
        await off.audioWorklet.addModule('/audio-lab-worklet.js');
        const chain = buildChain(off, v),
          node = off.createBufferSource();
        node.buffer = src;
        node.connect(chain.input);
        chain.output.connect(off.destination);
        node.start();
        const out = await off.startRendering();
        if (token !== renderToken) return;
        const channels = [out.getChannelData(0), out.getChannelData(1)];
        processedLufs = integratedLufs(channels, out.sampleRate);
        let peak = 0;
        for (const ch of channels)
          for (let i = 0; i < ch.length; i++) {
            const a = Math.abs(ch[i]);
            if (a > peak) peak = a;
          }
        processedPeak = peak;
        buffers.processedPreview = out;
        delete peakCache.processed;
        $('lab-render-status').textContent = `· ${number(processedLufs)} LUFS before normalization`;
        updateLevels();
        drawAll();
      } catch (e) {
        if (token === renderToken) $('lab-render-status').textContent = '· anteprima grafica unavailable';
        console.warn(e);
      }
    }, delay);
  }

  // ---------------------------------------------------------------- drawing
  function peaksOf(name, buffer, columns) {
    const key = name + ':' + columns;
    if (peakCache[name]?.key === key) return peakCache[name].data;
    const a = buffer.getChannelData(0),
      b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a,
      step = Math.max(1, Math.floor(a.length / columns)),
      data = new Float32Array(columns);
    for (let x = 0; x < columns; x++) {
      let p = 0;
      const start = x * step,
        end = Math.min(a.length, start + step);
      for (let i = start; i < end; i += 4) {
        const v = Math.max(Math.abs(a[i]), Math.abs(b[i]));
        if (v > p) p = v;
      }
      data[x] = p;
    }
    peakCache[name] = { key, data };
    return data;
  }
  function canvas(id, height) {
    const c = $(id),
      w = Math.max(1, c.clientWidth),
      dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== height * dpr) {
      c.width = Math.round(w * dpr);
      c.height = height * dpr;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, height);
    return [g, w];
  }
  function drawWave(id, name, buffer, color, dim) {
    const [g, w] = canvas(id, 74);
    if (!buffer) return;
    const cols = Math.floor(w / 2),
      data = peaksOf(name, buffer, cols),
      at = duration() ? position() / duration() : 0;
    for (let x = 0; x < cols; x++) {
      const h = Math.max(1.5, Math.min(1, data[x]) * 66);
      g.fillStyle = x / cols < at ? color : dim;
      g.fillRect(x * 2, (74 - h) / 2, 1.4, h);
    }
    g.fillStyle = '#ffffffcc';
    g.fillRect(at * w, 0, 1.5, 74);
  }
  function drawAll() {
    const total = duration(),
      now = position();
    $('lab-clock').textContent = `${time(now)} / ${time(total)}`;
    const listenProcessed = monitor === 'processed';
    drawWave(
      'lab-wave-processed',
      'processed',
      buffers.processedPreview || buffers.original,
      listenProcessed ? '#f0b18f' : '#a58371',
      listenProcessed ? '#6d5446' : '#4c3f37'
    );
    drawWave(
      'lab-wave-original',
      'original',
      buffers.original,
      monitor === 'original' ? '#b8c9a7' : '#7f8c74',
      monitor === 'original' ? '#4d5745' : '#3b4237'
    );
    const [g, w] = canvas('lab-ruler', 18);
    if (!total) return;
    const stepS = total > 240 ? 60 : total > 90 ? 30 : total > 40 ? 10 : 5;
    g.fillStyle = '#8a8f88';
    g.font = '9px Inter, Segoe UI, sans-serif';
    for (let s = 0; s <= total; s += stepS) {
      const x = (s / total) * w;
      g.fillRect(x, 0, 1, 5);
      g.fillText(time(s), Math.min(x + 3, w - 24), 15);
    }
  }
  function drawSpectrum() {
    if (!live) return;
    const [g, w] = canvas('lab-spectrum', 110),
      bins = live.analyser.processed.frequencyBinCount,
      rate = ctx.sampleRate;
    const curve = (analyser, stroke, fill) => {
      const data = new Float32Array(bins);
      analyser.getFloatFrequencyData(data);
      g.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const f = 20 * Math.pow(1000, x / w),
          i = Math.min(bins - 1, Math.round((f / (rate / 2)) * bins)),
          db = Math.max(-140, Math.min(-20, data[i]));
        const y = 110 - ((db + 140) / 120) * 104;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      if (fill) {
        g.lineTo(w, 110);
        g.lineTo(0, 110);
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      } else {
        g.strokeStyle = stroke;
        g.lineWidth = 1.2;
        g.stroke();
      }
      return data;
    };
    g.fillStyle = '#ffffff10';
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log10(f / 20) / 3) * w;
      g.fillRect(x, 0, 1, 110);
    }
    const p = curve(live.analyser.processed, null, '#f0b18f55');
    curve(live.analyser.original, '#b8c9a7');
    // Live balance of the processed output: average level per band on a log-frequency scale, so an EQ move is visible.
    const sums = [0, 0, 0],
      counts = [0, 0, 0];
    for (let x = 0; x < 240; x++) {
      const f = 20 * Math.pow(1000, x / 240),
        i = Math.min(bins - 1, Math.round((f / (rate / 2)) * bins)),
        band = f < 250 ? 0 : f < 4000 ? 1 : 2;
      sums[band] += Math.max(-160, p[i]);
      counts[band]++;
    }
    setBalance(
      sums.map((v, i) => v / counts[i]),
      'live, elaborato',
      -140,
      100
    );
  }
  // levels in dB; bar height maps [floor, floor+span] to 0–100%
  function setBalance(levels, label, floor, span) {
    ['low', 'mid', 'high'].forEach((k, i) => {
      const pct = Math.max(3, Math.min(100, ((levels[i] - floor) / span) * 100));
      $('lab-balance-' + k).style.height = pct + '%';
      $('lab-balance-' + k).title = number(levels[i]) + ' dB';
    });
    $('lab-balance-source').textContent = label;
  }

  // ---------------------------------------------------------------- panels
  function renderFacts(force = false) {
    const s = session(),
      a = s?.analysis;
    if (!a) {
      $('lab-facts').innerHTML = '<p class="lab-note">No track analyzed.</p>';
      factsSig = '';
      return;
    }
    const sig = JSON.stringify([s.id, s.analyzedAt, processedLufs, processedPeak, values().targetLufs]);
    if (!force && sig === factsSig) return;
    factsSig = sig;
    const t = a.technical,
      l = a.loudness,
      i = a.integrity,
      m = a.musical,
      tags = t.tags || {},
      target = values().targetLufs;
    const row = (k, v) => `<div class="lab-fact"><span>${k}</span><b>${v}</b></div>`;
    $('lab-facts').innerHTML =
      `<div class="lab-big"><b>${number(l.integrated)} LUFS</b><span>Loudness integrata</span></div><div class="lab-big"><b>${number(l.truePeak)} dBTP</b><span>True peak</span></div>
      ${processedLufs != null ? `<div class="lab-sub-title">Elaborato · stima in tempo reale</div>${row('Before normalization', number(processedLufs) + ' LUFS')}${row('Sample peak', number(20 * Math.log10(processedPeak || 1e-9)) + ' dBFS')}${row('Export gain', signed(target - processedLufs) + ' dB')}` : ''}
      <div class="lab-sub-title">File metadata</div>${row('Title', esc(tags.title || s.title))}${row('Artist', esc(tags.artist || '—'))}${row('Format', esc((t.codec || '').toUpperCase()))}${row('Sample rate', (t.sampleRate / 1000).toLocaleString('en-GB') + ' kHz')}${row('Bit', t.bitDepth || '—')}${row('Duration', number(t.duration, 1) + ' s')}
      <div class="lab-sub-title">Music analysis</div><div class="lab-music"><div><b>${m?.bpm ? number(m.bpm, 0) : '—'}</b><span>BPM</span></div><div><b>${esc(m?.key || '—')}</b><span>KEY</span>${m?.keyAlternative ? `<small title="The two keys are very close; check by listening">or ${esc(m.keyAlternative)}</small>` : ''}</div></div>
      <div class="lab-sub-title">Mix integrity</div>${row('Headroom', number(-l.truePeak) + ' dB')}${row('Noise floor', number(i.noiseFloor) + ' dBFS')}${row('DC offset', number(i.dcOffset, 3) + '%')}${row('Clipped sections', i.clippedRuns)}${row('Loudness range', number(l.lra) + ' LU')}${row('PLR', number(l.plr) + ' dB')}`;
  }
  function renderTable(s) {
    const m = s.renders[0],
      ref = s.reference?.analysis,
      cols = [
        ['Original', s.analysis],
        ['Ultimo master', m?.analysis],
        ...(ref ? [['Reference', ref]] : []),
      ];
    const sig = JSON.stringify([s.id, s.analyzedAt, m?.id, s.reference?.createdAt]);
    if (sig === tableSig) return;
    tableSig = sig;
    $('lab-table').innerHTML =
      `<thead><tr><th>Bar</th>${cols.map(([n]) => `<th>${n}</th>`).join('')}</tr></thead><tbody>${ROWS.map(
        ([label, key, unit, digits = 1]) =>
          `<tr><th>${label}</th>${cols
            .map(([, a]) => {
              const v = pick(a, key);
              return `<td>${a && v != null ? number(v, digits) + (unit ? ' ' + unit : '') : '—'}</td>`;
            })
            .join('')}</tr>`
      ).join('')}</tbody>`;
  }
  function settingsText(v) {
    return `EQ ${v.eq.map(x => signed(x, x % 1 ? 1 : 0)).join(' ')} · compressore ${MODE_LABELS.compressor[v.compressor].split(' ·')[0].toLowerCase()} · ampiezza ${Math.round(v.width * 100)}% · riverbero ${MODE_LABELS.reverb[v.reverb].toLowerCase()} · ${number(v.targetLufs)} LUFS · ${number(v.ceiling)} dBTP`;
  }
  function renderMasters(s) {
    const inLibrary = r => !!r.libraryJobId && !!state.jobs?.some(j => j.id === r.libraryJobId);
    const sig = JSON.stringify([s.id, s.renders.map(r => [r.id, inLibrary(r), r.libraryError]), masterId]);
    if (sig === mastersSig) return;
    mastersSig = sig;
    $('lab-masters').innerHTML = s.renders.length
      ? s.renders
          .map(
            r => `<div class="lab-master ${r.id === masterId ? 'selected' : ''}"><div><strong>${date(r.savedAt || r.createdAt)} · ${number(r.loudness?.reached)} LUFS · ${number(r.loudness?.truePeak)} dBTP${Math.abs(r.loudness?.gap ?? 0) > 0.5 ? ` · <em>deviation ${number(r.loudness.gap)} LU: peak limit took precedence</em>` : ''}</strong><span class="lab-note">${esc(settingsText(r.settings))}</span></div>
      <div class="lab-master-actions"><button class="lab-mini" data-master-listen="${r.id}">Listen</button><button class="lab-mini" data-master-apply="${r.id}">Use settings</button><a class="lab-mini" href="${route(s, 'render', r.id)}&download=1">FLAC</a>${r.mp3 ? `<a class="lab-mini" href="${route(s, 'render', r.id)}&format=mp3&download=1">MP3</a>` : ''}${inLibrary(r) ? '<span class="lab-mini lab-in-library">In library ✓</span>' : `<button class="lab-mini" data-master-library="${r.id}">Add to library</button>`}<button class="lab-mini" data-master-delete="${r.id}">Delete</button></div>${r.libraryError ? `<p class="error">Not added to the library: ${esc(r.libraryError)}</p>` : ''}</div>`
          )
          .join('')
      : '<p class="lab-note">No master exported yet. Adjust the sound while listening, then select Export master.</p>';
  }
  // What applying the proposal would change, compared with the controls as they are now.
  function adviceChanges(a) {
    const v = values(),
      p = a.settings,
      out = [];
    EQ_BANDS.forEach((f, i) => {
      if (p.eq[i] !== v.eq[i])
        out.push(
          `${f < 1000 ? f + ' Hz' : f / 1000 + ' kHz'} ${signed(v.eq[i], v.eq[i] % 1 ? 1 : 0)} → ${signed(p.eq[i], p.eq[i] % 1 ? 1 : 0)} dB`
        );
    });
    if (p.compressor !== v.compressor)
      out.push(
        `compressore ${MODE_LABELS.compressor[v.compressor].split(' ·')[0].toLowerCase()} → ${MODE_LABELS.compressor[p.compressor].split(' ·')[0].toLowerCase()}`
      );
    if (p.width !== v.width)
      out.push(`ampiezza ${Math.round(v.width * 100)}% → ${Math.round(p.width * 100)}%`);
    if (p.reverb !== v.reverb)
      out.push(
        `riverbero ${MODE_LABELS.reverb[v.reverb].toLowerCase()} → ${MODE_LABELS.reverb[p.reverb].toLowerCase()}`
      );
    if (p.targetLufs !== v.targetLufs)
      out.push(`loudness ${number(v.targetLufs)} → ${number(p.targetLufs)} LUFS`);
    if (p.ceiling !== v.ceiling) out.push(`ceiling ${number(v.ceiling)} → ${number(p.ceiling)} dBTP`);
    return out;
  }
  function adviceView(s) {
    const a = s?.advice,
      box = $('lab-advice-result');
    if (!a) {
      box.innerHTML = '';
      return;
    }
    const changes = adviceChanges(a),
      eqUntouched = a.settings.eq.every(x => x === 0);
    box.innerHTML = `<div class="lab-advice"><p class="lab-note">${a.heard ? `${esc(a.provider || 'AI')} listened to an excerpt and reviewed the measurements` : `${esc(a.provider || 'AI')} reviewed measurements only, without listening`}</p><p>${esc(a.summary)}</p>${a.observations.length ? `<ul>${a.observations.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      <p class="lab-note"><b>Proposta:</b> ${esc(settingsText(a.settings))}${eqUntouched ? ' · AI does not suggest EQ changes' : ''}</p>
      <p class="lab-note">${changes.length ? '<b>Changes if applied:</b> ' + changes.map(esc).join(' · ') : '<b>This suggestion already matches your settings:</b> applying it would not change anything. Ask again with a more specific goal.'}</p>
      ${a.listening.length ? `<p class="lab-note">Check by listening: ${a.listening.map(esc).join(' · ')}</p>` : ''}
      <div class="lab-ai-row"><button id="lab-apply" class="pill-button" ${changes.length ? '' : 'disabled'}>${changes.length ? 'Apply AI suggestions' : 'Nothing to apply'}</button><span class="lab-note">Changes take effect immediately. Compare with the original before exporting. ${date(a.createdAt)}</span></div></div>`;
    $('lab-apply').addEventListener('click', () => {
      const n = adviceChanges(a).length;
      setValues(a.settings);
      toast(
        `Suggerimenti applicati (${n} ${n === 1 ? 'edit' : 'modifiche'}): li stai ascoltando in tempo reale.`
      );
    });
  }
  function sourceKey(s) {
    return !s
      ? ''
      : s.source.kind === 'import'
        ? 'session:' + s.id
        : s.source.kind === 'mix'
          ? `mix:${s.source.jobId}:${s.source.mixId}`
          : 'job:' + s.source.jobId;
  }
  function findSession(key) {
    const [kind, a, b] = key.split(':');
    return state.audioLab?.sessions.find(s =>
      kind === 'session'
        ? s.id === a
        : s.source.kind === kind && s.source.jobId === a && (kind === 'job' || s.source.mixId === b)
    );
  }
  function buildSources() {
    const jobs = (state.jobs || []).filter(j => j.status === 'done' && !j.archived);
    const mixes = (state.editor?.sessions || []).flatMap(e => {
      const job = state.jobs?.find(j => j.id === e.id);
      return job ? (e.mixes || []).map((m, i) => ({ job, mix: m, n: e.mixes.length - i })) : [];
    });
    const imports = (state.audioLab?.sessions || []).filter(s => s.source.kind === 'import');
    return (
      '<option value="">Choose audio to master</option>' +
      (jobs.length
        ? `<optgroup label="Library">${jobs.map(j => `<option value="job:${j.id}">${esc(j.title)}</option>`).join('')}</optgroup>`
        : '') +
      (mixes.length
        ? `<optgroup label="Mixes exported from editor">${mixes.map(({ job, mix, n }) => `<option value="mix:${job.id}:${mix.id}">${esc(job.title)} · mix ${n} · ${date(mix.createdAt)}</option>`).join('')}</optgroup>`
        : '') +
      (imports.length
        ? `<optgroup label="Uploaded files">${imports.map(s => `<option value="session:${s.id}">${esc(s.title)}${s.status === 'failed' && !s.analysis ? ' · failed' : ''}</option>`).join('')}</optgroup>`
        : '')
    );
  }
  async function choose(key) {
    stop();
    sessionId = null;
    appliedSession = null;
    loadedSession = null;
    buffers = {};
    peakCache = {};
    processedLufs = null;
    masterId = null;
    tableSig = factsSig = mastersSig = adviceSig = '';
    if (monitor === 'master' || monitor === 'reference') void setMonitor('processed');
    $('lab-source').value = key;
    if (!key) {
      render(state);
      return;
    }
    const existing = findSession(key);
    if (existing && (existing.analysis || busy(existing) || existing.source.kind === 'import')) {
      sessionId = existing.id;
      render(state);
      return;
    }
    const [kind, jobId, mixId] = key.split(':');
    try {
      const s = await api(
        '/api/audio-lab/sessions',
        'POST',
        kind === 'mix' ? { kind, jobId, mixId } : { kind, jobId }
      );
      sessionId = s.id;
    } catch (e) {
      toast(e.message);
    }
    render(state);
  }
  async function upload(url, file) {
    if (file.size > 150 * 1024 * 1024) throw new Error('The file is larger than 150 MB.');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Sonora': '1',
        'X-Audio-Name': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error);
    return result;
  }

  function render(next) {
    state = next;
    const opts = buildSources();
    if (opts !== sourceOptions) {
      sourceOptions = opts;
      const keep = $('lab-source').value;
      $('lab-source').innerHTML = opts;
      $('lab-source').value = sessionId ? sourceKey(session()) || keep : keep;
    }
    const s = session(),
      working = busy(s),
      advising = state.audioLab?.advising?.includes(s?.id);
    $('lab-status').textContent = !state.audioLab?.available
      ? 'Local Python environment not found. See the README.'
      : !s
        ? $('lab-source').value
          ? 'Preparing session…'
          : 'Choose a track from your library, an editor mix or upload a file (up to 150 MB and 10 minutes).'
        : working
          ? s.phase
          : s.analysis
            ? `${s.title} · analyzed${s.phase === 'cancelled' ? ' · last process cancelled' : ''}`
            : s.phase || 'Waiting';
    $('lab-error').hidden = !s?.error;
    $('lab-error').textContent = s?.error || '';
    $('lab-cancel').hidden = !working;
    $('lab-analyze').hidden = !s || working || !s.analysis;
    $('lab-remove').hidden = !s || working;
    $('lab-workspace').hidden = !s?.analysis;
    if (!s?.analysis) {
      stop();
      renderFacts();
      return;
    }
    if (appliedSession !== s.id) {
      appliedSession = s.id;
      setValues(store.get('sonora-lab-draft-' + s.id) || s.settings || NEUTRAL, { silent: true });
    }
    if (!masterId || !s.renders.some(r => r.id === masterId)) masterId = s.renders[0]?.id || null;
    $('lab-export').disabled = working;
    $('lab-export').textContent = working && s.task === 'render' ? 'Esportazione…' : 'Export master';
    panel.querySelector('[data-monitor="master"]').disabled = !s.renders.length;
    panel.querySelector('[data-monitor="reference"]').disabled = !s.reference;
    $('lab-advice').disabled = working || advising || !aiAvailable;
    $('lab-advice').textContent = advising ? 'Request in progress…' : 'Ask AI for suggestions';
    $('lab-ai-status').textContent = aiAvailable
      ? ''
      : 'Configure AI in Prompt and lyrics to use suggestions.';
    $('lab-ai-provider').textContent = aiInfo.available
      ? `${aiInfo.providerName} · ${aiInfo.canListen && $('lab-listen').checked ? aiInfo.listenModel : aiInfo.model}`
      : 'not configured';
    $('lab-listen-row').hidden = !aiInfo.canListen;
    $('lab-ai-explain').textContent =
      aiInfo.canListen && $('lab-listen').checked
        ? `${aiInfo.providerName} receives measurements, settings and an audio excerpt to listen to. This runs only when you select the button.`
        : `${aiInfo.providerName || 'L’AI'} receives measurements and settings only, not audio. This runs only when you select the button.`;
    const sig = JSON.stringify([s.id, s.advice?.createdAt]);
    if (sig !== adviceSig) {
      adviceSig = sig;
      adviceView(s);
    }
    $('lab-ref-status').textContent = s.reference
      ? `Reference: ${s.reference.label} · ${number(s.reference.analysis?.loudness?.integrated)} LUFS · listen using Monitor → Reference`
      : 'Optional: a track whose sound you like, for comparison by listening and measurement.';
    $('lab-ref-import').disabled = working;
    renderFacts();
    renderTable(s);
    renderMasters(s);
    if (!playing) {
      const o = s.analysis.spectrum.octaves || [],
        avg = (lo, hi) => {
          const v = o.filter(x => x.hz >= lo && x.hz < hi).map(x => x.db);
          return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
        };
      setBalance([avg(20, 250), avg(250, 4000), avg(4000, 20001)], 'dall’analisi', -25, 40);
    }
    if (active) void loadSession(s);
  }

  // ---------------------------------------------------------------- events
  panel.addEventListener('input', e => {
    if (e.target.matches('[data-band],#lab-width')) changed();
  });
  for (const id of ['lab-compressor', 'lab-reverb', 'lab-target', 'lab-ceiling', 'lab-metadata'])
    $(id).addEventListener('change', changed);
  $('lab-eq-reset').addEventListener('click', () => {
    EQ_BANDS.forEach((_, i) => {
      $('lab-eq-' + i).value = 0;
    });
    $('lab-preset').value = '';
    changed();
  });
  $('lab-preset').addEventListener('change', () => {
    const [kind, name] = $('lab-preset').value.split(/:(.*)/s);
    if (!kind) return;
    const eq = kind === 'builtin' ? PRESETS[name][1] : (store.get('sonora-lab-presets-v1') || {})[name];
    if (!eq) return;
    eq.forEach((v, i) => {
      $('lab-eq-' + i).value = v;
    });
    changed();
  });
  $('lab-preset-save').addEventListener('click', () => {
    const name = prompt('EQ preset name:')?.trim().slice(0, 40);
    if (!name) return;
    const custom = store.get('sonora-lab-presets-v1') || {};
    custom[name] = values().eq;
    store.set('sonora-lab-presets-v1', custom);
    presetOptions();
    $('lab-preset').value = 'custom:' + name;
    toast('Preset saved in this browser.');
  });
  $('lab-preset-delete').addEventListener('click', () => {
    const [kind, name] = $('lab-preset').value.split(/:(.*)/s);
    if (kind !== 'custom') return toast('Choose one of your presets to delete.');
    const custom = store.get('sonora-lab-presets-v1') || {};
    delete custom[name];
    store.set('sonora-lab-presets-v1', custom);
    presetOptions();
  });
  $('lab-source').addEventListener('change', () => void choose($('lab-source').value));
  $('lab-play').addEventListener('click', () => play().catch(e => toast(e.message)));
  panel.querySelectorAll('[data-transport]').forEach(b =>
    b.addEventListener('click', () => {
      const a = b.dataset.transport,
        p = position();
      if (a === 'stop') stop();
      else
        seek(
          a === 'start' ? 0 : a === 'back' ? p - 10 : a === 'forward' ? p + 10 : Math.max(0, duration() - 10)
        );
    })
  );
  for (const id of ['lab-wave-processed', 'lab-wave-original'])
    $(id).addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      seek(((e.clientX - r.left) / r.width) * duration());
    });
  panel
    .querySelectorAll('[data-monitor]')
    .forEach(b => b.addEventListener('click', () => void setMonitor(b.dataset.monitor)));
  $('lab-match').addEventListener('change', updateLevels);
  $('lab-export').addEventListener('click', async () => {
    try {
      const toLibrary = $('lab-to-library').checked;
      await api(`/api/audio-lab/${sessionId}/preview`, 'POST', { ...values(), toLibrary });
      toast(
        toLibrary
          ? 'Exporting master. It will also appear in the library when ready.'
          : 'Exporting master to FLAC and MP3.'
      );
    } catch (e) {
      toast(e.message);
    }
  });
  $('lab-masters').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.masterListen) {
      masterId = b.dataset.masterListen;
      mastersSig = '';
      render(state);
      await setMonitor('master');
    }
    if (b.dataset.masterLibrary) {
      try {
        const job = await api(
          `/api/audio-lab/${sessionId}/renders/${b.dataset.masterLibrary}/library`,
          'POST',
          {}
        );
        toast(`Added to library: ${job.title}.`);
      } catch (err) {
        toast(err.message);
      }
    }
    if (b.dataset.masterApply) {
      const r = session()?.renders.find(x => x.id === b.dataset.masterApply);
      if (r) {
        setValues(r.settings);
        toast('Master settings loaded into the controls.');
      }
    }
    if (b.dataset.masterDelete) {
      if (!confirm('Delete this master (FLAC and MP3)?')) return;
      try {
        if (masterId === b.dataset.masterDelete) {
          if (monitor === 'master') await setMonitor('processed');
          delete buffers.master;
        }
        await api(`/api/audio-lab/${sessionId}/renders/${b.dataset.masterDelete}`, 'DELETE');
      } catch (err) {
        toast(err.message);
      }
    }
  });
  $('lab-cancel').addEventListener('click', async () => {
    try {
      await api(`/api/audio-lab/${sessionId}/cancel`, 'POST', {});
    } catch (e) {
      toast(e.message);
    }
  });
  $('lab-analyze').addEventListener('click', async () => {
    try {
      await api(`/api/audio-lab/${sessionId}/analyze`, 'POST', {});
    } catch (e) {
      toast(e.message);
    }
  });
  $('lab-remove').addEventListener('click', async () => {
    if (
      !confirm(
        'Remove this session? Masters and files uploaded to Audio Lab will be deleted. Library tracks and editor mixes will stay.'
      )
    )
      return;
    try {
      stop();
      await api(`/api/audio-lab/${sessionId}`, 'DELETE');
      sessionId = null;
      loadedSession = null;
      buffers = {};
      $('lab-source').value = '';
      toast('Sessione Audio Lab rimossa.');
      render(state);
    } catch (e) {
      toast(e.message);
    }
  });
  $('lab-advice').addEventListener('click', async () => {
    try {
      $('lab-advice').disabled = true;
      await api(`/api/audio-lab/${sessionId}/advice`, 'POST', {
        goal: $('lab-goal').value,
        settings: values(),
        listen: $('lab-listen').checked,
      });
      toast('Suggerimenti AI pronti.');
    } catch (e) {
      toast(e.message);
      if (/key/i.test(e.message)) await refreshAi();
    } finally {
      render(state);
    }
  });
  $('lab-import').addEventListener('change', async () => {
    const file = $('lab-import').files[0];
    if (!file) return;
    try {
      stop();
      const s = await upload('/api/audio-lab/import', file);
      sessionId = s.id;
      appliedSession = null;
      loadedSession = null;
      sourceOptions = '';
      toast('File received. Import and analysis are starting.');
      render(state);
    } catch (e) {
      toast(e.message);
    } finally {
      $('lab-import').value = '';
    }
  });
  $('lab-ref-import').addEventListener('change', async () => {
    const file = $('lab-ref-import').files[0];
    if (!file) return;
    try {
      await upload(`/api/audio-lab/${sessionId}/reference`, file);
      delete buffers.reference;
      toast('Reference received. Analysis is in progress.');
    } catch (e) {
      toast(e.message);
    } finally {
      $('lab-ref-import').value = '';
    }
  });
  document.addEventListener('keydown', e => {
    if (active && e.code === 'Space' && e.target === document.body && buffers.original) {
      e.preventDefault();
      void play();
    }
  });
  window.addEventListener('resize', () => {
    peakCache = {};
    if (buffers.original) drawAll();
  });
  $('lab-listen').addEventListener('change', () => state.audioLab && render(state));
  async function refreshAi() {
    try {
      aiInfo = await api('/api/prompt-ai/status');
      aiAvailable = aiInfo.available;
    } catch {
      aiAvailable = false;
      aiInfo = {};
    }
    if (state.audioLab) render(state);
  }
  presetOptions();
  setValues(NEUTRAL, { silent: true });
  setMonitor('processed');
  return {
    render,
    setActive: value => {
      active = value;
      if (!value) pause();
      else {
        void refreshAi();
        const s = session();
        if (s?.analysis) void loadSession(s);
      }
    },
    open: async (kind, jobId, mixId) => {
      openView();
      await choose(kind === 'mix' ? `mix:${jobId}:${mixId}` : `job:${jobId}`);
    },
    pause,
  };
}
