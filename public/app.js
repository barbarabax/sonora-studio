// @codedna
// description: Accessible local music composer, live library and persistent audio player.
// exports: none
// used_by: none
// rules:   Escape all stored user content before rendering. Never autoplay a newly generated track.
// agent:   Codex - 2026-10-04 - Initial interactive studio UI; automatic vocal duration and editable section timing.
//          Claude - 2026-10-04 - Audio Lab view and entry points.
import { initPromptStudio } from './prompt-ui.mjs';
import { estimateSongDuration, parseDuration } from './song-duration.mjs';
import { bindDurationField } from './duration-field.mjs';
import { initAudioEditor } from './editor-ui.mjs';
import { initAudioLab } from './audio-lab-ui.mjs';
import { initStemMixer } from './mixer-ui.mjs';
import { initLoraTrainer } from './trainer-ui.mjs';
import { initCreateUi } from './create-ui.mjs';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const paths = {
  spark: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z M20 2v4 M18 4h4',
  library: 'M4 4h4v16H4z M11 4h4v16h-4z M18 5l3 14',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  archive: 'M4 7h16v14H4z M3 3h18v4H3z M9 11h6',
  help: 'M9 9a3 3 0 1 1 4 2.8c-1 .3-1 1.2-1 2.2 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  music: 'M9 18V5l12-2v13 M9 8l12-2 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  sliders: 'M4 5h16 M4 12h16 M4 19h16 M8 3v4 M16 10v4 M10 17v4',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M7 5h3v14H7z M14 5h3v14h-3z',
  previous: 'M5 5v14 M19 5 8 12l11 7V5Z',
  next: 'M19 5v14 M5 5l11 7-11 7V5Z',
  volume: 'm11 5-6 4H2v6h3l6 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
  download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  close: 'm6 6 12 12 M6 18 18 6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  reuse: 'M3 10a9 9 0 1 1 1 7 M3 4v6h6',
  connection: 'M8 16 16 8 M7 10l-3 3a4 4 0 0 0 6 6l3-3 M14 5l1-1a4 4 0 0 1 6 6l-3 3',
  check: 'm5 12 4 4L20 5',
  wave: 'M3 10v4 M7 6v12 M11 3v18 M15 7v10 M19 10v4',
};
const icon = name =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.music}"/></svg>`;
const escape = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const time = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const durationField = bindDurationField($('#duration'), $('#duration-preset'));
const hue = id => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const mediaUrl = (id, format = 'mp3', download = false) =>
  `/api/jobs/${id}/audio?format=${format}${download ? '&download=1' : ''}`;
const terminal = j => ['done', 'failed', 'cancelled'].includes(j.status);
$$('[data-icon]').forEach(el => (el.innerHTML = icon(el.dataset.icon)));

let state = { jobs: [], health: {}, workspaces: [] },
  workspace = 'general',
  view = 'create',
  filter = 'all',
  instrumental = false,
  currentId = null,
  signature = '',
  submitting = false,
  toastTimer,
  peaks = null,
  waveToken = 0,
  durationOverrides = {},
  durationEstimate = null,
  durationSignature = '';
const form = $('#create-form'),
  audio = $('#audio');
audio.volume = 0.8;
const keys = [
  'C',
  'C#',
  'Db',
  'D',
  'D#',
  'Eb',
  'E',
  'F',
  'F#',
  'Gb',
  'G',
  'G#',
  'Ab',
  'A',
  'A#',
  'Bb',
  'B',
].flatMap(k => [`${k} major`, `${k} minor`]);
$('#keyscale').innerHTML = keys.map(k => `<option>${escape(k)}</option>`).join('');
// Tabs (Custom / Remix / Edit), Auto rows, Creative↔Robust slider, reference audio, dice and saved prompts.
const create = initCreateUi({
  api,
  toast,
  state: () => state,
  workspace: () => workspace,
  getInput: () => getInput(),
  applyInput: patch => fillInput({ ...getInput(), ...patch }),
  setFields(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const el = form.elements.namedItem(key);
      if (el) el.value = value;
    }
    updateDuration();
    saveDraft();
  },
  changed() {
    updateDuration();
    saveDraft();
  },
  afterRework: () => setView('library'),
});
async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Sonora': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || 'Request failed.');
  return value;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}
