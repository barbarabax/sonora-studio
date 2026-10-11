// @codedna
// description: Multitrack timeline for the stem mixer: waveform clips, split, drag with beat/bar snapping, delete and undo.
//
// 
//
// 
//
// 
//
// exports: createTimeline
// used_by: sonora-studio/public/mixer-ui.mjs
// rules:   Never mutate audio; clips are plain {id, at, from, len} in seconds owned by mixer-ui.mjs (this module edits them through history-aware callbacks); no inline styles in markup (CSSOM only, CSP style-src 'self').
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_timeline | Suno-Studio-like lanes: clips with waveform, snap to a fitted constant-tempo grid (beat/bar), split at playhead, undo.
import { normalizeFx, fxActive } from './fx.mjs';
const LABEL_W = 170;
const LANE_H = 58;
const RULER_H = 26;
const MIN_LEN = 0.1;
const uid = () => Math.random().toString(36).slice(2, 9);

/**
 * @param {object} o
 * @param {HTMLElement} o.root           container the timeline is rendered into
 * @param {() => string[]} o.keys        track keys, in display order
 * @param {(key:string) => string} o.label
 * @param {(key:string) => AudioBuffer|undefined} o.buffer
 * @param {() => number} o.total         song length in seconds
 * @param {() => ({period:number,t0:number}|null)} o.grid
 * @param {() => number} o.beatsPerBar
 * @param {(t:number) => void} o.seek
 * @param {() => void} o.changed         called after every committed edit
 * @param {(key:string, kind:'mute'|'solo') => void} o.toggle
 * @param {(key:string) => {gain:number,mute:boolean,solo:boolean}} o.flags
 * @param {(key:string, gain:number) => void} o.setGain
 * @param {(key:string, pan:number) => void} o.setPan
 * @param {(key:string) => object} o.getFx        effects of a track (normalised)
 * @param {(key:string, fx:object) => void} o.setFx
 * @param {() => void} [o.tempoChanged]  the beat grid (tempo) changed: tempo-synced effects must be recalculated
 * @param {(key:string) => number} [o.getReduction]  current compressor gain reduction (dB) of a track
 * @param {(key:string) => string|null} o.downloadUrl   FLAC download link of a track's audio (null for custom lanes)
 * @param {(key:string) => 'lane'|'layer'|null} o.removable
 * @param {(key:string) => void} o.remove
 * @param {(range:{a:number,b:number,lanes:string[]|null}|null) => void} [o.selected]  called when the highlighted section changes
 * @param {(message:string) => void} [o.notify]
 * @param {(key:string) => boolean} o.isSource   true when the track owns audio (stems, AI layers); false for custom lanes
 * @param {() => void} o.addLane
 */
