// @codedna
// description: Accessible local music composer, live library and persistent audio player.
// exports: none
// used_by: none
// rules:   Escape all stored user content before rendering. Never autoplay a newly generated track.
// agent:   Codex - 2026-10-04 - Initial interactive studio UI; automatic vocal duration and editable section timing.
//          Claude - 2026-10-04 - Audio Lab view and entry points.
//          Codex - 2026-10-10 - LoRA strength slider and draft recovery.
import { initPromptStudio } from './prompt-ui.mjs';
import { estimateSongDuration, parseDuration } from './song-duration.mjs';
import { bindDurationField } from './duration-field.mjs';
import { initAudioEditor } from './editor-ui.mjs';
import { initYue2Ui } from './yue2-ui.mjs';
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
  dislike:
    'M17 14V3 M10 14l-1 6a2 2 0 0 0 2 2l6-8h3a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H6.6a2 2 0 0 0-2 1.6L3.2 11.6A2 2 0 0 0 5.2 14H10Z',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
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
// Tabs (Personalizzato / Remix / Modifica), Auto rows, Creativo↔Robusto slider, reference audio, dice and saved prompts.
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
// YuE2: write the melody-and-chords plan, change the chords, then sing the song from that plan.
async function selectMusicModel(value) {
  state.health = await api('/api/generation/model', 'POST', { musicModel: value });
  render();
}
const yue = initYue2Ui({
  api,
  toast,
  state: () => state,
  readFields: () => ({ tags: $('#tags').value, lyrics: $('#lyrics').value, seed: Number($('#seed').value) }),
  selectModel: selectMusicModel,
  applyInput: patch => fillInput({ ...getInput(), ...patch }),
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
  d.loraScale = Number($('#lora-scale').value);
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
  if (yue.active()) {
    // Rules: YuE2 decides the length itself and ignores the ACE-Step knobs: send safe values for them, so a long text or a leftover
    // value from another song never blocks the request (the duration estimate caps at 5:00, YuE2 songs can be longer).
    d.durationMode = 'manual';
    d.duration = 300;
    const safe = (key, min, max, fallback) =>
      Number.isFinite(d[key]) && d[key] >= min && d[key] <= max ? d[key] : fallback;
    d.bpm = Math.round(safe('bpm', 30, 250, 110));
    d.guidance = safe('guidance', 1, 5, 2);
    d.creativity = safe('creativity', 0.5, 1.3, 0.85);
    d.seed = Number.isInteger(d.seed) && d.seed >= -1 && d.seed <= 4294967294 ? d.seed : -1;
  }
  return {
    ...d,
    ...create.extraInput(),
    ...yue.extraInput(),
    instrumental: yue.active() ? false : instrumental,
  };
}
function durationBlocked() {
  if (yue.active()) return false;
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
        ? `Estimate ${time(estimate.seconds)}: it exceeds the 5-minute limit. Edit the lyrics, phrasing or bars.`
        : `${estimate.vocalBars} sung bars + ${estimate.instrumentalBars} musical · ${perBar} s per bar. Estimate for the next song.${estimate.totalBars * estimate.secondsPerBar < 10 ? ' Minimum 10 seconds.' : ''}`
      : `Estimate from the lyrics and the musical spaces: about ${time(estimate.seconds)}. The chosen duration stays ${time(durationField.read() ?? 0)}.`;
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
    ? 'The prompt describes a different voice: fix the prompt or the choice, otherwise the result is unpredictable.'
    : 'ACE-Step picks the voice from the prompt: your choice is added explicitly.';
  $('#vocal-note').classList.toggle('over-limit', clash);
  $('#duration-bpm-note').hidden = !conflict;
  $('#duration-bpm-note').textContent = conflict
    ? `The prompt says ${promptBpms[0]} BPM; the calculation and ComfyUI use ${$('#bpm').value} BPM. You can change them in the music controls.`
    : '';
  $('#duration-note').classList.toggle('over-limit', automatic && estimate.overflow);
  $('#duration-formula').textContent = estimate.valid
    ? `${$('#bpm').value} BPM · ${estimate.meter} → ${perBar} s/bar · ${estimate.totalBars} bars → ${time(estimate.seconds)}`
    : '';
  const next = JSON.stringify(estimate.sections);
  if (!keepRows && next !== durationSignature) {
    $('#duration-sections').innerHTML = estimate.sections
      .map(
        s =>
          `<div class="duration-section"><div><strong>${escape(s.title)}</strong><small>${s.overridden ? 'Bars edited' : s.synthetic ? 'Musical space added' : s.repeated ? 'Chorus repeated' : s.lines ? s.lines + ' lines of lyrics' : 'Written instrumental section'}</small></div><input type="number" min="${s.synthetic ? 0 : 1}" max="128" step="1" value="${s.bars > 0 ? s.bars : s.synthetic ? '0' : ''}" placeholder="0" data-duration-section="${escape(s.id)}" aria-label="Battute ${escape(s.title)}"><span>${time(s.seconds)}</span></div>`
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
function syncLoraScale() {
  $('#lora-scale').disabled = !$('#lora-select').value;
  $('#lora-scale-value').textContent = Math.round(Number($('#lora-scale').value) * 100) + '%';
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
let pendingLoraId = '';
function fillInput(input) {
  pendingLoraId = input.loraId || '';
  $('#lora-scale').value = input.loraScale ?? 1;
  const typed = input.manualDuration ?? input.duration;
  const manual = typeof typed === 'number' ? typed : parseDuration(typed);
  for (const [key, value] of Object.entries(input)) {
    const el = form.elements.namedItem(key);
    if (el) el.value = value;
  }
  yue.restoreSimple(input);
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
  syncLoraScale();
  mode(!!input.instrumental);
  saveDraft();
}
try {
  const draft = JSON.parse(localStorage.getItem('sonora-draft-v1'));
  if (draft) fillInput(draft);
} catch {}
mode(instrumental);
form.addEventListener('input', e => {
  syncLoraScale();
  if (e.target.matches('[data-duration-section]')) return;
  if (e.target.id === 'lyrics') durationOverrides = {};
  updateDuration();
  saveDraft();
});
form.addEventListener('change', event => {
  if (event.target.id === 'lora-select') pendingLoraId = '';
  syncLoraScale();
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
// Rules: the browser's own checks stay off: a hidden field (ACE-Step options while YuE2 is chosen) would block the button silently;
// the server checks every field and its message is shown under the button.
form.noValidate = true;
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  $('#form-error').hidden = true;
  $('#generate').disabled = true;
  $('#generate').children[1].textContent = yue.active()
    ? 'Sending to YuE2…'
    : state.health.backend === 'runpod'
      ? 'Sending to RunPod…'
      : state.health.backend === 'vast'
        ? 'Sending through Vast.ai…'
        : 'Sending to ComfyUI…';
  try {
    const yueProblem = yue.problem();
    if (yueProblem) throw new Error(yueProblem);
    let input = getInput();
    if (!yue.active() && input.autoMeta.length) {
      $('#generate').children[1].textContent = 'Choosing tempo and key…';
      if (Object.keys(await create.resolveAuto(input)).length) input = getInput();
    }
    const result = await api('/api/generate', 'POST', input);
    const failed = result.jobs.filter(j => j.status === 'failed');
    if (failed.length === result.jobs.length) throw new Error(failed[0].error);
    toast(
      result.jobs.length > 1
        ? `${result.jobs.length} variants added to the queue.`
        : 'Your song is in the queue.'
    );
    saveDraft();
    $('#prompt-studio').dispatchEvent(new Event('sonora:song-created'));
  } catch (e) {
    $('#form-error').textContent = e.message;
    $('#form-error').hidden = false;
  } finally {
    submitting = false;
    $('#generate').disabled = !state.health.ready || durationBlocked();
    $('#generate').children[1].textContent = 'Create your song';
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
    prompt: 'Prompt and lyrics assistant',
    editor: 'Editor audio',
    lab: 'Audio Lab',
    mixer: 'Instrument mixer',
    trainer: 'Trainer LoRA',
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
/** Archive, thumbs down, heart and delete, right on the library row (no need to open the details). */
function quickActions(j) {
  const t = escape(j.title);
  const button = (name, label, extra = '') =>
    `<button class="icon-button ${extra}" data-action="${name}" data-id="${j.id}" aria-label="${label} ${t}" title="${label}">${icon(name === 'archive' || name === 'dislike' || name === 'trash' ? name : 'heart')}</button>`;
  return [
    button('archive', j.archived ? 'Restore' : 'Archive', j.archived && !j.disliked ? 'active' : ''),
    button(
      'dislike',
      j.disliked ? 'I like it again: put it back in the library' : 'I do not like it: hide it',
      j.disliked ? 'active' : ''
    ),
    button('favorite', j.favorite ? 'Remove from favorites' : 'Add to favorites', j.favorite ? 'active' : ''),
    button('trash', 'Delete forever', 'danger'),
  ].join('');
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
  renderQuickTest();
  renderYue2Models();
  editor.render(state);
  lab.render(state);
  mixer.render(state);
  trainer.render(state);
  if (pendingLoraId && [...$('#lora-select').options].some(option => option.value === pendingLoraId)) {
    $('#lora-select').value = pendingLoraId;
    pendingLoraId = '';
    saveDraft();
  }
  const h = state.health;
  const yue2 = h.musicModel === 'yue2';
  $('#music-model').value = yue2 ? 'yue2' : 'ace-step';
  $('#engine-model').textContent = yue2 ? 'YuE2-3B' : 'ACE-Step 1.5 XL Turbo';
  $('#music-model-note').textContent = yue2
    ? 'YuE2 · on your PC (yue2.cpp) or on RunPod. It first writes the melody and chords, which you can change, then sings the lyrics. On the PC you can use YuE2 LoRAs. No remix or reference audio.'
    : 'ACE-Step · uses ComfyUI on this PC, RunPod or Vast.ai, and the LoRAs trained with this model.';
  $('#lora-select').disabled = yue2;
  if (yue2) $('#lora-select').value = '';
  syncLoraScale();
  $('#quality').disabled = yue2;
  const session = state.gpuSession || { active: false, phase: 'off' };
  $('#gpu-session').hidden = h.backend !== 'runpod' && !session.active;
  $('#gpu-session-toggle').textContent = session.active ? 'End GPU session' : 'Start GPU session · 30 min';
  $('#gpu-session-status').textContent =
    session.error ||
    (session.active
      ? `Session active · expires ${new Date(session.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. It uses credit even between songs.${session.phase === 'stopping' ? ' Shutting down…' : ' The first start can take a few minutes.'}`
      : 'Keeps a GPU on for 30 minutes. It uses credit even between songs.');
  $('#engine-location').textContent = yue2
    ? 'YuE2 · PC or RunPod'
    : h.backend === 'runpod'
      ? 'RunPod GPU'
      : h.backend === 'vast'
        ? 'Vast.ai GPU'
        : 'your computer';
  if (h.backend && h.backend !== 'yue2') $('#generation-backend').value = h.backend;
  $('#generation-note').textContent = yue2
    ? 'YuE2 follows this choice: the local option creates the song on this PC, RunPod on RunPod.'
    : h.backend === 'runpod'
      ? 'Generation uses your RunPod account and credits.'
      : h.backend === 'vast'
        ? 'Connected to your existing Vast.ai instance.'
        : 'Generation runs on your computer with ComfyUI.';
  $('#connection').classList.toggle('offline', !h.ready);
  $('#connection span').textContent = h.ready
    ? yue2
      ? 'YuE2 available'
      : h.backend === 'runpod'
        ? 'RunPod ready'
        : h.backend === 'vast'
          ? 'Vast.ai connected'
          : 'Engine connected'
    : h.online
      ? 'Check installed models'
      : 'Engine offline';
  $('#connection').title = h.message || 'Connecting to ComfyUI';
  $('#offline-banner').hidden = !!h.ready;
  $('#offline-message').textContent = h.message || 'Connecting to the engine…';
  $('#generate').disabled = submitting || !h.ready || durationBlocked();
  yue.render();
  renderWorkspaces();
  create.refresh();
  $('#finish').querySelector('[value="final"]').disabled = !h.sftAvailable && h.backend === 'runpod';
  $('#finish-note').textContent = h.sftAvailable
    ? 'Turbo to try things out, Final for the version to keep. Final uses 50 steps instead of 8: it takes much longer.'
    : 'The Final model (SFT) is not installed on RunPod yet: for now only Fast is available.';
  $('#nav-count').textContent = state.jobs.filter(
    j => j.status === 'done' && !j.archived && inWorkspace(j)
  ).length;
  const active = state.jobs.filter(j => !terminal(j));
  $('#activity').hidden = !active.length;
  if (active.length) {
    const j = active.find(j => j.status === 'running') || active[0];
    $('#activity').innerHTML =
      `<span class="spinner"></span><div>${escape(j.title)}<span class="sub">${escape(j.phase)}${j.progress ? ` · ${j.progress.value}/${j.progress.max} steps` : ''}</span></div><span>${active.length} in progress</span>`;
  }
  const jobs = visibleJobs();
  $('#track-count').textContent = jobs.length;
  const sig = JSON.stringify([
    view,
    filter,
    workspace,
    jobs.map(j => [
      j.id,
      j.title,
      j.favorite,
      j.archived,
      j.disliked,
      j.status,
      j.phase,
      j.progress,
      j.error,
    ]),
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
        return `<article class="track ${playing ? 'playing' : ''}" data-job="${j.id}"><div class="cover ${done ? '' : terminal(j) ? 'failed' : 'pending'}" style="--hue:${hue(j.id)}"><button class="cover-play" data-action="${done ? 'play' : 'details'}" data-id="${j.id}" aria-label="${done ? (playing ? 'Pause' : 'Play') : 'Details'} ${escape(j.title)}">${done ? icon(playing ? 'pause' : 'play') : terminal(j) ? icon(j.status === 'cancelled' ? 'close' : 'help') : '<span class="spinner"></span>'}</button></div><div class="track-copy" data-action="details" data-id="${j.id}" role="button" tabindex="0" aria-label="Details ${escape(j.title)}"><div class="track-title"><strong>${escape(j.title)}</strong>${j.input.variants === 2 ? `<span class="variant">v${j.variant}</span>` : ''}</div><div class="track-tags ${done ? '' : 'status-line'} ${j.status === 'failed' ? 'failed' : ''}">${done ? escape(j.input.tags) : escape(j.phase) + (j.progress ? ` · ${j.progress.value}/${j.progress.max}` : '')}</div><div class="track-meta">${j.kind === 'master' ? '<span class="track-badge">Master</span>' : ''}${j.disliked ? '<span class="track-badge">Disliked</span>' : ''}${j.input.cover ? '<span class="track-badge">Cover</span>' : ''}${j.kind === 'rerender' ? '<span class="track-badge">New take</span>' : ''}<span>${j.input.instrumental ? 'Instrumental' : 'With vocals'}</span><span>${j.kind === 'stem-import' ? 'Tempo not detected' : `${j.input.bpm} BPM`}</span><span>${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(j.createdAt))}</span></div>${!done && j.progress ? `<div class="track-progress"><i style="width:${pct}%"></i></div>` : ''}</div><span class="track-duration">${time(j.input.duration)}</span><div class="track-actions">${!terminal(j) ? `<button class="icon-button" data-action="cancel" data-id="${j.id}" aria-label="Cancel ${escape(j.title)}" title="Cancel" ${j.status === 'submitting' || j.status === 'cancelling' ? 'disabled' : ''}>${icon('close')}</button>` : quickActions(j)}<button class="icon-button" data-action="details" data-id="${j.id}" aria-label="Options ${escape(j.title)}" title="Details and download">${icon('more')}</button></div></article>`;
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
    $('#empty h3').textContent = state.jobs.length ? 'No songs here yet.' : 'Every song starts with an idea.';
    $('#empty p').innerHTML = $('#search').value
      ? 'Try another title or a description.'
      : view === 'favorites'
        ? 'Tap the heart next to a song<br>to find it here.'
        : view === 'archive'
          ? 'Archived songs will appear here.<br>You can restore them at any time.'
          : 'Describe the sound you have in mind.<br>Your first creation will be waiting here.';
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
    if (name === 'yueedit') {
      $('#detail-dialog').close();
      await yue.loadFromJob(j);
      setView('create');
    }
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
      toast('Cancellation requested for this song.');
    }
    if (name === 'reuse') {
      if (j.input.musicModel === 'yue2' && state.health.musicModel !== 'yue2') await selectMusicModel('yue2');
      fillInput({ ...j.input, durationMode: j.input.durationMode || 'manual', title: j.title, seed: -1 });
      // Rules: a YuE2 song also brings back its plan (melody and chords) and, for a cover, its original song: no GPU spent to redo them.
      if (j.input.musicModel === 'yue2') await yue.loadFromJob(j, { keepForm: true });
      $('#detail-dialog').close();
      setView('create');
      toast(
        j.input.cover
          ? 'Cover reloaded: the original song, melody and chords are already ready. The new song will use a random seed.'
          : j.yue?.abc
            ? 'Settings and plan copied. The new song will use a random seed.'
            : 'Settings copied. The new song will use a random seed.'
      );
    }
    if (name === 'archive') {
      await patchJob(id, { archived: !j.archived });
      $('#detail-dialog').close();
      toast(j.archived ? 'Song restored.' : 'Song archived. You can restore it from the Archive.');
    }
    if (name === 'rerender') {
      const steps = Number($('#rerender-steps')?.value) || 32;
      await api(`/api/jobs/${id}/rerender`, 'POST', { steps });
      $('#detail-dialog').close();
      state = await api('/api/state');
      signature = '';
      render();
      toast('New take started: same notes and same singing, new sound.');
    }
    if (name === 'dislike') {
      await patchJob(id, j.disliked ? { archived: false } : { disliked: true });
      $('#detail-dialog').close();
      toast(
        j.disliked
          ? 'Song put back in the library.'
          : 'Hidden. You will find it in the Archive, marked «I do not like it».'
      );
    }
    if (name === 'trash') {
      if (!window.confirm(`Delete «${j.title}» forever? The audio file is erased and cannot be recovered.`))
        return;
      if (currentId === id) {
        audio.pause();
        audio.removeAttribute('src');
        currentId = null;
      }
      await api('/api/jobs/' + id, 'DELETE');
      state = await api('/api/state');
      signature = '';
      render();
      $('#detail-dialog').close();
      toast('Song deleted.');
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
    `<div class="section-eyebrow">${j.kind === 'master' ? 'MASTER AUDIO LAB' : 'YOUR SESSION'} · ${j.input.instrumental ? 'INSTRUMENTAL' : 'WITH VOCALS'}</div>${j.kind === 'master' && j.master ? `<p class="field-hint">Mastered in Audio Lab: ${escape(j.master.loudness?.reached ?? '—')} LUFS, true peak ${escape(j.master.loudness?.truePeak ?? '—')} dBTP. The original stays in the library.</p>` : ''}<h2>${escape(j.title)}</h2><div class="detail-tags">${escape(j.input.tags)}</div><div class="detail-facts"><span>${time(j.input.duration)}</span><span>${j.kind === 'stem-import' ? 'Tempo not detected' : `${j.input.bpm} BPM`}</span><span>${escape(j.input.keyscale)}</span><span>${j.input.quality === 'full' ? 'Elaborate' : 'Light'}</span><span>Seed ${j.input.seed}</span></div>${j.error ? `<p class="error">${escape(j.error)}</p>` : ''}${!j.input.instrumental && j.kind !== 'stem-import' ? `<h3>Lyrics</h3><pre>${escape(j.input.lyrics)}</pre>` : ''}<h3>Workspace</h3><div class="rename-row"><select id="move-workspace" aria-label="Song workspace">${(state.workspaces || []).map(w => `<option value="${escape(w.id)}"${w.id === (j.workspaceId || 'general') ? ' selected' : ''}>${escape(w.name)}</option>`).join('')}</select><button class="pill-button" id="move-save" type="button">Move</button></div><h3>Rename</h3><form id="rename-form" class="rename-row"><input aria-label="Song title" name="title" value="${escape(j.title)}" maxlength="100" required><button class="pill-button" type="submit">Save</button></form><div class="detail-actions">${j.status === 'done' ? `<button class="pill-button" data-action="editor" data-id="${j.id}">${icon('sliders')}Open in audio editor</button><button class="pill-button" data-action="lab" data-id="${j.id}">${icon('wave')}Open in Audio Lab</button>` : ''}${j.status === 'done' ? `<a class="pill-button" href="${mediaUrl(j.id, 'mp3', true)}">${icon('download')}MP3</a><a class="pill-button" href="${mediaUrl(j.id, 'wav', true)}">${icon('download')}WAV</a>` : ''}${j.status === 'done' && j.kind !== 'vocal-cover' ? `<button class="pill-button" data-action="rework" data-id="${j.id}">${icon('reuse')}Rework…</button>` : ''}${j.kind !== 'upload' && j.kind !== 'master' && j.kind !== 'stem-import' && j.input.tags ? `<button class="pill-button" data-action="saveprompt" data-id="${j.id}">★ Save this prompt</button>` : ''}${j.status === 'done' ? `<button class="pill-button" data-action="mixer" data-id="${j.id}">${icon('sliders')}Open in mixer${state.stems?.sessions?.some(x => x.id === j.id && x.status === 'ready') ? ' ✓ already separated' : ''}</button>` : ''}<button class="pill-button" data-action="reuse" data-id="${j.id}">${icon('reuse')}Reuse settings</button>${j.yue ? `<button class="pill-button" data-action="yueedit" data-id="${j.id}">${icon('reuse')}Change melody and chords</button>` : ''}${j.yue?.replay && j.status === 'done' ? `<span class="rerender-row"><select id="rerender-steps" aria-label="Sound quality"><option value="32">normal sound</option><option value="64">more polished sound (slower)</option><option value="16">fast sound (draft)</option></select><button class="pill-button" data-action="rerender" data-id="${j.id}" title="Same notes, same singing and same structure: only the sound changes. It does not recompose.">${icon('spark')}New take</button></span>` : ''}${terminal(j) ? `<button class="pill-button" data-action="archive" data-id="${j.id}">${icon('archive')}${j.archived ? 'Restore' : 'Archive'}</button><button class="pill-button danger" data-action="trash" data-id="${j.id}">${icon('trash')}Delete</button>` : ''}</div>${j.kind === 'master' || j.kind === 'stem-import' ? '' : `<p class="field-hint" style="margin-top:20px"><a href="/api/jobs/${j.id}/workflow">Download the ComfyUI workflow (API format)</a></p>`}`;
  if (j.yue?.replay && j.status === 'done') {
    const duration = Math.max(2, Number(j.input.duration) || 2);
    const initialEnd = Math.min(duration, 15);
    $('#detail-content').insertAdjacentHTML(
      'beforeend',
      `<details class="extend-panel"><summary>Continue from here</summary><p>Choose on the waveform the part that should open the new song. YuE2 recreates it and composes the continuation; the original stays untouched.</p><audio controls preload="none" src="${mediaUrl(j.id)}"></audio><canvas id="extend-wave" aria-label="Waveform: tap to move the start or end of the part"></canvas><form id="extend-form"><label>Da <output id="extend-from-label">0:00</output><input id="extend-from" type="range" min="0" max="${duration}" step="0.1" value="0"></label><label>A <output id="extend-to-label">${time(initialEnd)}</output><input id="extend-to" type="range" min="0" max="${duration}" step="0.1" value="${initialEnd}"></label><label>Seconds to add<input id="extend-seconds" type="number" min="10" max="300" value="30" required></label><button class="pill-button">Create continuation</button></form><p id="extend-error" class="error" role="alert" hidden></p></details>`
    );
    const panel = $('#detail-content .extend-panel');
    const fromInput = $('#extend-from'),
      toInput = $('#extend-to'),
      canvas = $('#extend-wave');
    let wavePeaks = null;
    const draw = () => {
      if (!panel.open) return;
      const from = Number(fromInput.value),
        to = Number(toInput.value);
      $('#extend-from-label').textContent = time(from);
      $('#extend-to-label').textContent = time(to);
      const width = canvas.getBoundingClientRect().width,
        height = 72,
        dpr = window.devicePixelRatio || 1;
      if (!width) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#252827';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#654b40';
      ctx.fillRect((width * from) / duration, 0, (width * Math.max(0, to - from)) / duration, height);
      ctx.fillStyle = '#efb18c';
      (wavePeaks || Array(120).fill(0.03)).forEach((peak, i) => {
        const bar = Math.max(2, peak * (height - 10));
        ctx.fillRect((i * width) / 120, (height - bar) / 2, Math.max(1, width / 120 - 1), bar);
      });
      ctx.fillStyle = '#fff';
      for (const point of [from, to]) ctx.fillRect((width * point) / duration - 1, 0, 2, height);
    };
    panel.addEventListener('toggle', async () => {
      if (!panel.open) return;
      draw();
      if (wavePeaks) return;
      let context;
      try {
        const bytes = await fetch(mediaUrl(j.id)).then(r => r.arrayBuffer());
        context = new AudioContext();
        const buffer = await context.decodeAudioData(bytes);
        const samples = buffer.getChannelData(0),
          step = Math.max(1, Math.floor(samples.length / 120));
        wavePeaks = Array.from({ length: 120 }, (_, i) => {
          let peak = 0;
          for (let k = i * step; k < Math.min((i + 1) * step, samples.length); k += 16)
            peak = Math.max(peak, Math.abs(samples[k]));
          return peak;
        });
        draw();
      } catch {
        /* the range controls remain usable when the waveform cannot be decoded */
      } finally {
        context?.close();
      }
    });
    for (const input of [fromInput, toInput]) input.addEventListener('input', draw);
    canvas.addEventListener('click', event => {
      const at =
        Math.round(
          Math.max(
            0,
            Math.min(
              1,
              (event.clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width
            )
          ) *
            duration *
            10
        ) / 10;
      const target =
        Math.abs(at - Number(fromInput.value)) <= Math.abs(at - Number(toInput.value)) ? fromInput : toInput;
      target.value = String(at);
      draw();
    });
    $('#extend-form').addEventListener('submit', async event => {
      event.preventDefault();
      const from = Number(fromInput.value),
        to = Number(toInput.value),
        seconds = Number($('#extend-seconds').value);
      const error = $('#extend-error');
      if (to - from < 2 || to - from + seconds > 360) {
        error.textContent =
          'Choose at least 2 seconds of the song; with the continuation do not exceed 6 minutes.';
        error.hidden = false;
        return;
      }
      const button = event.target.querySelector('button');
      button.disabled = true;
      try {
        await api(`/api/jobs/${j.id}/extend`, 'POST', { from, to, seconds });
        $('#detail-dialog').close();
        state = await api('/api/state');
        signature = '';
        render();
        toast('Continuation started. The original stays in the library.');
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  }
  $('#move-save').addEventListener('click', async () => {
    try {
      await patchJob(j.id, { workspaceId: $('#move-workspace').value });
      $('#detail-dialog').close();
      toast('Song moved.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#rename-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await patchJob(j.id, { title: e.target.elements.title.value });
      $('#detail-dialog').close();
      toast('Title updated.');
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
  $('#player-favorite').setAttribute('aria-label', j.favorite ? 'Remove from favorites' : 'Add to favorites');
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
audio.addEventListener('error', () => toast('This audio file cannot be played.'));
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
    message: 'Connection to Sonora lost. Reconnecting automatically…',
  };
  render();
};
/** Fresh composer and assistant: markup defaults everywhere, no draft carried over from the previous song. */
function newSong(confirmed = false) {
  const filled = $('#tags').value.trim() || $('#lyrics').value.trim();
  if (
    !confirmed &&
    filled &&
    !confirm('Start from scratch? This clears the current style, lyrics and settings.')
  )
    return;
  form.reset();
  pendingLoraId = '';
  syncLoraScale();
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
  toast('New song: everything starts from scratch.');
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
    toast('Prompt and controls transferred. Press Create your song when you are ready.');
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
function renderQuickTest() {
  const test = state.quickTest || { status: 'idle' };
  $('#quick-test-run').disabled = test.status === 'running';
  providerStatus('quick-test-status', test.status === 'idle' ? '' : test.message, test.status === 'failed');
}
$('#quick-test-run').addEventListener('click', async () => {
  providerStatus('quick-test-status', 'Starting the test…');
  try {
    const result = await api('/api/provider-test', 'POST', {});
    state = { ...state, quickTest: result.quickTest };
    renderQuickTest();
  } catch (e) {
    providerStatus('quick-test-status', e.message, true);
  }
});
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
  const progress =
    active && total
      ? `<progress max="100" value="${percent}" aria-label="ACE-Step model download progress"></progress><small>${percent}% · ${modelSize(currentBytes)} / ${modelSize(total)}${setup.activeFile ? ` · ${escape(setup.activeFile)}` : ''}</small>`
      : '';
  const warning = setup.warning ? `<small class="error">${escape(setup.warning)}</small>` : '';
  status.innerHTML = `${escape(setup.message || 'Choose a ComfyUI folder, save it, then check its models.')}${progress}${warning}`;
  status.classList.toggle('error', setup.status === 'error');
  $('#local-model-check').disabled = active;
  $('#local-model-download').disabled = active || !setup.files?.some(file => file.status === 'missing');
  $('#local-model-cancel').hidden = !active;
  $('#local-model-files').innerHTML = (setup.files || [])
    .map(
      file =>
        `<div class="model-file"><span>${escape(file.category)}/${escape(file.name)}</span><strong class="${file.status === 'present' ? 'model-present' : 'model-missing'}">${file.status === 'present' ? 'Installed' : 'Missing'} · ${modelSize(file.bytes)}</strong></div>`
    )
    .join('');
}
async function refreshProviderSettings() {
  const config = await api('/api/config');
  $('#music-model option[value="yue2"]').disabled = !config.yue2Configured;
  yue.setConfig(config);
  $('#music-model').value = config.musicModel || 'ace-step';
  const providers = config.providers || {};
  const yueCpp = providers.yue2?.cpp || {};
  $('#yue2-engine').value = yueCpp.engine || '';
  $('#yue2-model').value = yueCpp.model || '';
  $('#yue2-vae').value = yueCpp.vae || '';
  $('#yue2-transcriber').value = yueCpp.transcriber || '';
  $('#yue2-adapters').value = yueCpp.adapters || '';
  $('#yue2-remote').checked = yueCpp.remote === true;
  $('#yue2-port').value = yueCpp.port || 18087;
  syncYue2Remote();
  $('#yue2-endpoint').value = providers.yue2?.endpointId || '';
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
  loadSetup();
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
      warning: plan.warning,
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
      state.modelSetup = {
        ...state.modelSetup,
        ...plan,
        status: 'ready',
        message: 'All four ACE-Step model files are present.',
      };
      renderLocalModelSetup();
      return;
    }
    const confirmed = window.confirm(
      `Download ${missing.length} missing ACE-Step model file(s) (${modelSize(size)}) to the selected ComfyUI models folders?\n\nThis may take a while and needs at least 22 GB of free disk space for a full setup. Sonora downloads only the model weights; it will not change ComfyUI, custom nodes, or settings.`
    );
    if (!confirmed) return;
    await api('/api/models/download', 'POST', { confirmed: true });
    state.modelSetup = {
      ...state.modelSetup,
      ...plan,
      status: 'downloading',
      message: 'Download starting…',
      completedBytes: 0,
    };
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
    providerStatus(
      'runpod-provider-status',
      'RunPod endpoint verified. The API key is encrypted on this computer.'
    );
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
    providerStatus(
      'vast-provider-status',
      `Key verified. Found ${instances.length} instance(s) in your account.`
    );
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
function renderSetup(items) {
  $('#setup-list').innerHTML = items
    .map(item => {
      const mark = item.status === 'ok' ? '✓' : item.status === 'warn' ? '!' : '✗';
      return `<div class="setup-item ${item.status}"><b>${mark}</b><span><strong>${escape(item.label)}</strong> · ${escape(item.detail || '')}${item.hint ? `<small>${escape(item.hint)}</small>` : ''}</span></div>`;
    })
    .join('');
}
async function loadSetup(fresh = false) {
  const list = $('#setup-list');
  list.textContent = 'Checking this computer…';
  try {
    renderSetup((await api('/api/setup' + (fresh ? '?fresh=1' : ''))).items);
  } catch (e) {
    list.textContent = e.message;
  }
}
$('#setup-refresh').addEventListener('click', () => loadSetup(true));
$('#setup-open').addEventListener('click', async () => {
  $('#provider-dialog').showModal();
  loadSetup();
  refreshProviderSettings().catch(e => toast(e.message));
});
function renderYue2Models() {
  const setup = state.yue2Models || {};
  const status = $('#yue2-models-status');
  if (!status) return;
  const active = setup.status === 'downloading';
  const total = setup.totalBytes || 0;
  const done = Math.min(total, (setup.completedBytes || 0) + (setup.fileBytes || 0));
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const progress =
    active && total
      ? `<progress max="100" value="${percent}" aria-label="YuE2 model download progress"></progress><small>${percent}% · ${modelSize(done)} / ${modelSize(total)}${setup.activeFile ? ` · ${escape(setup.activeFile)}` : ''}</small>`
      : '';
  status.innerHTML = `${escape(setup.message || 'Choose a folder for the YuE2 model files, then check it.')}${progress}`;
  status.classList.toggle('error', setup.status === 'error');
  $('#yue2-models-check').disabled = active;
  $('#yue2-models-download').disabled = active || !setup.files?.some(file => file.status === 'missing');
  $('#yue2-models-cancel').hidden = !active;
  $('#yue2-models-files').innerHTML = (setup.files || [])
    .map(
      file =>
        `<div class="model-file"><span>${escape(file.name)}</span><strong class="${file.status === 'present' ? 'model-present' : 'model-missing'}">${file.status === 'present' ? 'Installed' : modelSize(file.bytes)}</strong></div>`
    )
    .join('');
  // once the files are there, fill in the paths for the engine settings below
  if (setup.status === 'ready' && setup.files) {
    for (const file of setup.files) {
      const field = { model: '#yue2-model', vae: '#yue2-vae', transcriber: '#yue2-transcriber' }[
        file.setting
      ];
      if (field && !$(field).value) $(field).value = file.path;
    }
  }
}
$('#yue2-models-check').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const plan = await api('/api/yue2/models/plan', 'POST', {
      dir: $('#yue2-models-dir').value.trim(),
      covers: $('#yue2-models-covers').checked,
    });
    state.yue2Models = {
      ...state.yue2Models,
      ...plan,
      status: plan.files.some(file => file.status === 'missing') ? 'checked' : 'ready',
    };
    renderYue2Models();
  } catch (e) {
    state.yue2Models = { ...state.yue2Models, status: 'error', message: e.message };
    renderYue2Models();
  } finally {
    button.disabled = false;
  }
});
$('#yue2-models-download').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const dir = $('#yue2-models-dir').value.trim();
    const covers = $('#yue2-models-covers').checked;
    const plan = await api('/api/yue2/models/plan', 'POST', { dir, covers });
    const missing = plan.files.filter(file => file.status === 'missing');
    if (!missing.length) return;
    if (
      !window.confirm(
        `Download ${missing.length} YuE2 model file(s) (${modelSize(plan.totalBytes)}) from Hugging Face into ${plan.dir}?\n\nThis may take a while.`
      )
    )
      return;
    await api('/api/yue2/models/download', 'POST', { dir, covers, confirmed: true });
    state.yue2Models = {
      ...state.yue2Models,
      ...plan,
      status: 'downloading',
      message: 'Download starting…',
      completedBytes: 0,
    };
    renderYue2Models();
  } catch (e) {
    state.yue2Models = { ...state.yue2Models, status: 'error', message: e.message };
    renderYue2Models();
  } finally {
    button.disabled = false;
  }
});
$('#yue2-models-cancel').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try {
    await api('/api/yue2/models/cancel', 'POST', {});
  } catch (e) {
    toast(e.message);
  } finally {
    event.currentTarget.disabled = false;
  }
});
refreshProviderSettings().catch(e => toast(e.message));
$('#music-model').addEventListener('change', async event => {
  const select = event.target;
  select.disabled = true;
  try {
    state.health = await api('/api/generation/model', 'POST', { musicModel: select.value });
    render();
  } catch (e) {
    toast(e.message);
    render();
  } finally {
    select.disabled = false;
  }
});
function syncYue2Remote() {
  const remote = $('#yue2-remote').checked;
  $('#yue2-remote-fields').hidden = !remote;
  $('#yue2-local-fields').hidden = remote;
}
$('#yue2-remote').addEventListener('change', syncYue2Remote);
$('#yue2-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  providerStatus('yue2-provider-status', 'Checking the files…');
  try {
    const result = await api('/api/settings/yue2-cpp', 'POST', {
      remote: $('#yue2-remote').checked,
      port: $('#yue2-port').value,
      engine: $('#yue2-engine').value.trim(),
      model: $('#yue2-model').value.trim(),
      vae: $('#yue2-vae').value.trim(),
      transcriber: $('#yue2-transcriber').value.trim(),
      adapters: $('#yue2-adapters').value.trim(),
    });
    providerStatus('yue2-provider-status', result.message);
  } catch (e) {
    providerStatus('yue2-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#yue2-endpoint-save').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('/api/settings/yue2-endpoint', 'POST', {
      endpointId: $('#yue2-endpoint').value.trim(),
    });
    providerStatus('yue2-provider-status', result.message);
    await refreshProviderSettings();
  } catch (e) {
    providerStatus('yue2-provider-status', e.message, true);
  } finally {
    button.disabled = false;
  }
});
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
        ? 'Session started: the GPU can take a while to start.'
        : 'Session ended: songs in progress continue, then the GPU goes back to automatic shutdown.'
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
  const name = prompt('Name of the new workspace:');
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
  const name = prompt('New name of the workspace:', current?.name || '');
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
  if (!confirm(`Delete «${current?.name}»? Songs are not deleted: they move to General.`)) return;
  try {
    await api('/api/workspaces/' + workspace, 'DELETE');
    state = await api('/api/state');
    chooseWorkspace('general');
  } catch (e) {
    toast(e.message);
  }
});