function getInput() {
  const d = Object.fromEntries(new FormData(form));
  for (const key of ['duration', 'variants', 'bpm', 'seed', 'guidance', 'creativity'])
    d[key] = Number(d[key]);
  d.workspaceId = workspace;
  d.manualDuration = durationField.read() ?? Number.NaN;
  d.duration = d.manualDuration;
  d.durationMode = $('#duration-mode').value;
  d.lyricPacing = $('#lyric-pacing').value;
  d.durationArrangement = $('#duration-arrangement').value;
  d.durationOverrides = durationOverrides;
  if (!instrumental && d.durationMode === 'auto') {
    const estimate = estimateSongDuration(d);
    d.duration = estimate.seconds;
  }
  if (!d.referenceId) delete d.referenceId;
  return { ...d, ...create.extraInput(), instrumental };
}
function durationBlocked() {
  const automatic = !instrumental && $('#duration-mode').value === 'auto';
  // Rules: a typed length must be valid whenever it is the one that will be used (manual vocal mode and instrumentals).
  if (!automatic && durationField.read() === null) return true;
  return automatic && (!durationEstimate?.valid || durationEstimate.overflow);
}
function updateDuration(keepRows = false) {
  const automatic = !instrumental && $('#duration-mode').value === 'auto';
  durationEstimate = estimateSongDuration({
    lyrics: $('#lyrics').value,
    bpm: Number($('#bpm').value),
    timesignature: $('#timesignature').value,
    language: $('#language').value,
    lyricPacing: $('#lyric-pacing').value,
    durationArrangement: $('#duration-arrangement').value,
    durationOverrides,
  });
  const estimate = durationEstimate;
  $('#vocal-duration-options').hidden = instrumental;
  $('#duration-mode').hidden = instrumental;
  $('#duration-calculator').hidden = instrumental;
  $('#duration-field').hidden = automatic;
  $('#duration').disabled = automatic;
  $('#auto-duration').hidden = !automatic;
  $('#duration-label').textContent = automatic ? 'Estimated duration' : 'Duration';
  $('#duration-label').htmlFor = automatic ? 'auto-duration' : 'duration';
  $('#auto-duration').textContent = estimate.valid ? '≈ ' + time(estimate.seconds) : '—';
  $('#auto-duration').classList.toggle('over-limit', estimate.overflow);
  const perBar = estimate.secondsPerBar?.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  $('#duration-note').textContent = !estimate.valid
    ? estimate.reason
    : automatic
      ? estimate.overflow
        ? `Estimate ${time(estimate.seconds)}: exceeds the 5-minute limit. Edit the lyrics, phrasing or bars.`
        : `${estimate.vocalBars} vocal bars + ${estimate.instrumentalBars} instrumental bars · ${perBar} sec/bar. Estimate for the next track.${estimate.totalBars * estimate.secondsPerBar < 10 ? ' Minimum: 10 seconds.' : ''}`
      : `Estimate from lyrics and musical spaces: about ${time(estimate.seconds)}. The selected duration stays at ${time(durationField.read() ?? 0)}.`;
  const promptBpms = [
    ...new Set(
      [...$('#tags').value.matchAll(/\b(\d{2,3})\s*BPM\b/gi)]
        .map(m => Number(m[1]))
        .filter(b => b >= 30 && b <= 250)
    ),
  ];
  const conflict = promptBpms.length === 1 && promptBpms[0] !== Number($('#bpm').value);
  // Warn when the prompt already names a different voice than the one chosen.
  const tagsText = $('#tags').value.toLowerCase(),
    voice = $('#vocal').value;
  const saysFemale = /\b(female|woman|women|girl|femminil\w*|donna)\b/.test(tagsText),
    saysMale = /\b(?<!fe)(male|man|men|boy|maschil\w*|uomo)\b/.test(tagsText);
  const clash =
    (voice === 'female' && saysMale && !saysFemale) || (voice === 'male' && saysFemale && !saysMale);
  $('#vocal-note').textContent = clash
    ? 'The prompt describes a different vocal type. Update the prompt or selection; otherwise, results may be unpredictable.'
    : 'ACE-Step selects the voice from the prompt. Your selection is added explicitly.';
  $('#vocal-note').classList.toggle('over-limit', clash);
  $('#duration-bpm-note').hidden = !conflict;
  $('#duration-bpm-note').textContent = conflict
    ? `The prompt specifies ${promptBpms[0]} BPM, while the estimate and ComfyUI use ${$('#bpm').value} BPM. Change it in Music controls.`
    : '';
  $('#duration-note').classList.toggle('over-limit', automatic && estimate.overflow);
  $('#duration-formula').textContent = estimate.valid
    ? `${$('#bpm').value} BPM · ${estimate.meter} → ${perBar} sec/bar · ${estimate.totalBars} bars → ${time(estimate.seconds)}`
    : '';
  const next = JSON.stringify(estimate.sections);
  if (!keepRows && next !== durationSignature) {
    $('#duration-sections').innerHTML = estimate.sections
      .map(
        s =>
          `<div class="duration-section"><div><strong>${escape(s.title)}</strong><small>${s.overridden ? 'Bars adjusted' : s.synthetic ? 'Musical space added' : s.repeated ? 'Repeated chorus' : s.lines ? s.lines + ' lyric lines' : 'Written instrumental section'}</small></div><input type="number" min="${s.synthetic ? 0 : 1}" max="128" step="1" value="${s.bars > 0 ? s.bars : s.synthetic ? '0' : ''}" placeholder="0" data-duration-section="${escape(s.id)}" aria-label="Bars ${escape(s.title)}"><span>${time(s.seconds)}</span></div>`
      )
      .join('');
    durationSignature = next;
  }
  $('#duration-reset').hidden = !Object.keys(durationOverrides).length;
  $('#generate').disabled = !state.health.ready || submitting || durationBlocked();
}
function saveDraft() {
  try {
    localStorage.setItem('sonora-draft-v1', JSON.stringify(getInput()));
  } catch {}
}
function mode(value) {
  instrumental = value;
  $('#lyrics-section').hidden = value;
  $('#lyrics').required = !value;
  $('#vocal-row').hidden = value;
  $$('[data-mode]').forEach(b =>
    b.classList.toggle('selected', (b.dataset.mode === 'instrumental') === value)
  );
  updateDuration();
}
function fillInput(input) {
  const typed = input.manualDuration ?? input.duration;
  const manual = typeof typed === 'number' ? typed : parseDuration(typed);
  for (const [key, value] of Object.entries(input)) {
    const el = form.elements.namedItem(key);
    if (el) el.value = value;
  }
  if (Number.isInteger(manual) && manual >= 10 && manual <= 300) durationField.write(manual);
  $('#duration-mode').value = input.durationMode === 'manual' ? 'manual' : 'auto';
  $('#lyric-pacing').value = ['normal', 'fast', 'relaxed'].includes(input.lyricPacing)
    ? input.lyricPacing
    : 'normal';
  $('#duration-arrangement').value = ['written', 'balanced', 'spacious'].includes(input.durationArrangement)
    ? input.durationArrangement
    : 'balanced';
  durationOverrides =
    input.durationOverrides &&
    typeof input.durationOverrides === 'object' &&
    !Array.isArray(input.durationOverrides)
      ? { ...input.durationOverrides }
      : {};
  durationSignature = '';
  // A saved draft from before the Auto rows has no autoMeta: its values stay as they are.
  create.applyAuto(Array.isArray(input.autoMeta) ? input.autoMeta : []);
  create.setReference(input.referenceId, input.referenceName);
  create.syncSlider();
  mode(!!input.instrumental);
  saveDraft();
}
try {
  const draft = JSON.parse(localStorage.getItem('sonora-draft-v1'));
  if (draft) fillInput(draft);
} catch {}
mode(instrumental);
form.addEventListener('input', e => {
  if (e.target.matches('[data-duration-section]')) return;
  if (e.target.id === 'lyrics') durationOverrides = {};
  updateDuration();
  saveDraft();
});
form.addEventListener('change', () => {
  updateDuration();
  saveDraft();
});
$('#duration-sections').addEventListener('input', e => {
  const id = e.target.dataset.durationSection;
  if (!id) return;
  if (e.target.value === '') delete durationOverrides[id];
  else if (e.target.validity.valid) durationOverrides[id] = Number(e.target.value);
  updateDuration(true);
  saveDraft();
});
$('#duration-reset').addEventListener('click', () => {
  durationOverrides = {};
  durationSignature = '';
  updateDuration();
  saveDraft();
});
$$('[data-mode]').forEach(b =>
  b.addEventListener('click', () => {
    mode(b.dataset.mode === 'instrumental');
    saveDraft();
  })
);
const presets = {
  indie: 'dreamy indie pop, warm guitars, soft synths, catchy chorus, intimate vocals',
  lofi: 'lo-fi, mellow piano, warm bass, dusty drums, relaxed atmosphere',
  cinematic:
    'cinematic orchestral, emotional strings, expressive piano, slow crescendo, expansive atmosphere',
  electronic: 'melodic electronic, analog synthesizers, deep bass, pulsing beat, spacious production',
};
$$('[data-preset]').forEach(b =>
  b.addEventListener('click', () => {
    const field = $('#tags');
    const text = presets[b.dataset.preset];
    field.value = field.value.trim() ? `${field.value.trim()}, ${text}` : text;
    field.focus();
    saveDraft();
  })
);
$('#structure').addEventListener('click', () => {
  const field = $('#lyrics');
  field.value +=
    (field.value.trim() ? '\n\n' : '') + '[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n';
  durationOverrides = {};
  field.focus();
  updateDuration();
  saveDraft();
});
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  $('#form-error').hidden = true;
  $('#generate').disabled = true;
  $('#generate').children[1].textContent =
    state.health.backend === 'runpod' ? 'Sending a RunPod…' : 'Sending a ComfyUI…';
  try {
    let input = getInput();
    if (input.autoMeta.length) {
      $('#generate').children[1].textContent = 'Choosing tempo and key…';
      if (Object.keys(await create.resolveAuto(input)).length) input = getInput();
    }
    const result = await api('/api/generate', 'POST', input);
    const failed = result.jobs.filter(j => j.status === 'failed');
    if (failed.length === result.jobs.length) throw new Error(failed[0].error);
    toast(
      result.jobs.length > 1
        ? `${result.jobs.length} variations added to the queue.`
        : 'Your track is queued.'
    );
    saveDraft();
    $('#prompt-studio').dispatchEvent(new Event('sonora:song-created'));
  } catch (e) {
    $('#form-error').textContent = e.message;
    $('#form-error').hidden = false;
  } finally {
    submitting = false;
    $('#generate').disabled = !state.health.ready || durationBlocked();
    $('#generate').children[1].textContent = 'Create your track';
  }
});
function setView(next) {
  view = next;
  document.body.classList.toggle('library-only', view !== 'create');
  document.body.classList.toggle('prompt-mode', view === 'prompt');
  document.body.classList.toggle('editor-mode', view === 'editor');
  document.body.classList.toggle('lab-mode', view === 'lab');
  document.body.classList.toggle('mixer-mode', view === 'mixer');
  $('#stem-mixer').hidden = view !== 'mixer';
  mixer.setActive(view === 'mixer');
  document.body.classList.toggle('trainer-mode', view === 'trainer');
  $('#lora-trainer').hidden = view !== 'trainer';
  trainer.setActive(view === 'trainer');
  $('#audio-editor').hidden = view !== 'editor';
  $('#audio-lab').hidden = view !== 'lab';
  editor.setActive(view === 'editor');
  lab.setActive(view === 'lab');
  if (view === 'editor' || view === 'lab' || view === 'mixer') audio.pause();
  $('#prompt-studio').hidden = view !== 'prompt';
  if (view === 'prompt') $('#prompt-studio').dispatchEvent(new Event('sonora:prompt-open'));
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const name = {
    create: 'Create music',
    library: 'Library',
    favorites: 'Favorites',
    archive: 'Archive',
    prompt: 'Prompt and lyrics studio',
    editor: 'Audio editor',
    lab: 'Audio Lab',
    mixer: 'Stem mixer',
    trainer: 'LoRA trainer',
  }[view];
  $('#view-name').textContent = name;
  $('#library-title').firstChild.textContent = {
    create: 'Your creations ',
    library: 'Your library ',
    favorites: 'Your favorites ',
    archive: 'Archive ',
    prompt: 'Your creations ',
    editor: 'Your creations ',
    lab: 'Your creations ',
    trainer: 'Your creations ',
  }[view];
  signature = '';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
const editor = initAudioEditor({
  api,
  toast,
  pauseLibrary: () => audio.pause(),
  openView: () => setView('editor'),
  openLab: (jobId, mixId) => lab.open('mix', jobId, mixId),
});
const mixer = initStemMixer({
  api,
  toast,
  pauseLibrary: () => audio.pause(),
  openView: () => setView('mixer'),
  onExported: async () => {
    state = await api('/api/state');
    signature = '';
    render();
  },
});
const lab = initAudioLab({ api, toast, pauseLibrary: () => audio.pause(), openView: () => setView('lab') });
const trainer = initLoraTrainer({ api, toast });
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$$('[data-filter]').forEach(b =>
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $$('[data-filter]').forEach(x => x.classList.toggle('selected', x === b));
    signature = '';
    render();
  })
);
$('#search').addEventListener('input', () => {
  signature = '';
  render();
});
/** Rules: a job without workspaceId belongs to 'general'; the chosen workspace is remembered per browser. */
const inWorkspace = j => (j.workspaceId || 'general') === workspace;
function renderWorkspaces() {
  const list = state.workspaces?.length ? state.workspaces : [{ id: 'general', name: 'General' }];
  if (!list.some(w => w.id === workspace)) workspace = 'general';
  const key = JSON.stringify([list, workspace]);
  if ($('#workspace').dataset.key === key) return;
  $('#workspace').dataset.key = key;
  $('#workspace').innerHTML = list
    .map(
      w =>
        `<option value="${escape(w.id)}"${w.id === workspace ? ' selected' : ''}>${escape(w.name)}</option>`
    )
    .join('');
  $('#workspace-delete').hidden = workspace === 'general';
}
function visibleJobs() {
  const query = $('#search').value.trim().toLowerCase();
  return state.jobs.filter(
    j =>
      inWorkspace(j) &&
      (view === 'archive' ? j.archived : !j.archived) &&
      (view !== 'favorites' || j.favorite) &&
      (filter === 'all' || (filter === 'instrumental') === j.input.instrumental) &&
      (!query || `${j.title} ${j.input.tags} ${j.input.lyrics}`.toLowerCase().includes(query))
  );
}
function render() {
  renderLocalModelSetup();
  editor.render(state);
  lab.render(state);
  mixer.render(state);
  trainer.render(state);
  const h = state.health;
  $('#engine-model').textContent = 'ACE-Step 1.5 XL Turbo';
  const session = state.gpuSession || { active: false, phase: 'off' };
  $('#gpu-session').hidden = h.backend !== 'runpod' && !session.active;
  $('#gpu-session-toggle').textContent = session.active
    ? 'Stop GPU session'
    : 'Start a 30-minute GPU session';
  $('#gpu-session-status').textContent =
    session.error ||
    (session.active
      ? `Session active · expires at ${new Date(session.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. RunPod credits are used while it is on.${session.phase === 'stopping' ? ' Shutting down…' : ' The first startup may take a few minutes.'}`
      : 'Keeps a GPU worker active for 30 minutes. RunPod credits are used while it is on.');
  $('#engine-location').textContent =
    h.backend === 'runpod' ? 'RunPod GPU' : h.backend === 'vast' ? 'Vast.ai GPU' : 'your computer';
  if (h.backend) $('#generation-backend').value = h.backend;
  $('#generation-note').textContent =
    h.backend === 'runpod'
      ? 'Generation uses your RunPod account and credits.'
      : h.backend === 'vast'
        ? 'Connected to your existing Vast.ai instance.'
        : 'Generation runs on your computer with ComfyUI.';
  $('#connection').classList.toggle('offline', !h.ready);
  $('#connection span').textContent = h.ready
    ? h.backend === 'runpod'
      ? 'RunPod ready'
      : h.backend === 'vast'
        ? 'Vast.ai connected'
        : 'Engine connected'
    : h.online
      ? 'Check installed models'
      : 'Engine offline';
  $('#connection').title = h.message || 'ComfyUI connection';
  $('#offline-banner').hidden = !!h.ready;
  $('#offline-message').textContent = h.message || 'Connecting to engine…';
  $('#generate').disabled = submitting || !h.ready || durationBlocked();
  renderWorkspaces();
  create.refresh();
  $('#finish').querySelector('[value="final"]').disabled = !h.sftAvailable && h.backend === 'runpod';
  $('#finish-note').textContent = h.sftAvailable
    ? 'Use Turbo for drafts and Final for a version to keep. Final uses 50 steps instead of 8 and takes longer.'
    : 'The Final (SFT) model is not installed on RunPod. Only Fast is available.';
  $('#nav-count').textContent = state.jobs.filter(
    j => j.status === 'done' && !j.archived && inWorkspace(j)
  ).length;
  const active = state.jobs.filter(j => !terminal(j));
  $('#activity').hidden = !active.length;
  if (active.length) {
    const j = active.find(j => j.status === 'running') || active[0];
    $('#activity').innerHTML =
      `<span class="spinner"></span><div>${escape(j.title)}<span class="sub">${escape(j.phase)}${j.progress ? ` · ${j.progress.value}/${j.progress.max} steps` : ''}</span></div><span>${active.length} active</span>`;
  }
  const jobs = visibleJobs();
  $('#track-count').textContent = jobs.length;
  const sig = JSON.stringify([
    view,
    filter,
    workspace,
    jobs.map(j => [j.id, j.title, j.favorite, j.archived, j.status, j.phase, j.progress, j.error]),
    currentId,
    audio.paused,
  ]);
  if (sig !== signature) {
    signature = sig;
    const focus = document.activeElement?.closest('[data-action]');
    const focusKey = focus ? { id: focus.dataset.id, action: focus.dataset.action } : null;
    $('#tracks').innerHTML = jobs
      .map(j => {
        const done = j.status === 'done',
          playing = j.id === currentId && !audio.paused;
        const pct = j.progress ? Math.min(100, (100 * j.progress.value) / Math.max(1, j.progress.max)) : 0;
        return `<article class="track ${playing ? 'playing' : ''}" data-job="${j.id}"><div class="cover ${done ? '' : terminal(j) ? 'failed' : 'pending'}" style="--hue:${hue(j.id)}"><button class="cover-play" data-action="${done ? 'play' : 'details'}" data-id="${j.id}" aria-label="${done ? (playing ? 'Pause' : 'Play') : 'Details'} ${escape(j.title)}">${done ? icon(playing ? 'pause' : 'play') : terminal(j) ? icon(j.status === 'cancelled' ? 'close' : 'help') : '<span class="spinner"></span>'}</button></div><div class="track-copy" data-action="details" data-id="${j.id}" role="button" tabindex="0" aria-label="Details ${escape(j.title)}"><div class="track-title"><strong>${escape(j.title)}</strong>${j.input.variants === 2 ? `<span class="variant">v${j.variant}</span>` : ''}</div><div class="track-tags ${done ? '' : 'status-line'} ${j.status === 'failed' ? 'failed' : ''}">${done ? escape(j.input.tags) : escape(j.phase) + (j.progress ? ` · ${j.progress.value}/${j.progress.max}` : '')}</div><div class="track-meta">${j.kind === 'master' ? '<span class="track-badge">Master</span>' : ''}<span>${j.input.instrumental ? 'Instrumental' : 'With vocals'}</span><span>${j.input.bpm} BPM</span><span>${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(j.createdAt))}</span></div>${!done && j.progress ? `<div class="track-progress"><i style="width:${pct}%"></i></div>` : ''}</div><span class="track-duration">${time(j.input.duration)}</span><div class="track-actions">${!terminal(j) ? `<button class="icon-button" data-action="cancel" data-id="${j.id}" aria-label="Cancel ${escape(j.title)}" title="Cancel" ${j.status === 'submitting' || j.status === 'cancelling' ? 'disabled' : ''}>${icon('close')}</button>` : `<button class="icon-button ${j.favorite ? 'active' : ''}" data-action="favorite" data-id="${j.id}" aria-label="${j.favorite ? 'Remove from' : 'Add to'} favorites" title="Favorites">${icon('heart')}</button>`}<button class="icon-button" data-action="details" data-id="${j.id}" aria-label="Options ${escape(j.title)}" title="Details and downloads">${icon('more')}</button></div></article>`;
      })
      .join('');
    if (focusKey) {
      const target = $$('#tracks [data-action]').find(
        b => b.dataset.id === focusKey.id && b.dataset.action === focusKey.action
      );
      target?.focus({ preventScroll: true });
    }
  }
  $('#empty').hidden = jobs.length > 0;
  if (!jobs.length) {
    $('#empty h3').textContent = state.jobs.length
      ? 'No tracks here yet.'
      : "Every track starts with an idea.";
    $('#empty p').innerHTML = $('#search').value
      ? 'Try another title or description.'
      : view === 'favorites'
        ? 'Select the heart beside a track<br>to find it here.'
        : view === 'archive'
          ? 'Archived tracks will appear here.<br>You can restore them at any time.'
          : 'Describe the sound you have in mind.<br>Your first creation will be here.';
  }
  updatePlayer();
}
async function patchJob(id, fields) {
  await api('/api/jobs/' + id, 'PATCH', fields);
  state = await api('/api/state');
  signature = '';
  render();
}
async function action(name, id) {
  const j = state.jobs.find(j => j.id === id);
  if (!j) return;
  try {
    if (name === 'play') await selectTrack(id);
    if (name === 'favorite') await patchJob(id, { favorite: !j.favorite });
    if (name === 'details') showDetails(j);
    if (name === 'rework') {
      $('#detail-dialog').close();
      setView('create');
      create.openRework(j, 'remix');
    }
    if (name === 'saveprompt') await create.saveFromJob(j);
    if (name === 'mixer') {
      $('#detail-dialog').close();
      mixer.open(id);
    }
    if (name === 'editor') {
      $('#detail-dialog').close();
      await editor.open(id);
    }
    if (name === 'lab') {
      $('#detail-dialog').close();
      await lab.open('job', id);
    }
    if (name === 'cancel') {
      await api(`/api/jobs/${id}/cancel`, 'POST', {});
      toast('Cancellation requested for this track.');
    }
    if (name === 'reuse') {
      fillInput({ ...j.input, durationMode: j.input.durationMode || 'manual', title: j.title, seed: -1 });
      $('#detail-dialog').close();
      setView('create');
      toast('Settings copied. The new track will use a random seed.');
    }
    if (name === 'archive') {
      await patchJob(id, { archived: !j.archived });
      $('#detail-dialog').close();
      toast(j.archived ? 'Track restored.' : 'Track archived. You can restore it from Archive.');
    }
  } catch (e) {
    toast(e.message);
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (b) action(b.dataset.action, b.dataset.id);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.track-copy')) action('details', e.target.dataset.id);
});
function showDetails(j) {
  $('#detail-content').innerHTML =
    `<div class="section-eyebrow">${j.kind === 'master' ? 'AUDIO LAB MASTER' : 'YOUR SESSION'} · ${j.input.instrumental ? 'INSTRUMENTAL' : 'WITH VOCALS'}</div>${j.kind === 'master' && j.master ? `<p class="field-hint">Mastered in Audio Lab: ${escape(j.master.loudness?.reached ?? '—')} LUFS, true peak ${escape(j.master.loudness?.truePeak ?? '—')} dBTP. The original stays in your library.</p>` : ''}<h2>${escape(j.title)}</h2><div class="detail-tags">${escape(j.input.tags)}</div><div class="detail-facts"><span>${time(j.input.duration)}</span><span>${j.input.bpm} BPM</span><span>${escape(j.input.keyscale)}</span><span>${j.input.quality === 'full' ? 'Full' : 'Light'}</span><span>Seed ${j.input.seed}</span></div>${j.error ? `<p class="error">${escape(j.error)}</p>` : ''}${!j.input.instrumental ? `<h3>Lyrics</h3><pre>${escape(j.input.lyrics)}</pre>` : ''}<h3>Workspace</h3><div class="rename-row"><select id="move-workspace" aria-label="Track workspace">${(state.workspaces || []).map(w => `<option value="${escape(w.id)}"${w.id === (j.workspaceId || 'general') ? ' selected' : ''}>${escape(w.name)}</option>`).join('')}</select><button class="pill-button" id="move-save" type="button">Move</button></div><h3>Rename</h3><form id="rename-form" class="rename-row"><input aria-label="Track title" name="title" value="${escape(j.title)}" maxlength="100" required><button class="pill-button" type="submit">Save</button></form><div class="detail-actions">${j.status === 'done' ? `<button class="pill-button" data-action="editor" data-id="${j.id}">${icon('sliders')}Open audio editor</button><button class="pill-button" data-action="lab" data-id="${j.id}">${icon('wave')}Open in Audio Lab</button>` : ''}${j.status === 'done' ? `<a class="pill-button" href="${mediaUrl(j.id, 'mp3', true)}">${icon('download')}MP3</a><a class="pill-button" href="${mediaUrl(j.id, 'wav', true)}">${icon('download')}WAV</a>` : ''}${j.status === 'done' && j.kind !== 'vocal-cover' ? `<button class="pill-button" data-action="rework" data-id="${j.id}">${icon('reuse')}Rework…</button>` : ''}${j.kind !== 'upload' && j.kind !== 'master' && j.input.tags ? `<button class="pill-button" data-action="saveprompt" data-id="${j.id}">★ Save this prompt</button>` : ''}${j.status === 'done' ? `<button class="pill-button" data-action="mixer" data-id="${j.id}">${icon('sliders')}Open in mixer${state.stems?.sessions?.some(x => x.id === j.id && x.status === 'ready') ? ' ✓ already separated' : ''}</button>` : ''}<button class="pill-button" data-action="reuse" data-id="${j.id}">${icon('reuse')}Reuse settings</button>${terminal(j) ? `<button class="pill-button" data-action="archive" data-id="${j.id}">${icon('archive')}${j.archived ? 'Restore' : 'Archive'}</button>` : ''}</div>${j.kind === 'master' ? '' : `<p class="field-hint" style="margin-top:20px"><a href="/api/jobs/${j.id}/workflow">Download the ComfyUI workflow (API format)</a></p>`}`;
  $('#move-save').addEventListener('click', async () => {
    try {
      await patchJob(j.id, { workspaceId: $('#move-workspace').value });
      $('#detail-dialog').close();
      toast('Track moved.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#rename-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await patchJob(j.id, { title: e.target.elements.title.value });
      $('#detail-dialog').close();
      toast('Title aggiornato.');
    } catch (err) {
      toast(err.message);
    }
  });
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach(d =>
  d.addEventListener('click', e => {
    if (e.target === d) {
      const rect = d.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)
        d.close();
    }
  })
);
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
async function reconnect() {
  try {
    await api('/api/reconnect', 'POST', {});
  } catch (e) {
    toast(e.message);
  }
}
$('#connection').addEventListener('click', reconnect);
$('#retry-connection').addEventListener('click', reconnect);
function updatePlayer() {
  const j = state.jobs.find(j => j.id === currentId);
  if (!j) return;
  $('#player-title').textContent = j.title;
  $('#player-subtitle').textContent = j.input.tags;
  $('#player-art').classList.remove('idle');
  $('#player-art').style.setProperty('--hue', hue(j.id));
  $('#player-art').innerHTML = '';
  $('#player-favorite').disabled = false;
  $('#player-favorite').classList.toggle('active', j.favorite);
  $('#player-favorite').setAttribute(
    'aria-label',
    j.favorite ? 'Remove from favorites' : 'Add to favorites'
  );
  $('#play').disabled = false;
  $('#play').innerHTML = icon(audio.paused ? 'play' : 'pause');
  $('#play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('#seek').disabled = !Number.isFinite(audio.duration);
  $('#previous').disabled = false;
  $('#next').disabled = false;
  $('#player-download').classList.remove('disabled');
  $('#player-download').href = mediaUrl(j.id, 'mp3', true);
}
async function selectTrack(id) {
  if (id === currentId) {
    if (audio.paused) await audio.play();
    else audio.pause();
    return;
  }
  currentId = id;
  peaks = null;
  audio.src = mediaUrl(id);
  audio.load();
  updatePlayer();
  drawWave();
  try {
    await audio.play();
  } catch {
    toast('Press play to start listening.');
  }
  buildWave(id);
}
async function buildWave(id) {
  const token = ++waveToken;
  let context;
  try {
    const bytes = await fetch(mediaUrl(id)).then(r => r.arrayBuffer());
    context = new AudioContext();
    const buffer = await context.decodeAudioData(bytes);
    if (token !== waveToken) return;
    const samples = buffer.getChannelData(0),
      count = 120,
      step = Math.max(1, Math.floor(samples.length / count));
    peaks = Array.from({ length: count }, (_, i) => {
      let peak = 0;
      for (let k = i * step; k < Math.min((i + 1) * step, samples.length); k += 16)
        peak = Math.max(peak, Math.abs(samples[k]));
      return peak;
    });
    drawWave();
  } catch {
    peaks = null;
    drawWave();
  } finally {
    context?.close();
  }
}
function drawWave() {
  const canvas = $('#waveform'),
    rect = canvas.getBoundingClientRect(),
    dpr = window.devicePixelRatio || 1;
  if (!rect.width) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const ratio = Number.isFinite(audio.duration) ? audio.currentTime / audio.duration : 0;
  if (!peaks) {
    ctx.fillStyle = '#454c47';
    ctx.fillRect(0, rect.height / 2 - 1, rect.width, 2);
    ctx.fillStyle = '#efb18c';
    ctx.fillRect(0, rect.height / 2 - 1, rect.width * ratio, 2);
    return;
  }
  const max = Math.max(...peaks, 0.01);
  const step = rect.width / peaks.length;
  peaks.forEach((p, i) => {
    const h = Math.max(2, (p / max) * (rect.height - 3));
    ctx.fillStyle = i / peaks.length < ratio ? '#edb191' : '#667266';
    ctx.fillRect(i * step, (rect.height - h) / 2, Math.max(1, step - 1.2), h);
  });
}
audio.addEventListener('timeupdate', () => {
  $('#elapsed').textContent = time(audio.currentTime);
  $('#seek').value = Number.isFinite(audio.duration) ? (audio.currentTime / audio.duration) * 1000 : 0;
  drawWave();
});
audio.addEventListener('loadedmetadata', () => {
  $('#total').textContent = time(audio.duration);
  updatePlayer();
});
audio.addEventListener('play', () => {
  signature = '';
  render();
});
audio.addEventListener('pause', () => {
  signature = '';
  render();
});
audio.addEventListener('error', () => toast('Could not play this audio file.'));
function nextTrack(direction, wrap = true) {
  const list = state.jobs.filter(j => j.status === 'done' && !j.archived);
  const index = list.findIndex(j => j.id === currentId);
  const next = index + direction;
  if (list.length && (wrap || next < list.length)) selectTrack(list[(next + list.length) % list.length].id);
}
audio.addEventListener('ended', () => nextTrack(1, false));
$('#play').addEventListener('click', () => {
  if (currentId) selectTrack(currentId).catch(e => toast(e.message));
});
$('#previous').addEventListener('click', () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else nextTrack(-1);
});
$('#next').addEventListener('click', () => nextTrack(1));
$('#player-favorite').addEventListener('click', () => {
  if (currentId) action('favorite', currentId);
});
$('#seek').addEventListener('input', e => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
});
$('#volume').addEventListener('input', e => (audio.volume = Number(e.target.value)));
window.addEventListener('resize', drawWave);
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target === document.body && view !== 'editor' && view !== 'lab' && currentId) {
    e.preventDefault();
    selectTrack(currentId).catch(() => {});
  }
});
const events = new EventSource('/api/events');
events.onmessage = event => {
  try {
    state = JSON.parse(event.data);
    render();
  } catch (e) {
    console.error('Invalid update', e);
  }
};
events.onerror = () => {
  state.health = {
    ...state.health,
    ready: false,
    online: false,
    message: 'Connection to Sonora was interrupted. Reconnecting automatically…',
  };
  render();
};
/** Fresh composer and assistant: markup defaults everywhere, no draft carried over from the previous song. */
function newSong(confirmed = false) {
  const filled = $('#tags').value.trim() || $('#lyrics').value.trim();
  if (
    !confirmed &&
    filled &&
    !confirm('Start over? This clears the current style, lyrics and settings.')
  )
    return;
  form.reset();
  create.reset();
  durationField.write(30);
  durationOverrides = {};
  durationSignature = '';
  try {
    localStorage.removeItem('sonora-draft-v1');
  } catch {}
  mode(false);
  saveDraft();
  $('#prompt-studio').dispatchEvent(new Event('sonora:prompt-reset'));
  toast('New song: all fields have been reset.');
}
$('#new-song').addEventListener('click', () => newSong());
initPromptStudio({
  onNewSong: () => newSong(true),
  onTransfer: patch => {
    fillInput({
      ...getInput(),
      ...patch,
      autoMeta: getInput().autoMeta.filter(k => !(k in patch)),
      ...(patch.duration ? { manualDuration: patch.duration } : {}),
      ...(patch.lyrics ? { durationOverrides: {} } : {}),
    });
    setView('create');
    toast('Prompt and settings transferred. Select Generate track when you are ready.');
  },
  currentContext: getInput,
  notify: toast,
});
$('#open-prompt').addEventListener('click', () => setView('prompt'));
api('/api/state')
  .then(s => {
    state = s;
    render();
  })
  .catch(e => toast(e.message));