export function createTimeline(o) {
  const state = {
    clips: {},
    pps: 20,
    selected: null,
    snap: 'bar',
    downbeat: 0,
    playhead: 0,
    history: [],
    scale: 1,
    fitted: false,
    lane: null,
    clipboard: null,
    sel: null,
    mode: 'move',
  };
  const peaksCache = new WeakMap();
  const el = {};
  o.root.innerHTML = `<div class="tl-toolbar"><span class="tl-modes" role="group" aria-label="Tool"><button type="button" class="pill-button selected" data-tl="mode-move" title="Drag clips to move them">✋ Move</button><button type="button" class="pill-button" data-tl="mode-select" title="Drag across the timeline to select a section on one or more tracks (Shift also works)">▭ Select</button></span><button type="button" class="pill-button" data-tl="split" title="Split the selected clips at the playhead · S">✂ Split here</button><button type="button" class="pill-button" data-tl="delete" title="Delete the selected clip or track section · Delete">Delete</button><button type="button" class="pill-button" data-tl="copy" title="Copy the selected clip · Ctrl+C">Copy</button><button type="button" class="pill-button" data-tl="paste" title="Paste at the playhead on the selected track · Ctrl+V">Paste</button><button type="button" class="pill-button" data-tl="addlane" title="Add an empty track to paste or drop clips onto">＋ New track</button><button type="button" class="pill-button" data-tl="undo" title="Undo the last change · Ctrl+Z">↶ Undo</button><label>Snap <select data-tl="snap"><option value="bar">Bar</option><option value="beat">Beat</option><option value="fine">Fine (follows zoom)</option><option value="off">Off</option></select></label><label>Downbeat <select data-tl="downbeat"></select></label><span class="tl-bpm" data-tl="bpm"></span><span class="tl-sel-info" data-tl="selinfo"></span><button type="button" class="text-button" data-tl="clearsel" hidden>Deselect</button><button type="button" class="text-button" data-tl="half" title="Use if the grid is twice or half the correct tempo">×2 / ÷2</button><label>Fade in <input type="number" data-tl="fadein" min="0" max="30" step="0.1" value="0" title="Fade-in time for the selected clip or track"></label><label>out <input type="number" data-tl="fadeout" min="0" max="30" step="0.1" value="0" title="Fade-out time"></label><label>Zoom <input type="range" data-tl="zoom" min="4" max="120" value="20" aria-label="Timeline zoom"></label></div><div class="tl-body"><div class="tl-labels"></div><div class="tl-scroll" tabindex="0"><div class="tl-inner"><div class="tl-ruler"></div><div class="tl-lanes"></div><div class="tl-selection" hidden></div><div class="tl-playhead"></div></div></div></div><p class="field-hint">Drag a clip to move it; it snaps to bars. Click the ruler to set the playhead and use Split here. Drag across the ruler to select a section and generate an instrument only there.</p>`;
  const fxPanel = document.createElement('div');
  fxPanel.className = 'tl-fx';
  fxPanel.hidden = true;
  const db = v => `${v > 0 ? '+' : ''}${v} dB`;
  const pct = v => `${Math.round(v * 100)}%`;
  const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
  const ms = v => `${v < 10 ? Number(v).toFixed(1) : Math.round(v)} ms`;
  const range = (p, label, min, max, step, format) => ({ p, label, min, max, step, format, type: 'range' });
  const choice = (p, label, options) => ({ p, label, options, type: 'select' });
  /** Everything the effects menu offers; a section with `block` has its own on/off switch. */
  const SECTIONS = [
    {
      title: 'Equalizer',
      fields: [
        range('low', 'Bass', -12, 12, 1, db),
        range('mid', 'Mids', -12, 12, 1, db),
        range('high', 'Treble', -12, 12, 1, db),
      ],
    },
    {
      title: 'Filters',
      fields: [
        range('hp', 'Low cut', 20, 1000, 10, v => (v <= 20 ? 'off' : hz(v))),
        range('lp', 'High cut', 1000, 20000, 100, v => (v >= 20000 ? 'off' : hz(v))),
      ],
    },
    {
      title: 'Compressor',
      block: 'comp',
      meter: true,
      hint: 'Reduces the difference between loud and quiet sounds. Lower threshold and higher ratio mean more compression.',
      fields: [
        range('comp.thr', 'Threshold', -60, 0, 1, db),
        range('comp.ratio', 'Ratio', 1, 20, 0.5, v => `${v}:1`),
        range('comp.att', 'Attack', 0.1, 100, 0.1, ms),
        range('comp.rel', 'Release', 10, 1000, 10, ms),
        range('comp.knee', 'Knee', 0, 24, 1, db),
        choice('comp.mode', 'Detection', [
          ['peak', 'Peak (fast)'],
          ['rms', 'RMS (natural)'],
        ]),
        range('comp.schp', 'Low-frequency detection filter', 20, 300, 5, hz),
        { p: 'comp.auto', label: 'Automatic makeup gain', type: 'check' },
        range('comp.makeup', 'Manual makeup gain', -12, 24, 0.5, db),
        range('comp.mix', 'Mix (parallel compression)', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Distortion',
      block: 'dist',
      fields: [
        choice('dist.type', 'Type', [
          ['soft', 'Soft'],
          ['hard', 'Hard'],
          ['fuzz', 'Fuzz'],
        ]),
        range('dist.drive', 'Drive', 0, 40, 1, db),
        range('dist.tone', 'Tone (taglio acuti)', 500, 16000, 100, hz),
        range('dist.level', 'Level out', -24, 12, 1, db),
        range('dist.mix', 'Mix', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Wah',
      block: 'wah',
      hint: 'A filter that moves up and down at the selected rate.',
      fields: [
        range('wah.rate', 'Rate', 0.1, 8, 0.1, v => `${Number(v).toFixed(1)} Hz`),
        range('wah.lo', 'Minimum frequency', 200, 1000, 10, hz),
        range('wah.hi', 'Maximum frequency', 800, 4000, 50, hz),
        range('wah.q', 'Resonance', 1, 12, 0.5, v => Number(v).toFixed(1)),
        range('wah.mix', 'Mix', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Envelope (follower filter)',
      block: 'env',
      hint: 'The filter opens as you play louder, like an auto-wah.',
      fields: [
        range('env.sens', 'Sensitivity', 0, 1, 0.05, pct),
        choice('env.dir', 'Direction', [
          ['up', 'Opens with volume'],
          ['down', 'Closes with volume'],
        ]),
        range('env.lo', 'Minimum frequency', 100, 1000, 10, hz),
        range('env.hi', 'Maximum frequency', 500, 6000, 50, hz),
        range('env.q', 'Resonance', 1, 12, 0.5, v => Number(v).toFixed(1)),
        range('env.att', 'Attack', 1, 100, 1, ms),
        range('env.rel', 'Release', 10, 1000, 10, ms),
        range('env.mix', 'Mix', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Chorus',
      block: 'chorus',
      fields: [
        range('chorus.rate', 'Rate', 0.05, 5, 0.05, v => `${Number(v).toFixed(2)} Hz`),
        range('chorus.depth', 'Depth', 0, 8, 0.1, ms),
        range('chorus.delay', 'Base delay', 5, 30, 0.5, ms),
        range('chorus.mix', 'Mix', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Delay (repeating echo)',
      block: 'delay',
      hint: 'Repeats that fade over time. “Sync to track” aligns them to the bars.',
      fields: [
        choice('delay.mode', 'Tempo', [
          ['sync', 'Sync to track'],
          ['free', 'Off (milliseconds)'],
        ]),
        choice('delay.note', 'Note value (sync)', [
          ['1/2', 'Half (1/2)'],
          ['1/4', 'Quarter (1/4)'],
          ['1/4.', 'Dotted quarter'],
          ['1/4t', 'Quarter triplet'],
          ['1/8', 'Eighth (1/8)'],
          ['1/8.', 'Dotted eighth'],
          ['1/8t', 'Eighth triplet'],
          ['1/16', 'Sixteenth (1/16)'],
          ['1/16.', 'Dotted sixteenth'],
          ['1/16t', 'Sixteenth triplet'],
        ]),
        range('delay.ms', 'Free time', 20, 1500, 5, ms),
        range('delay.fb', 'Repeats (feedback)', 0, 0.92, 0.02, pct),
        range('delay.tone', 'Darken repeats (high cut)', 500, 16000, 100, hz),
        range('delay.lowcut', 'Thin repeats (low cut)', 20, 1000, 10, hz),
        {
          p: 'delay.pingpong',
          label: 'Ping-pong (repeats move left and right)',
          type: 'check',
        },
        range('delay.mix', 'Repeat level', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Flanger',
      block: 'flanger',
      fields: [
        range('flanger.rate', 'Rate', 0.05, 5, 0.05, v => `${Number(v).toFixed(2)} Hz`),
        range('flanger.depth', 'Depth', 0, 6, 0.1, ms),
        range('flanger.delay', 'Base delay', 0.3, 10, 0.1, ms),
        range('flanger.fb', 'Feedback', -0.95, 0.95, 0.05, pct),
        range('flanger.mix', 'Mix', 0, 1, 0.05, pct),
      ],
    },
    {
      title: 'Allineamento nel tempo',
      hint: 'Shift this track by a few milliseconds without moving its clips. Use it to align a recording to the beat.',
      fields: [range('shift', 'Shift', -300, 300, 1, v => `${v > 0 ? '+' : ''}${v} ms`)],
    },
    {
      title: 'Character',
      fields: [
        range('sat', 'Saturation', 0, 1, 0.05, pct),
        range('width', 'Stereo width', 0, 2, 0.05, v =>
          v === 1 ? 'normal' : v === 0 ? 'mono' : pct(v)
        ),
      ],
    },
    {
      title: 'Eco semplice (3 ripetizioni)',
      fields: [
        range('echo', 'Amount', 0, 1, 0.05, v => (v === 0 ? 'off' : pct(v))),
        range('echoMs', 'Tempo', 50, 800, 10, ms),
      ],
    },
    {
      title: 'Riverbero',
      fields: [
        range('verb', 'Amount', 0, 1, 0.05, v => (v === 0 ? 'off' : pct(v))),
        choice('room', 'Stanza', [
          ['small', 'Piccola'],
          ['medium', 'Midsa'],
          ['large', 'Grande'],
        ]),
      ],
    },
  ];
  const formats = {};
  const control = field => {
    formats[field.p] = field.format;
    if (field.type === 'check')
      return `<label class="check"><input type="checkbox" data-fx="${field.p}"> ${field.label}</label>`;
    if (field.type === 'select')
      return `<label>${field.label}<select data-fx="${field.p}">${field.options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`;
    return `<label>${field.label} <output data-fx-out="${field.p}"></output><input type="range" data-fx="${field.p}" min="${field.min}" max="${field.max}" step="${field.step}"></label>`;
  };
  fxPanel.innerHTML =
    `<div class="tl-fx-head"><strong data-fx-title></strong><button type="button" class="text-button" data-fx-close>Close</button></div>` +
    SECTIONS.map(
      section =>
        `<details class="tl-fx-section" data-fx-section="${section.block || section.title}"><summary><span>${section.title}</span><i class="dot" hidden></i>${
          section.block
            ? `<label class="fx-switch" title="Turn this effect on or off"><input type="checkbox" data-fx="${section.block}.on" aria-label="Enable ${section.title}"><b>On</b></label>`
            : ''
        }</summary>${section.hint ? `<p class="field-hint">${section.hint}</p>` : ''}${
          section.meter
            ? '<div class="tl-gr" title="Compressor gain reduction"><i></i><span>0 dB</span></div>'
            : ''
        }<div class="tl-fx-group">${section.fields.map(control).join('')}</div></details>`
    ).join('') +
    `<button type="button" class="text-button" data-fx-reset>Reset this track’s effects</button>`;
  o.root.append(fxPanel);
  let fxKey = null,
    fxTimer = null;
  const getPath = (fx, path) => path.split('.').reduce((v, k) => v?.[k], fx);
  const setPath = (fx, path, value) => {
    const next = structuredClone(fx),
      keys = path.split('.');
    let at = next;
    for (const k of keys.slice(0, -1)) at = at[k];
    at[keys.at(-1)] = value;
    return next;
  };
  function paintFx() {
    if (!fxKey) return;
    const f = normalizeFx(o.getFx(fxKey));
    fxPanel.querySelector('[data-fx-title]').textContent = 'Effetti · ' + o.label(fxKey);
    for (const input of fxPanel.querySelectorAll('[data-fx]')) {
      const path = input.dataset.fx,
        value = getPath(f, path);
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = String(value);
      const out = fxPanel.querySelector(`[data-fx-out="${path}"]`);
      if (out) out.textContent = formats[path]?.(value) ?? '';
    }
    for (const section of fxPanel.querySelectorAll('[data-fx-section]')) {
      const block = section.dataset.fxSection;
      const active = f[block]?.on === true;
      section.classList.toggle('on', active);
      section.querySelector('.dot').hidden = !active;
      if (active && !section.dataset.touched) section.open = true;
    }
  }
  function openFx(key, anchor) {
    fxKey = key;
    for (const section of fxPanel.querySelectorAll('[data-fx-section]')) {
      delete section.dataset.touched;
      section.open = false;
    }
    paintFx();
    fxPanel.hidden = false;
    const box = o.root.getBoundingClientRect(),
      a = anchor.getBoundingClientRect();
    fxPanel.style.left = Math.max(0, a.left - box.left - 10) + 'px';
    fxPanel.style.top = a.bottom - box.top + 4 + 'px';
    clearInterval(fxTimer);
    // Gain-reduction meter of the compressor, refreshed while the menu is open.
    fxTimer = setInterval(() => {
      const gr = o.getReduction?.(fxKey) || 0,
        meter = fxPanel.querySelector('.tl-gr');
      if (!meter) return;
      meter.querySelector('i').style.width = Math.min(100, (gr / 24) * 100) + '%';
      meter.querySelector('span').textContent = gr.toFixed(1) + ' dB';
    }, 100);
  }
  const closeFx = () => {
    fxPanel.hidden = true;
    fxKey = null;
    clearInterval(fxTimer);
  };
  function applyFx(target) {
    const path = target.dataset?.fx;
    if (!path || !fxKey) return;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.tagName === 'SELECT'
          ? target.value
          : Number(target.value);
    const next = setPath(normalizeFx(o.getFx(fxKey)), path, value);
    o.setFx(fxKey, next);
    const out = fxPanel.querySelector(`[data-fx-out="${path}"]`);
    if (out) out.textContent = formats[path]?.(value) ?? '';
    if (path.endsWith('.on')) paintFx();
    const button = o.root.querySelector(`[data-fx-key="${fxKey}"]`);
    if (button) button.classList.toggle('on', fxActive(o.getFx(fxKey)));
  }
  fxPanel.addEventListener('input', event => applyFx(event.target));
  fxPanel.addEventListener('change', event => applyFx(event.target));
  fxPanel.addEventListener(
    'toggle',
    event => {
      if (event.target.matches?.('[data-fx-section]')) event.target.dataset.touched = '1';
    },
    true
  );
  fxPanel.addEventListener('click', event => {
    if (event.target.closest('[data-fx-close]')) closeFx();
    else if (event.target.closest('[data-fx-reset]') && fxKey) {
      o.setFx(fxKey, structuredClone(normalizeFx({})));
      paintFx();
      o.root.querySelector(`[data-fx-key="${fxKey}"]`)?.classList.remove('on');
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!fxPanel.hidden && !event.target.closest('.tl-fx, [data-fx-key]')) closeFx();
  });
  el.labels = o.root.querySelector('.tl-labels');
  el.scroll = o.root.querySelector('.tl-scroll');
  el.inner = o.root.querySelector('.tl-inner');
  el.ruler = o.root.querySelector('.tl-ruler');
  el.lanes = o.root.querySelector('.tl-lanes');
  el.playhead = o.root.querySelector('.tl-playhead');
  el.selection = o.root.querySelector('.tl-selection');
  const tool = name => o.root.querySelector(`[data-tl="${name}"]`);

  /** Fitted grid with the user's ÷2/×2 correction applied. */
  const grid = () => {
    const g = o.grid();
    return g ? { t0: g.t0, period: g.period * state.scale } : null;
  };
  const panText = p =>
    p === 0 ? 'centro' : p < 0 ? Math.round(-p * 100) + '% sinistra' : Math.round(p * 100) + '% destra';
  const total = () => Math.max(1, o.total());
  const bar = () => Math.max(1, o.beatsPerBar());
  /** How many times a beat can be halved while the lines stay at least 14 px apart (0-4): the finer the zoom, the finer the grid. */
  const subLevels = () => {
    const g = grid();
    if (!g) return 0;
    let n = 0;
    while (n < 4 && (g.period * state.pps) / 2 ** (n + 1) >= 14) n++;
    return n;
  };
  const spacing = () => {
    const g = grid();
    if (!g || state.snap === 'off') return null;
    if (state.snap === 'bar') return g.period * bar();
    if (state.snap === 'beat') return g.period;
    return g.period / 2 ** subLevels();
  };
  /** Nearest grid line to t, or t itself when snapping is off or the grid is unknown. */
  function snap(t) {
    const g = grid(),
      step = spacing();
    if (!step) return t;
    const origin = g.t0 + state.downbeat * g.period;
    return origin + Math.round((t - origin) / step) * step;
  }
  const snapped = t => Math.min(total(), Math.max(0, snap(t)));

  function peaksOf(buffer) {
    let p = peaksCache.get(buffer);
    if (p) return p;
    const rate = 100,
      data = buffer.getChannelData(0),
      per = Math.max(1, Math.floor(buffer.sampleRate / rate));
    p = new Float32Array(Math.ceil(data.length / per));
    for (let i = 0; i < p.length; i++) {
      let m = 0;
      const end = Math.min(data.length, (i + 1) * per);
      for (let j = i * per; j < end; j += 4) m = Math.max(m, Math.abs(data[j]));
      p[i] = m;
    }
    p.rate = rate;
    peaksCache.set(buffer, p);
    return p;
  }
  function drawWave(canvas, buffer, from, len) {
    const w = canvas.width,
      h = canvas.height,
      ctx = canvas.getContext('2d'),
      peaks = peaksOf(buffer);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(210, 225, 195, 0.85)';
    for (let x = 0; x < w; x++) {
      const a = Math.floor((from + (x / w) * len) * peaks.rate),
        b = Math.max(a + 1, Math.floor((from + ((x + 1) / w) * len) * peaks.rate));
      let m = 0;
      for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const half = Math.max(1, m * h * 0.5);
      ctx.fillRect(x, h / 2 - half, 1, half * 2);
    }
  }

  /** Cuts of a track. A source track starts with one clip covering its audio; a custom lane starts empty. */
  function ensure(key) {
    if (state.clips[key]) return state.clips[key];
    if (!o.isSource(key)) return (state.clips[key] = []);
    const buffer = o.buffer(key);
    if (buffer) state.clips[key] = [{ id: uid(), at: 0, from: 0, len: buffer.duration, src: key }];
    return state.clips[key] || [];
  }
  const snapshot = () => JSON.stringify(state.clips);
  function commit(before) {
    if (before === snapshot()) return;
    state.history.push(before);
    if (state.history.length > 60) state.history.shift();
    o.changed();
    render();
  }

  /** Ruler: bar numbers, beat ticks and, when zoomed in, sub-beat ticks (1/2, 1/4, 1/8, 1/16 of a beat). */
  function paintRuler() {
    const g = grid(),
      width = total() * state.pps;
    el.ruler.replaceChildren();
    el.ruler.style.width = width + 'px';
    if (!g) return;
    const n = subLevels(),
      per = 2 ** n,
      step = g.period / per,
      origin = g.t0 + state.downbeat * g.period,
      beatPx = g.period * state.pps,
      barBeats = bar();
    const mod = (a, m) => ((a % m) + m) % m;
    const frag = document.createDocumentFragment();
    for (let i = Math.ceil((0 - origin) / step); ; i++) {
      const t = origin + i * step;
      if (t > total()) break;
      const isBeat = mod(i, per) === 0,
        beatIndex = Math.round(i / per),
        isBar = isBeat && mod(beatIndex, barBeats) === 0;
      if (isBeat && !isBar && beatPx < 9) continue;
      const tick = document.createElement('div');
      tick.className = 'tl-tick ' + (isBar ? 'bar' : isBeat ? 'beat' : 'sub');
      tick.style.left = t * state.pps + 'px';
      const barNumber = Math.floor(beatIndex / barBeats) + 1;
      if (isBar && beatPx * barBeats > 28) tick.textContent = String(barNumber);
      else if (isBeat && !isBar && beatPx >= 46)
        tick.textContent = `${barNumber}.${mod(beatIndex, barBeats) + 1}`;
      frag.append(tick);
    }
    el.ruler.append(frag);
  }
  /** Vertical grid lines on the lanes: bars (strong), beats, and the finest visible sub-beat level (faint). */
  function paintGridLines() {
    const g = grid();
    el.lanes.style.backgroundImage = '';
    if (!g || state.snap === 'off') return;
    const origin = g.t0 + state.downbeat * g.period,
      beatPx = g.period * state.pps,
      n = subLevels(),
      layers = [];
    const add = (step, alpha) => {
      if (step * state.pps < 5) return;
      layers.push({ size: step * state.pps, offset: (((origin % step) + step) % step) * state.pps, alpha });
    };
    add(g.period * bar(), 0.14);
    if (beatPx >= 9) add(g.period, 0.08);
    if (n > 0) add(g.period / 2 ** n, 0.04);
    if (!layers.length) return;
    el.lanes.style.backgroundImage = layers
      .map(l => `linear-gradient(to right, rgba(255,255,255,${l.alpha}) 1px, transparent 1px)`)
      .join(',');
    el.lanes.style.backgroundSize = layers.map(l => `${l.size}px 100%`).join(',');
    el.lanes.style.backgroundPosition = layers.map(l => `${l.offset}px 0`).join(',');
  }

  const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  /** Highlights the chosen section across the ruler and every lane, and tells the owner about it. */
  function paintSelection(notify = true) {
    const sel = state.sel;
    el.selection.hidden = !sel;
    if (sel) {
      const keys = o.keys();
      const first = sel.lanes ? Math.max(0, keys.indexOf(sel.lanes[0])) : 0,
        count = sel.lanes ? sel.lanes.length : keys.length;
      el.selection.style.left = sel.a * state.pps + 'px';
      el.selection.style.width = (sel.b - sel.a) * state.pps + 'px';
      el.selection.style.top = (sel.lanes ? RULER_H + first * LANE_H : 0) + 'px';
      el.selection.style.height = (sel.lanes ? count * LANE_H : RULER_H + keys.length * LANE_H) + 'px';
    }
    tool('selinfo').textContent = sel
      ? `Selected section ${clock(sel.a)} – ${clock(sel.b)}${sel.lanes ? ` · ${sel.lanes.length} ${sel.lanes.length === 1 ? 'track' : 'tracks'}` : ''}`
      : '';
    tool('clearsel').hidden = !sel;
    const area = !!sel?.lanes;
    tool('delete').disabled = !(state.selected || area);
    tool('copy').disabled = !(state.selected || area);
    if (notify) o.selected?.(sel ? { ...sel } : null);
  }
  /** Highlights [a, b]; with `lanes` it is an area on those tracks only (to copy or delete), without it a plain time range. */
  function setSelection(a, b, lanes = null, minimum = 1) {
    const lo = Math.max(0, Math.min(a, b)),
      hi = Math.min(total(), Math.max(a, b));
    state.sel = hi - lo >= minimum ? { a: lo, b: hi, lanes } : null;
    paintSelection();
  }
  function render() {
    const keys = o.keys();
    const width = total() * state.pps;
    el.inner.style.width = width + 'px';
    el.lanes.style.width = width + 'px';
    el.labels.style.paddingTop = RULER_H + 'px';
    el.labels.replaceChildren(
      ...keys.map(key => {
        const row = document.createElement('div');
        row.className = 'tl-label' + (state.lane === key ? ' sel' : '');
        row.dataset.lane = key;
        row.style.height = LANE_H + 'px';
        const name = document.createElement('span');
        name.textContent = o.label(key);
        name.title = o.label(key);
        const f = o.flags(key);
        const mute = document.createElement('button');
        mute.type = 'button';
        mute.className = 'tl-mini' + (f.mute ? ' on' : '');
        mute.textContent = 'M';
        mute.title = 'Muto';
        mute.dataset.tlMute = key;
        const solo = document.createElement('button');
        solo.type = 'button';
        solo.className = 'tl-mini' + (f.solo ? ' on' : '');
        solo.textContent = 'S';
        solo.title = 'Solo';
        solo.dataset.tlSolo = key;
        const gain = document.createElement('input');
        gain.type = 'range';
        gain.min = '0';
        gain.max = '200';
        gain.step = '5';
        gain.value = String(Math.round((f.gain ?? 1) * 100));
        gain.className = 'tl-gain tl-vol';
        gain.dataset.tlGain = key;
        gain.title = `Level ${gain.value}% · double-click to reset to 100%`;
        gain.setAttribute('aria-label', 'Level ' + o.label(key));
        const fxButton = document.createElement('button');
        fxButton.type = 'button';
        fxButton.className = 'tl-mini fxbtn' + (fxActive(o.getFx(key)) ? ' on' : '');
        fxButton.textContent = 'FX';
        fxButton.title =
          'Track effects: EQ, filters, saturation, stereo, echo and reverb';
        fxButton.dataset.fxKey = key;
        row.append(name, mute, solo, fxButton);
        const pan = document.createElement('input');
        pan.type = 'range';
        pan.min = '-100';
        pan.max = '100';
        pan.step = '5';
        pan.value = String(Math.round((f.pan ?? 0) * 100));
        pan.className = 'tl-gain tl-pan';
        pan.dataset.tlPan = key;
        pan.title = 'Pan ' + panText(f.pan ?? 0) + ' · double-click to center';
        pan.setAttribute('aria-label', 'Pan ' + o.label(key));
        const url = o.downloadUrl?.(key);
        if (url) {
          const link = document.createElement('a');
          link.className = 'tl-mini link';
          link.href = url;
          link.textContent = '↓';
          link.title = 'Download this stem as FLAC';
          row.append(link);
        }
        if (o.removable?.(key)) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'tl-mini';
          del.textContent = '×';
          del.title = 'Delete this track';
          del.dataset.removeKey = key;
          row.append(del);
        }
        const lineBreak = document.createElement('div');
        lineBreak.className = 'tl-break';
        row.append(lineBreak, gain, pan);
        return row;
      })
    );
    el.lanes.replaceChildren(
      ...keys.map(key => {
        const lane = document.createElement('div');
        lane.className = 'tl-lane' + (state.lane === key ? ' sel' : '');
        lane.dataset.lane = key;
        lane.style.height = LANE_H + 'px';
        lane.style.width = width + 'px';
        for (const clip of ensure(key)) {
          const buffer = o.buffer(clip.src || key);
          const div = document.createElement('div');
          div.className = 'tl-clip' + (clip.id === state.selected ? ' selected' : '');
          div.dataset.clip = clip.id;
          div.dataset.key = key;
          div.style.left = clip.at * state.pps + 'px';
          div.style.width = Math.max(2, clip.len * state.pps) + 'px';
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.min(8000, Math.round(clip.len * state.pps)));
          canvas.height = LANE_H - 8;
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          div.append(canvas);
          // Fade overlays (the darker triangle is the part of the sound that is faded away) and their drag handles.
          for (const side of ['in', 'out']) {
            const seconds = side === 'in' ? clip.fi || 0 : clip.fo || 0;
            const shade = document.createElement('div');
            shade.className = 'tl-fade ' + side;
            shade.style.width = Math.min(clip.len, seconds) * state.pps + 'px';
            shade.hidden = seconds <= 0.01;
            const handle = document.createElement('div');
            handle.className = 'tl-fh ' + side;
            handle.dataset.fade = side;
            handle.title = 'Drag to adjust the fade ' + (side === 'in' ? 'in' : 'out');
            handle.style[side === 'in' ? 'left' : 'right'] = Math.min(clip.len, seconds) * state.pps + 'px';
            div.append(shade, handle);
          }
          if (buffer) drawWave(canvas, buffer, clip.from, clip.len);
          lane.append(div);
        }
        return lane;
      })
    );
    paintRuler();
    paintGridLines();
    const g = grid();
    tool('bpm').textContent = g ? `${Math.round(60 / g.period)} BPM` : 'Tempo in analisi…';
    tool('undo').disabled = !state.history.length;
    syncFades();
    tool('paste').disabled = !state.clipboard;
    tool('mode-move').classList.toggle('selected', state.mode === 'move');
    tool('mode-select').classList.toggle('selected', state.mode === 'select');
    el.scroll.classList.toggle('select-mode', state.mode === 'select');
    const bars = bar();
    const select = tool('downbeat');
    if (select.options.length !== bars) {
      select.innerHTML = Array.from(
        { length: bars },
        (_, i) => `<option value="${i}">${i + 1}</option>`
      ).join('');
    }
    select.value = String(Math.min(state.downbeat, bars - 1));
    tool('snap').value = state.snap;
    setPlayhead(state.playhead, false);
    paintSelection(false);
  }

  function setPlayhead(t, follow = true) {
    state.playhead = t;
    el.playhead.style.left = t * state.pps + 'px';
    el.playhead.style.height = RULER_H + keysHeight() + 'px';
    if (follow) {
      const x = t * state.pps,
        view = el.scroll;
      if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth - 40)
        view.scrollLeft = Math.max(0, x - 80);
    }
  }
  const keysHeight = () => o.keys().length * LANE_H;

  function timeAt(event) {
    const rect = el.inner.getBoundingClientRect();
    return Math.min(total(), Math.max(0, (event.clientX - rect.left) / state.pps));
  }

  function split() {
    const t = state.playhead,
      before = snapshot();
    const targets = state.selected
      ? Object.entries(state.clips).flatMap(([k, list]) =>
          list.filter(c => c.id === state.selected).map(c => [k, c])
        )
      : Object.entries(state.clips).flatMap(([k, list]) => list.map(c => [k, c]));
    for (const [key, clip] of targets) {
      if (t <= clip.at + MIN_LEN || t >= clip.at + clip.len - MIN_LEN) continue;
      const cut = t - clip.at;
      const right = {
        id: uid(),
        at: t,
        from: clip.from + cut,
        len: clip.len - cut,
        src: clip.src || key,
        fi: 0,
        fo: clip.fo || 0,
      };
      clip.len = cut;
      clip.fo = 0;
      state.clips[key].splice(state.clips[key].indexOf(clip) + 1, 0, right);
    }
    commit(before);
  }
  /** Removes the highlighted part from the chosen tracks, leaving silence (clips are cut at the edges, nothing shifts). */
  function deleteArea() {
    const sel = state.sel;
    if (!sel?.lanes) return;
    const before = snapshot();
    for (const lane of sel.lanes) {
      const out = [];
      for (const c of ensure(lane)) {
        const end = c.at + c.len;
        if (end <= sel.a || c.at >= sel.b) {
          out.push(c);
          continue;
        }
        if (c.at < sel.a - 0.01) out.push({ ...c, id: uid(), len: sel.a - c.at, fo: 0 });
        if (end > sel.b + 0.01) {
          const cut = sel.b - c.at;
          out.push({ ...c, id: uid(), at: sel.b, from: c.from + cut, len: end - sel.b, fi: 0 });
        }
      }
      state.clips[lane] = out;
    }
    commit(before);
  }
  function removeSelected() {
    if (!state.selected) {
      deleteArea();
      return;
    }
    const before = snapshot();
    for (const key of Object.keys(state.clips))
      state.clips[key] = state.clips[key].filter(c => c.id !== state.selected);
    state.selected = null;
    commit(before);
  }
  const findSelected = () => {
    for (const [key, list] of Object.entries(state.clips)) {
      const clip = list.find(c => c.id === state.selected);
      if (clip) return { key, clip };
    }
    return null;
  };
  function copy() {
    const hit = findSelected();
    if (!hit) return copyArea();
    state.clipboard = {
      src: hit.clip.src || hit.key,
      from: hit.clip.from,
      len: hit.clip.len,
      lane: hit.key,
      fi: hit.clip.fi || 0,
      fo: hit.clip.fo || 0,
    };
    tool('paste').disabled = false;
    return true;
  }
  /** Pastes the copied clip at the playhead on the chosen lane (selected lane, else the lane it came from). */
  /** Copies every piece of clip inside the highlighted area, keeping its track order and offsets. */
  function copyArea() {
    const sel = state.sel;
    if (!sel?.lanes) return false;
    const keys = o.keys(),
      items = [];
    for (const lane of sel.lanes)
      for (const c of ensure(lane)) {
        const lo = Math.max(sel.a, c.at),
          hi = Math.min(sel.b, c.at + c.len);
        if (hi - lo < 0.05) continue;
        items.push({
          laneIndex: keys.indexOf(lane),
          src: c.src || lane,
          at: lo - sel.a,
          from: c.from + (lo - c.at),
          len: hi - lo,
        });
      }
    if (!items.length) return false;
    state.clipboard = { area: true, items };
    tool('paste').disabled = false;
    return true;
  }
  /** Pastes a copied area at the playhead: the first copied track lands on the chosen track, the others on the tracks below it. */
  function pasteArea() {
    const keys = o.keys(),
      items = state.clipboard.items;
    const base = Math.min(...items.map(i => i.laneIndex));
    const target = state.lane && keys.includes(state.lane) ? keys.indexOf(state.lane) : base;
    const before = snapshot();
    let added = 0;
    for (const it of items) {
      const index = target + (it.laneIndex - base);
      const at = state.playhead + it.at;
      if (index < 0 || index >= keys.length || at >= total()) continue;
      const len = Math.min(it.len, total() - at);
      if (len < 0.05) continue;
      ensure(keys[index]).push({ id: uid(), at, from: it.from, len, src: it.src, fi: 0, fo: 0 });
      state.clips[keys[index]].sort((a, b) => a.at - b.at);
      added++;
    }
    if (!added) {
      o.notify?.('There is no room to paste here. Choose a track higher up or add another track.');
      return;
    }
    commit(before);
  }
  function paste() {
    const clip = state.clipboard;
    if (!clip) return;
    if (clip.area) return pasteArea();
    const key =
      state.lane && o.keys().includes(state.lane)
        ? state.lane
        : o.keys().includes(clip.lane)
          ? clip.lane
          : null;
    if (!key) return;
    const before = snapshot();
    const pasted = {
      id: uid(),
      at: Math.min(Math.max(0, total() - clip.len), Math.max(0, state.playhead)),
      from: clip.from,
      len: clip.len,
      src: clip.src,
      fi: clip.fi,
      fo: clip.fo,
    };
    ensure(key).push(pasted);
    state.clips[key].sort((a, b) => a.at - b.at);
    state.selected = pasted.id;
    commit(before);
  }
  /**
   * Clips a fade applies to: the selected clip; otherwise the chosen track as a whole (its first clip fades in, its last one fades out).
   */
  function fadeTargets(side) {
    const hit = findSelected();
    if (hit) return [hit.clip];
    const list =
      state.lane && state.clips[state.lane] ? [...state.clips[state.lane]].sort((a, b) => a.at - b.at) : [];
    if (!list.length) return [];
    return [side === 'in' ? list[0] : list.at(-1)];
  }
  function syncFades() {
    for (const side of ['in', 'out']) {
      const input = tool(side === 'in' ? 'fadein' : 'fadeout'),
        target = fadeTargets(side)[0];
      input.value = target
        ? String(Math.round((side === 'in' ? target.fi || 0 : target.fo || 0) * 10) / 10)
        : '0';
      input.disabled = !target;
    }
  }
  function setFade(side, seconds, before) {
    const targets = fadeTargets(side);
    if (!targets.length) return;
    for (const clip of targets) {
      const v = Math.max(0, Math.min(seconds, clip.len));
      if (side === 'in') {
        clip.fi = v;
        clip.fo = Math.min(clip.fo || 0, clip.len - v);
      } else {
        clip.fo = v;
        clip.fi = Math.min(clip.fi || 0, clip.len - v);
      }
    }
    commit(before ?? snapshot());
  }
  function undo() {
    const previous = state.history.pop();
    if (!previous) return;
    state.clips = JSON.parse(previous);
    state.selected = null;
    o.changed();
    render();
  }

  // Dragging a clip: the start or the end (whichever is closer to a grid line) snaps.
  let drag = null,
    fdrag = null,
    msel = null,
    rsel = null;
  const laneIndexAt = y => {
    const top = el.lanes.getBoundingClientRect().top;
    return Math.max(0, Math.min(o.keys().length - 1, Math.floor((y - top) / LANE_H)));
  };
  o.root.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.tl-fh');
    if (handle) {
      const clipEl = handle.closest('.tl-clip');
      const clip = state.clips[clipEl.dataset.key].find(c => c.id === clipEl.dataset.clip);
      state.selected = clip.id;
      state.lane = clipEl.dataset.key;
      fdrag = {
        clip,
        side: handle.dataset.fade,
        x0: event.clientX,
        v0: handle.dataset.fade === 'in' ? clip.fi || 0 : clip.fo || 0,
        el: clipEl,
        before: snapshot(),
        moved: false,
      };
      handle.setPointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }
    const inLane = event.target.closest('.tl-lane');
    if (inLane && (state.mode === 'select' || event.shiftKey)) {
      // Rubber-band selection across tracks and time.
      state.selected = null;
      state.lane = inLane.dataset.lane;
      el.lanes.querySelectorAll('.tl-clip.selected').forEach(c => c.classList.remove('selected'));
      msel = {
        x0: event.clientX,
        y0: event.clientY,
        t0: timeAt(event),
        i0: laneIndexAt(event.clientY),
        moved: false,
      };
      inLane.setPointerCapture(event.pointerId);
      return;
    }
    const clipEl = event.target.closest('.tl-clip');
    if (clipEl) {
      const clip = state.clips[clipEl.dataset.key].find(c => c.id === clipEl.dataset.clip);
      state.selected = clip.id;
      el.lanes.querySelectorAll('.tl-clip').forEach(c => c.classList.toggle('selected', c === clipEl));
      tool('delete').disabled = false;
      state.lane = clipEl.dataset.key;
      syncFades();
      drag = {
        clip,
        el: clipEl,
        x0: event.clientX,
        y0: event.clientY,
        at0: clip.at,
        from: clipEl.dataset.key,
        to: clipEl.dataset.key,
        before: snapshot(),
        moved: false,
      };
      clipEl.setPointerCapture(event.pointerId);
      return;
    }
    const laneEl = event.target.closest('.tl-lane, .tl-label');
    if (laneEl?.dataset.lane && !event.target.closest('button')) {
      state.lane = laneEl.dataset.lane;
      o.root
        .querySelectorAll('.tl-lane, .tl-label')
        .forEach(x => x.classList.toggle('sel', x.dataset.lane === state.lane));
    }
    if (event.target.closest('.tl-ruler')) {
      state.selected = null;
      tool('delete').disabled = true;
      el.lanes.querySelectorAll('.tl-clip.selected').forEach(c => c.classList.remove('selected'));
      rsel = { x0: event.clientX, t0: timeAt(event), moved: false };
      el.ruler.setPointerCapture(event.pointerId);
      return;
    }
    if (event.target.closest('.tl-lane')) {
      state.selected = null;
      tool('delete').disabled = true;
      el.lanes.querySelectorAll('.tl-clip.selected').forEach(c => c.classList.remove('selected'));
      const t = event.target.closest('.tl-ruler') ? snapped(timeAt(event)) : timeAt(event);
      setPlayhead(t, false);
      o.seek(t);
    }
  });
  o.root.addEventListener('pointermove', event => {
    if (fdrag) {
      const d = fdrag,
        dx = (event.clientX - d.x0) / state.pps;
      d.moved = true;
      const other = d.side === 'in' ? d.clip.fo || 0 : d.clip.fi || 0;
      const v = Math.max(0, Math.min(d.clip.len - other, d.v0 + (d.side === 'in' ? dx : -dx)));
      d.clip[d.side === 'in' ? 'fi' : 'fo'] = v;
      d.el.querySelector('.tl-fade.' + d.side).style.width = v * state.pps + 'px';
      d.el.querySelector('.tl-fade.' + d.side).hidden = v <= 0.01;
      d.el.querySelector('.tl-fh.' + d.side).style[d.side === 'in' ? 'left' : 'right'] = v * state.pps + 'px';
      return;
    }
    if (msel) {
      if (!msel.moved && Math.abs(event.clientX - msel.x0) < 4 && Math.abs(event.clientY - msel.y0) < 4)
        return;
      msel.moved = true;
      const i1 = laneIndexAt(event.clientY),
        keys = o.keys();
      setSelection(
        snapped(msel.t0),
        snapped(timeAt(event)),
        keys.slice(Math.min(msel.i0, i1), Math.max(msel.i0, i1) + 1),
        0.2
      );
      return;
    }
    if (rsel) {
      if (!rsel.moved && Math.abs(event.clientX - rsel.x0) < 4) return;
      rsel.moved = true;
      setSelection(snapped(rsel.t0), snapped(timeAt(event)));
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(event.clientY - drag.y0) < 3) return;
    drag.moved = true;
    const clip = drag.clip;
    let at = drag.at0 + dx / state.pps;
    if (spacing()) {
      const a = snap(at) - at,
        b = snap(at + clip.len) - (at + clip.len);
      at += Math.abs(a) <= Math.abs(b) ? a : b;
    }
    clip.at = Math.min(Math.max(0, total() - clip.len), Math.max(0, at));
    drag.el.style.left = clip.at * state.pps + 'px';
    // Dragging up or down moves the clip to another track.
    const under = [...el.lanes.children].find(l => {
      const r = l.getBoundingClientRect();
      return event.clientY >= r.top && event.clientY < r.bottom;
    });
    if (under && under.dataset.lane !== drag.to) {
      drag.to = under.dataset.lane;
      under.append(drag.el);
    }
  });
  const endMarquee = () => {
    if (!msel) return;
    const m = msel;
    msel = null;
    if (m.moved) return;
    // A plain click in select mode clears the area and moves the listening point.
    state.sel = null;
    paintSelection();
    const t = snapped(m.t0);
    setPlayhead(t, false);
    o.seek(t);
  };
  const endRuler = () => {
    if (!rsel) return;
    const r = rsel;
    rsel = null;
    if (r.moved) return;
    // A plain click on the ruler moves the listening point (snapped).
    const t = snapped(r.t0);
    setPlayhead(t, false);
    o.seek(t);
  };
  const endDrag = () => {
    endMarquee();
    endRuler();
    if (fdrag) {
      const d = fdrag;
      fdrag = null;
      if (d.moved) commit(d.before);
      else syncFades();
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved && d.to !== d.from) {
      state.clips[d.from] = state.clips[d.from].filter(c => c !== d.clip);
      d.clip.src ||= d.from;
      ensure(d.to).push(d.clip);
      state.clips[d.to].sort((a, b) => a.at - b.at);
      state.lane = d.to;
    }
    if (d.moved) commit(d.before);
  };
  o.root.addEventListener('pointerup', endDrag);
  o.root.addEventListener('pointercancel', endDrag);

  o.root.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.fxKey) {
      if (!fxPanel.hidden && fxKey === b.dataset.fxKey) closeFx();
      else openFx(b.dataset.fxKey, b);
    } else if (b.dataset.tlMute) o.toggle(b.dataset.tlMute, 'mute');
    else if (b.dataset.tlSolo) o.toggle(b.dataset.tlSolo, 'solo');
    else if (b.dataset.removeKey) o.remove(b.dataset.removeKey);
    else if (b.dataset.tl === 'mode-move' || b.dataset.tl === 'mode-select') {
      state.mode = b.dataset.tl === 'mode-select' ? 'select' : 'move';
      tool('mode-move').classList.toggle('selected', state.mode === 'move');
      tool('mode-select').classList.toggle('selected', state.mode === 'select');
      el.scroll.classList.toggle('select-mode', state.mode === 'select');
    } else if (b.dataset.tl === 'clearsel') {
      state.sel = null;
      paintSelection();
    } else if (b.dataset.tl === 'copy') copy();
    else if (b.dataset.tl === 'paste') paste();
    else if (b.dataset.tl === 'addlane') o.addLane();
    else if (b.dataset.tl === 'split') split();
    else if (b.dataset.tl === 'delete') removeSelected();
    else if (b.dataset.tl === 'undo') undo();
    else if (b.dataset.tl === 'half') {
      // Cycles 1 → ÷2 (beat twice as long) → ×2 (beat half as long) → 1: fixes half/double-time detection.
      state.scale = state.scale === 1 ? 2 : state.scale === 2 ? 0.5 : 1;
      render();
      o.tempoChanged?.();
    }
  });
  let fadeBefore = null;
  o.root.addEventListener('focusin', event => {
    if (['fadein', 'fadeout'].includes(event.target.dataset?.tl)) fadeBefore = snapshot();
  });
  o.root.addEventListener('change', event => {
    const t = event.target.dataset?.tl;
    if (t === 'fadein' || t === 'fadeout') {
      setFade(t === 'fadein' ? 'in' : 'out', Number(event.target.value) || 0, fadeBefore ?? snapshot());
      fadeBefore = null;
      return;
    }
    if (t === 'snap') {
      state.snap = event.target.value;
      render();
    } else if (t === 'downbeat') {
      state.downbeat = Number(event.target.value);
      render();
    }
  });
  o.root.addEventListener('input', event => {
    const panKey = event.target.dataset?.tlPan;
    if (panKey) {
      const value = Number(event.target.value) / 100;
      event.target.title = 'Pan ' + panText(value) + ' · double-click to center';
      o.setPan(panKey, value);
      return;
    }
    const gainKey = event.target.dataset?.tlGain;
    if (gainKey) {
      event.target.title = `Level ${event.target.value}% · double-click to reset to 100%`;
      o.setGain(gainKey, Number(event.target.value) / 100);
      return;
    }
    if (event.target.dataset?.tl !== 'zoom') return;
    const centre = (el.scroll.scrollLeft + el.scroll.clientWidth / 2) / state.pps;
    state.pps = Math.min(Number(event.target.value), 30000 / total());
    render();
    el.scroll.scrollLeft = centre * state.pps - el.scroll.clientWidth / 2;
  });
  // Keyboard shortcuts only while the timeline (or something inside it) has focus.
  o.root.addEventListener('dblclick', event => {
    const panKey = event.target.dataset?.tlPan;
    if (panKey) {
      event.target.value = '0';
      event.target.title = 'Centered · double-click to center';
      o.setPan(panKey, 0);
      return;
    }
    const gainKey = event.target.dataset?.tlGain;
    if (!gainKey) return;
    event.target.value = '100';
    event.target.title = 'Level 100% · double-click to reset to 100%';
    o.setGain(gainKey, 1);
  });
  o.root.addEventListener('keydown', event => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (event.key === 'Escape' && state.sel) {
      state.sel = null;
      paintSelection();
    } else if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      split();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (copy()) event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      paste();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    }
  });

  return {
    render,
    setPlayhead,
    /** Keeps the label slider in step when the volume is changed from the rows below the timeline. */
    /** Tempo of the beat grid in BPM (with the ×2/÷2 correction), or null while it is unknown. */
    bpm() {
      const g = grid();
      return g ? 60 / g.period : null;
    },
    /** The track that was chosen last (clicked label or lane), or null. */
    currentLane: () => state.lane,
    /** Adds a clip from outside (an import or a take) as one undoable step. */
    addClip(key, clip) {
      const before = snapshot();
      ensure(key).push({
        id: uid(),
        at: clip.at,
        from: clip.from || 0,
        len: clip.len,
        src: clip.src,
        fi: 0,
        fo: 0,
      });
      state.clips[key].sort((a, b) => a.at - b.at);
      commit(before);
    },
    selection: () => (state.sel ? { ...state.sel } : null),
    clearSelection() {
      state.sel = null;
      paintSelection();
    },
    syncGain(key, value) {
      const slider = o.root.querySelector(`[data-tl-gain="${key}"]`);
      if (slider) slider.value = String(Math.round(value * 100));
    },
    /** Cuts of every track (created lazily from the loaded audio): { key: [{at, from, len}] } */
    clips() {
      return Object.fromEntries(
        o.keys().map(key => [
          key,
          ensure(key).map(({ at, from, len, src, fi, fo }) => ({
            at,
            from,
            len,
            src: src || key,
            fi: fi || 0,
            fo: fo || 0,
          })),
        ])
      );
    },
    load(saved) {
      state.clips = {};
      state.history = [];
      state.selected = null;
      state.fitted = false;
      for (const [key, list] of Object.entries(saved || {}))
        state.clips[key] = list.map(c => ({
          id: uid(),
          at: c.at,
          from: c.from,
          len: c.len,
          src: c.src || key,
          fi: c.fi || 0,
          fo: c.fo || 0,
        }));
    },
    /** Fits the whole song to the visible width once, as soon as the timeline is actually laid out (never while hidden). */
    ensureFit() {
      const width = el.scroll.clientWidth;
      if (state.fitted || width < 120 || o.total() <= 1) return;
      state.fitted = true;
      state.pps = Math.max(4, Math.min(120, (width - 8) / total()));
      tool('zoom').value = String(Math.round(state.pps));
      render();
    },
    forget(key) {
      delete state.clips[key];
      // Cuts on other tracks that played this track's audio would become silent: drop them too.
      for (const list of Object.keys(state.clips))
        state.clips[list] = state.clips[list].filter(c => (c.src || list) !== key);
      if (state.lane === key) state.lane = null;
    },
  };
}