function providerStatus(id, message, failed = false) {
  const status = $('#' + id);
  status.textContent = message;
  status.classList.toggle('error', failed);
}
function modelSize(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
function renderLocalModelSetup() {
  const setup = state.modelSetup || {};
  const status = $('#local-model-status');
  if (!status) return;
  const active = setup.status === 'downloading';
  const total = setup.totalBytes || 0;
  const currentBytes = Math.min(total, (setup.completedBytes || 0) + (setup.fileBytes || 0));
  const percent = total ? Math.min(100, Math.round((currentBytes / total) * 100)) : 0;
  const progress = active && total
    ? `<progress max="100" value="${percent}" aria-label="ACE-Step model download progress"></progress><small>${percent}% · ${modelSize(currentBytes)} / ${modelSize(total)}${setup.activeFile ? ` · ${escape(setup.activeFile)}` : ''}</small>`
    : '';
  status.innerHTML = `${escape(setup.message || 'Choose a ComfyUI folder, save it, then check its models.')}${progress}`;
  status.classList.toggle('error', setup.status === 'error');
  $('#local-model-check').disabled = active;
  $('#local-model-download').disabled = active || !setup.files?.some(file => file.status === 'missing');
  $('#local-model-cancel').hidden = !active;
  $('#local-model-files').innerHTML = (setup.files || []).map(file =>
    `<div class="model-file"><span>${escape(file.category)}/${escape(file.name)}</span><strong class="${file.status === 'present' ? 'model-present' : 'model-missing'}">${file.status === 'present' ? 'Installed' : 'Missing'} · ${modelSize(file.bytes)}</strong></div>`
  ).join('');
}
async function refreshProviderSettings() {
  const config = await api('/api/config');
  const providers = config.providers || {};
  const runpod = providers.runpod || {};
  const vast = providers.vast || {};
  $('#local-comfy-url').value = providers.local?.comfyUrl || config.comfyUrl || '';
  $('#local-comfy-root').value = providers.local?.comfyRoot || '';
  $('#runpod-endpoint').value = runpod.endpointId || '';
  $('#runpod-models-ready').checked = runpod.modelsReady === true;
  $('#generation-backend option[value="runpod"]').disabled = !runpod.configured;
  $('#generation-backend option[value="vast"]').disabled = !vast.configured || !vast.connected;
  $('#generation-backend').value = config.generationBackend || 'local';
  $('#vast-connect').disabled = !vast.configured;
  $('#vast-disconnect').disabled = !vast.connected;
  if (vast.connected && vast.instanceId) $('#vast-instance').value = String(vast.instanceId);
  return config;
}
async function loadVastInstances() {
  const select = $('#vast-instance');
  const selected = select.value;
  const { instances } = await api('/api/vast/instances');
  select.innerHTML = '<option value="">Select a running instance</option>';
  for (const instance of instances || []) {
    const option = document.createElement('option');
    option.value = String(instance.id);
    option.textContent = `${instance.label} · ${instance.status}${instance.gpu ? ` · ${instance.gpu}` : ''}`;
    select.append(option);
  }
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  return instances || [];
}
$('#provider-settings-open').addEventListener('click', async () => {
  $('#provider-dialog').showModal();
  try {
    const config = await refreshProviderSettings();
    if (config.providers?.vast?.configured) await loadVastInstances();
  } catch (e) {
    toast(e.message);
  }
});
$('#local-comfy-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  providerStatus('local-provider-status', 'Checking ComfyUI…');
  try {
    const result = await api('/api/settings/local', 'POST', {
      comfyUrl: $('#local-comfy-url').value.trim(),
      comfyRoot: $('#local-comfy-root').value.trim(),
    });
    state.health = result.health;
    render();
    providerStatus('local-provider-status', result.health?.message || 'Local ComfyUI settings saved.');
    await refreshProviderSettings();
  } catch (e) {
    providerStatus('local-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#local-model-check').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  providerStatus('local-provider-status', 'Saving the ComfyUI folder and checking its model files…');
  try {
    await api('/api/settings/local', 'POST', {
      comfyUrl: $('#local-comfy-url').value.trim(),
      comfyRoot: $('#local-comfy-root').value.trim(),
    });
    await refreshProviderSettings();
    const plan = await api('/api/models/plan', 'POST', {});
    state.modelSetup = {
      ...state.modelSetup,
      ...plan,
      status: plan.files.some(file => file.status === 'missing') ? 'checked' : 'ready',
      message: plan.files.some(file => file.status === 'missing')
        ? `${plan.files.filter(file => file.status === 'missing').length} model file(s) are missing (${modelSize(plan.totalBytes)} to download). Keep at least 22 GB free for the complete ACE-Step XL package.`
        : 'All four ACE-Step model files are present.',
    };
    renderLocalModelSetup();
    providerStatus('local-provider-status', 'ComfyUI folder saved.');
  } catch (e) {
    providerStatus('local-provider-status', e.message, true);
    state.modelSetup = { ...state.modelSetup, status: 'error', message: e.message };
    renderLocalModelSetup();
  } finally {
    button.disabled = false;
  }
});
$('#local-model-download').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/api/settings/local', 'POST', {
      comfyUrl: $('#local-comfy-url').value.trim(),
      comfyRoot: $('#local-comfy-root').value.trim(),
    });
    const plan = await api('/api/models/plan', 'POST', {});
    const missing = plan.files.filter(file => file.status === 'missing');
    const size = plan.totalBytes || 0;
    if (!missing.length) {
      state.modelSetup = { ...state.modelSetup, ...plan, status: 'ready', message: 'All four ACE-Step model files are present.' };
      renderLocalModelSetup();
      return;
    }
    const confirmed = window.confirm(
      `Download ${missing.length} missing ACE-Step model file(s) (${modelSize(size)}) to the selected ComfyUI models folders?\n\nThis may take a while and needs at least 22 GB of free disk space for a full setup. Sonora downloads only the model weights; it will not change ComfyUI, custom nodes, or settings.`
    );
    if (!confirmed) return;
    await api('/api/models/download', 'POST', { confirmed: true });
    state.modelSetup = { ...state.modelSetup, ...plan, status: 'downloading', message: 'Download starting…', completedBytes: 0 };
    renderLocalModelSetup();
  } catch (e) {
    providerStatus('local-provider-status', e.message, true);
    state.modelSetup = { ...state.modelSetup, status: 'error', message: e.message };
    renderLocalModelSetup();
  } finally {
    button.disabled = false;
  }
});
$('#local-model-cancel').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try {
    await api('/api/models/cancel', 'POST', {});
  } catch (e) {
    providerStatus('local-provider-status', e.message, true);
  } finally {
    event.currentTarget.disabled = false;
  }
});
$('#runpod-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  const apiKey = $('#runpod-api-key').value.trim();
  $('#runpod-api-key').value = '';
  button.disabled = true;
  providerStatus('runpod-provider-status', 'Verifying your endpoint and saving the key…');
  try {
    await api('/api/providers/runpod', 'POST', {
      endpointId: $('#runpod-endpoint').value.trim(),
      apiKey,
      modelsReady: $('#runpod-models-ready').checked,
    });
    await refreshProviderSettings();
    providerStatus('runpod-provider-status', 'RunPod endpoint verified. The API key is encrypted on this computer.');
  } catch (e) {
    providerStatus('runpod-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#vast-key-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  const apiKey = $('#vast-api-key').value.trim();
  $('#vast-api-key').value = '';
  button.disabled = true;
  providerStatus('vast-provider-status', 'Verifying your Vast.ai API key…');
  try {
    await api('/api/vast/key', 'POST', { apiKey });
    const instances = await loadVastInstances();
    await refreshProviderSettings();
    providerStatus('vast-provider-status', `Key verified. Found ${instances.length} instance(s) in your account.`);
  } catch (e) {
    providerStatus('vast-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#vast-instances-refresh').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try {
    const instances = await loadVastInstances();
    providerStatus('vast-provider-status', `Loaded ${instances.length} instance(s).`);
  } catch (e) {
    providerStatus('vast-provider-status', e.message, true);
  } finally {
    event.currentTarget.disabled = false;
  }
});
$('#vast-connect').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  providerStatus('vast-provider-status', 'Connecting to your running instance over SSH…');
  try {
    state.health = await api('/api/vast/connect', 'POST', { instanceId: $('#vast-instance').value });
    render();
    await refreshProviderSettings();
    providerStatus('vast-provider-status', state.health.message || 'Connected to Vast.ai.');
  } catch (e) {
    providerStatus('vast-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#vast-disconnect').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    state.health = await api('/api/vast/disconnect', 'POST', {});
    render();
    await refreshProviderSettings();
    providerStatus('vast-provider-status', 'Disconnected. Your Vast.ai instance is still running.');
  } catch (e) {
    providerStatus('vast-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
refreshProviderSettings().catch(e => toast(e.message));
$('#generation-backend').addEventListener('change', async event => {
  const select = event.target;
  select.disabled = true;
  try {
    state.health = await api('/api/generation/backend', 'POST', { backend: select.value });
    render();
  } catch (e) {
    toast(e.message);
    render();
  } finally {
    select.disabled = false;
  }
});
$('#gpu-session-toggle').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    state.gpuSession = await api('/api/gpu-session', 'POST', {
      action: state.gpuSession?.active ? 'stop' : 'start',
    });
    render();
    toast(
      state.gpuSession.active
        ? 'Session started. The GPU may take a few minutes to start.'
        : 'Session ended. Current jobs continue, then RunPod returns to automatic scale-down.'
    );
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
});
drawWave();

try {
  workspace = localStorage.getItem('sonora-workspace') || 'general';
} catch {}
function chooseWorkspace(id) {
  workspace = id;
  try {
    localStorage.setItem('sonora-workspace', id);
  } catch {}
  signature = '';
  $('#workspace').dataset.key = '';
  render();
}
$('#workspace').addEventListener('change', e => chooseWorkspace(e.target.value));
$('#workspace-add').addEventListener('click', async () => {
  const name = prompt('New workspace name:');
  if (!name) return;
  try {
    const created = await api('/api/workspaces', 'POST', { name });
    state = await api('/api/state');
    chooseWorkspace(created.id);
  } catch (e) {
    toast(e.message);
  }
});
$('#workspace-rename').addEventListener('click', async () => {
  const current = state.workspaces.find(w => w.id === workspace);
  const name = prompt('New workspace name:', current?.name || '');
  if (!name) return;
  try {
    await api('/api/workspaces/' + workspace, 'PATCH', { name });
    state = await api('/api/state');
    chooseWorkspace(workspace);
  } catch (e) {
    toast(e.message);
  }
});
$('#workspace-delete').addEventListener('click', async () => {
  const current = state.workspaces.find(w => w.id === workspace);
  if (!confirm(`Delete “${current?.name}”? Tracks are not deleted; they are moved to General.`)) return;
  try {
    await api('/api/workspaces/' + workspace, 'DELETE');
    state = await api('/api/state');
    chooseWorkspace('general');
  } catch (e) {
    toast(e.message);
  }
});
