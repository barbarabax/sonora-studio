// @codedna
// description: "Create music" extras: Custom/Remix/Edit tabs, Auto rows, Creative-Robust slider, reference audio, dice and saved prompts.
//
// 
//
// 
//
// 
//
// exports: sliderToValues | valuesToSlider | parseClock | initCreateUi
// used_by: sonora-studio/public/app.js
// rules:   The dice only FILLS fields, it never starts a generation. Auto rows are resolved before the request leaves the browser, so the user sees the real tempo/key/meter the song will use. No inline style attributes (CSP): use CSSOM or classes.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-10 | s_20261010_crea | Created for the ACEMusic-style reorganisation of the create page.
import { randomPromptState, buildPrompt, effectiveBpm } from './prompt-core.mjs';
import { sectionOrder } from './prompt-adapter.mjs';
import { guessMeta } from './auto-meta.mjs';
import { formatDuration } from './song-duration.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const AUTO_FIELDS = ['bpm', 'timesignature', 'keyscale'];
const LANGUAGE_NAMES = {
  it: 'Italian',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  unknown: 'Italian',
};
const lerp = (a, b, t) => a + (b - a) * t;
/** Slider 0-100 → { guidance, creativity }: 0 = creative (1 / 1.2), 50 = the old defaults (2 / 0.85), 100 = robust (4 / 0.6). */
export function sliderToValues(v) {
  const t = Math.min(1, Math.max(0, v / 100));
  const [g, c] =
    t <= 0.5
      ? [lerp(1, 2, t / 0.5), lerp(1.2, 0.85, t / 0.5)]
      : [lerp(2, 4, (t - 0.5) / 0.5), lerp(0.85, 0.6, (t - 0.5) / 0.5)];
  return { guidance: Math.round(g * 2) / 2, creativity: Math.round(c * 20) / 20 };
}
/** Guidance → slider position (the creativity follows the guidance on the slider). */
export function valuesToSlider(guidance) {
  const g = Math.min(4, Math.max(1, Number(guidance) || 2));
  return Math.round(g <= 2 ? (g - 1) * 50 : 50 + ((g - 2) / 2) * 50);
}
/** m:ss or seconds → seconds (0 allowed), null when invalid. */
export function parseClock(value) {
  const text = String(value ?? '').trim();
  const clock = /^(\d{1,3}):([0-5]?\d)$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  return /^\d{1,4}$/.test(text) ? Number(text) : null;
}
const escapeHtml = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

export function initCreateUi({
  api,
  toast,
  state,
  workspace,
  getInput,
  applyInput,
  setFields,
  changed,
  afterRework,
}) {
  const form = $('#create-form');
  /* ---------- tabs ---------- */
  let tab = 'custom';
  function selectTab(name, quiet = false) {
    tab = ['custom', 'remix', 'edit'].includes(name) ? name : 'custom';
    $$('[data-create-tab]').forEach(b => {
      const on = b.dataset.createTab === tab;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('#create-form').hidden = tab !== 'custom';
    $('#rw-form').hidden = tab === 'custom';
    if (tab !== 'custom') applyReworkMode();
    if (!quiet)
      try {
        localStorage.setItem('sonora-create-tab', tab);
      } catch {}
  }
  $$('[data-create-tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.createTab)));

  /* ---------- Auto rows ---------- */
  const autoBox = name => $(`#auto-${name}`);
  const autoList = () => AUTO_FIELDS.filter(name => autoBox(name).checked);
  function paintAuto() {
    for (const name of AUTO_FIELDS)
      $(`#${name}`).closest('.opt-row').classList.toggle('is-auto', autoBox(name).checked);
  }
  function applyAuto(list) {
    for (const name of AUTO_FIELDS) autoBox(name).checked = list.includes(name);
    paintAuto();
  }
  for (const name of AUTO_FIELDS) {
    autoBox(name).addEventListener('change', () => {
      paintAuto();
      changed();
    });
    // Touching the value itself means "I choose": Auto goes off.
    $(`#${name}`).addEventListener('input', () => {
      if (autoBox(name).checked) {
        autoBox(name).checked = false;
        paintAuto();
      }
    });
  }
  /** Fill the Auto rows that are on: the AI (or a local guess) reads style and lyrics. Returns the patch applied. */
  async function resolveAuto(input) {
    const fields = autoList();
    if (!fields.length) return {};
    let result;
    try {
      result = await api('/api/prompt/meta', 'POST', {
        tags: input.tags,
        lyrics: input.instrumental ? '' : input.lyrics,
        fields,
      });
    } catch {
      result = { ...guessMeta(input.tags, input.lyrics), by: 'local' };
    }
    const patch = Object.fromEntries(fields.filter(f => result[f] !== undefined).map(f => [f, result[f]]));
    if (Object.keys(patch).length) {
      setFields(patch);
      toast(
        `Auto ${result.by === 'ai' ? '(selected by AI)' : '(estimated from style)'}: ${patch.bpm ?? input.bpm} BPM · ${patch.keyscale ?? input.keyscale} · ${(patch.timesignature ?? input.timesignature) === '6' ? '6/8' : (patch.timesignature ?? input.timesignature) + '/4'}`
      );
    }
    return patch;
  }

  /* ---------- Creative ↔ Robusto ---------- */
  const slider = $('#style-slider');
  function paintSlider() {
    const g = Number($('#guidance').value),
      c = Number($('#creativity').value);
    $('#style-values').textContent =
      `Guidance ${g.toLocaleString('en-GB')} · variety ${c.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
  }
  slider.addEventListener('input', () => {
    const v = sliderToValues(Number(slider.value));
    $('#guidance').value = v.guidance;
    $('#creativity').value = v.creativity;
    paintSlider();
    changed();
  });
  function syncSlider() {
    slider.value = valuesToSlider($('#guidance').value);
    paintSlider();
  }
  for (const id of ['guidance', 'creativity']) $('#' + id).addEventListener('input', syncSlider);

  /* ---------- finish / negative styles / reference ---------- */
  let reference = { id: '', name: '' };
  function paintReference() {
    $('#ref-id').value = reference.id;
    $('#ref-name').textContent = reference.id ? reference.name || 'Uploaded audio' : 'None';
    $('#ref-clear').hidden = !reference.id;
  }
  $('#ref-clear').addEventListener('click', () => {
    reference = { id: '', name: '' };
    paintReference();
    changed();
  });
  $('#ref-file').addEventListener('change', async () => {
    const file = $('#ref-file').files[0];
    $('#ref-file').value = '';
    if (!file) return;
    if (state().health?.backend !== 'runpod') {
      toast('Reference audio requires RunPod. Select RunPod in the Generation provider menu.');
      return;
    }
    const start = parseClock($('#ref-start').value) ?? 0;
    $('#ref-name').textContent = 'Uploading…';
    try {
      const r = await fetch('/api/reference', {
        method: 'POST',
        headers: {
          'X-Sonora': '1',
          'Content-Type': 'application/octet-stream',
          'X-Audio-Name': encodeURIComponent(file.name),
          'X-Audio-Start': String(start),
          'X-Audio-Length': '30',
        },
        body: file,
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Upload failed.');
      reference = { id: body.id, name: `${file.name.replace(/\.[a-z0-9]{2,5}$/i, '')} · ${body.seconds} s` };
      toast('Reference ready. Full planning stays off while a reference is selected.');
    } catch (e) {
      toast(e.message);
    }
    paintReference();
    changed();
  });
  function paintFinish() {
    const final = $('#finish').value === 'final';
    $('#avoid-state').textContent = final ? 'On with Final' : 'Final only';
    $('#avoid').closest('.opt-row').classList.toggle('is-off', !final);
  }
  $('#finish').addEventListener('change', paintFinish);

  /* ---------- Reset all to Auto ---------- */
  $('#adv-reset').addEventListener('click', () => {
    applyAuto(AUTO_FIELDS);
    $('#duration-mode').value = 'auto';
    $('#avoid').value = '';
    reference = { id: '', name: '' };
    paintReference();
    slider.value = 50;
    slider.dispatchEvent(new Event('input'));
    changed();
  });

  /* ---------- the dice ---------- */
  let rolling = false;
  $('#dice').addEventListener('click', async () => {
    if (rolling) return;
    rolling = true;
    $('#dice').disabled = true;
    $('#dice').classList.add('rolling');
    const seed = randomPromptState();
    const built = buildPrompt(seed);
    const instrumental = seed.vocal.includes('instrumental-only');
    const language = $('#language').value;
    const bpm = Number(effectiveBpm(seed));
    const key = seed.key?.[0]?.replace(/\b(Major|Minor)\b/g, s => s.toLowerCase());
    const meta = {
      ...(bpm >= 30 && bpm <= 250 ? { bpm } : {}),
      ...(key && [...$('#keyscale').options].some(o => o.value === key) ? { keyscale: key } : {}),
    };
    try {
      const idea = await api('/api/prompt/surprise', 'POST', {
        seedPrompt: built.optimized.slice(0, 2900),
        language: LANGUAGE_NAMES[language] || 'Italian',
        instrumental,
        duration: 180, // a full song: the lyrics length decides the "Auto" duration, so a short sheet means a short song
        structure: sectionOrder(seed),
      });
      applyInput({
        title: idea.title,
        tags: idea.tags,
        lyrics: instrumental ? '' : idea.lyrics,
        instrumental,
        ...meta,
        durationMode: 'auto',
        durationOverrides: {},
        autoMeta: AUTO_FIELDS.filter(f => !(f in meta)),
      });
      toast('Idea ready: the style and lyrics fit together. Review them, then select Create when you are ready.');
    } catch (e) {
      applyInput({
        tags: built.optimized,
        instrumental,
        ...meta,
        autoMeta: AUTO_FIELDS.filter(f => !(f in meta)),
      });
      toast(
        `Only the style was filled in (${e.message}). Configure AI in Prompt and lyrics to generate lyrics too.`
      );
    } finally {
      rolling = false;
      $('#dice').disabled = false;
      $('#dice').classList.remove('rolling');
    }
  });

  /* ---------- saved prompts ---------- */
  const dialog = $('#saved-dialog');
  const savedOptions = () => {
    const i = getInput();
    return {
      language: i.language,
      vocal: i.vocal,
      instrumental: !!i.instrumental,
      bpm: Number.isInteger(i.bpm) ? i.bpm : undefined,
      keyscale: i.keyscale,
      timesignature: i.timesignature,
      finish: i.finish,
      quality: i.quality,
      guidance: i.guidance,
      creativity: i.creativity,
      avoid: i.avoid || '',
      autoMeta: autoList(),
    };
  };
  const cleanOptions = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  function savedError(message) {
    $('#saved-error').textContent = message || '';
    $('#saved-error').hidden = !message;
  }
  function renderSaved() {
    const list = state().prompts || [];
    const labels = [...new Set(list.map(p => p.label).filter(Boolean))].sort();
    const filter = $('#saved-filter');
    const keep = filter.value;
    filter.innerHTML =
      '<option value="">All labels</option>' +
      labels.map(l => `<option>${escapeHtml(l)}</option>`).join('');
    filter.value = labels.includes(keep) ? keep : '';
    $('#saved-labels').innerHTML = labels.map(l => `<option value="${escapeHtml(l)}"></option>`).join('');
    const query = $('#saved-search').value.trim().toLowerCase();
    const shown = list.filter(
      p =>
        (!filter.value || p.label === filter.value) &&
        (!query || `${p.name} ${p.tags} ${p.lyrics} ${p.label}`.toLowerCase().includes(query))
    );
    $('#saved-list').innerHTML = shown.length
      ? shown
          .map(
            p =>
              `<article class="saved-item"><div class="saved-text"><strong>${escapeHtml(p.name)}</strong>${p.label ? `<span class="saved-label">${escapeHtml(p.label)}</span>` : ''}<p>${escapeHtml(p.tags.slice(0, 140))}${p.tags.length > 140 ? '…' : ''}</p>${p.lyrics ? '<small>with lyrics</small>' : '<small>style only</small>'}</div><div class="saved-actions"><button type="button" class="pill-button" data-saved="use" data-id="${p.id}">Use</button><button type="button" class="text-button" data-saved="rename" data-id="${p.id}">Rename</button><button type="button" class="text-button" data-saved="copy" data-id="${p.id}">Duplicatete</button><button type="button" class="text-button" data-saved="delete" data-id="${p.id}">Delete</button></div></article>`
          )
          .join('')
      : `<p class="field-hint">${list.length ? 'No prompts match your search.' : 'No saved prompts yet. Write a style, then save it here.'}</p>`;
    let old = [];
    try {
      old = JSON.parse(localStorage.getItem('sonora-prompt-presets-v1')) || [];
    } catch {}
    $('#saved-migrate').hidden =
      !Array.isArray(old) || !old.length || localStorage.getItem('sonora-presets-migrated') === '1';
  }
  $('#saved-open').addEventListener('click', () => {
    savedError('');
    $('#saved-name').value = '';
    $('#saved-with-lyrics').checked = !!$('#lyrics').value.trim();
    renderSaved();
    dialog.showModal();
  });
  for (const id of ['saved-search', 'saved-filter']) $('#' + id).addEventListener('input', renderSaved);
  $('#saved-form').addEventListener('submit', async e => {
    e.preventDefault();
    savedError('');
    const name = $('#saved-name').value.trim();
    try {
      if (!$('#tags').value.trim()) throw new Error('Write the style you want to save first.');
      await api('/api/prompts', 'POST', {
        name: name || $('#title').value.trim() || $('#tags').value.trim().slice(0, 40),
        label: $('#saved-label').value,
        tags: $('#tags').value,
        lyrics: $('#saved-with-lyrics').checked ? $('#lyrics').value : '',
        options: cleanOptions(savedOptions()),
      });
      $('#saved-name').value = '';
      toast('Prompt saved.');
    } catch (err) {
      savedError(err.message);
    }
  });
  $('#saved-list').addEventListener('click', async e => {
    const button = e.target.closest('[data-saved]');
    if (!button) return;
    const item = (state().prompts || []).find(p => p.id === button.dataset.id);
    if (!item) return;
    savedError('');
    try {
      if (button.dataset.saved === 'use') {
        applyInput({
          tags: item.tags,
          ...(item.lyrics ? { lyrics: item.lyrics, durationOverrides: {} } : {}),
          ...item.options,
          ...(item.options?.autoMeta ? {} : { autoMeta: autoList() }),
        });
        await api(`/api/prompts/${item.id}`, 'PATCH', { used: true });
        dialog.close();
        selectTab('custom');
        toast(`«${item.name}» loaded. Edit it or select Create.`);
      } else if (button.dataset.saved === 'rename') {
        const name = prompt('New name:', item.name);
        if (name?.trim()) await api(`/api/prompts/${item.id}`, 'PATCH', { name });
      } else if (button.dataset.saved === 'copy') {
        await api('/api/prompts', 'POST', { ...item, name: `${item.name} (copy)`.slice(0, 70) });
      } else if (button.dataset.saved === 'delete' && confirm(`Delete «${item.name}»?`)) {
        await api(`/api/prompts/${item.id}`, 'DELETE');
      }
    } catch (err) {
      savedError(err.message);
    }
  });
  $('#saved-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state().prompts || [], null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sonora-prompt.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  async function importList(list) {
    let added = 0;
    for (let i = 0; i < list.length; i += 10) {
      const r = await api('/api/prompts', 'POST', { import: list.slice(i, i + 10) });
      added += r.added || 0;
    }
    return added;
  }
  $('#saved-import').addEventListener('change', async () => {
    const file = $('#saved-import').files[0];
    $('#saved-import').value = '';
    if (!file) return;
    try {
      const list = JSON.parse(await file.text());
      toast(`${await importList(Array.isArray(list) ? list : [])} prompts imported.`);
    } catch (err) {
      savedError(err.message.includes('JSON') ? 'Invalid file.' : err.message);
    }
  });
  $('#saved-migrate').addEventListener('click', async () => {
    try {
      const old = JSON.parse(localStorage.getItem('sonora-prompt-presets-v1')) || [];
      const list = old
        .filter(p => typeof p?.name === 'string' && p.choices)
        .map(p => {
          try {
            return {
              name: p.name,
              label: 'from assistant',
              tags: buildPrompt(p.choices).optimized,
              options: {},
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      toast(`${await importList(list)} presets imported from your browser.`);
      localStorage.setItem('sonora-presets-migrated', '1');
      renderSaved();
    } catch (err) {
      savedError(err.message);
    }
  });
  /** "Save this prompt" from a song's details. */
  async function saveFromJob(job) {
    await api('/api/prompts', 'POST', {
      name: job.title,
      tags: job.input.tags,
      lyrics: job.input.lyrics || '',
      options: cleanOptions({
        language: job.input.language,
        vocal: job.input.vocal,
        instrumental: !!job.input.instrumental,
        bpm: job.input.bpm,
        keyscale: job.input.keyscale,
        timesignature: job.input.timesignature,
        finish: job.input.finish,
        quality: job.input.quality,
        guidance: job.input.guidance,
        creativity: job.input.creativity,
        avoid: job.input.avoid || '',
      }),
    });
    toast('Prompt saved.');
  }

  /* ---------- Remix / Edit ---------- */
  let rw = { id: '', total: 0, peaks: null, token: 0, pending: null };
  const mode = () => (tab === 'edit' ? 'repaint' : 'remix');
  const selectedJob = () => state().jobs.find(j => j.id === $('#rw-source').value) || rw.pending;
  const rwSeconds = id => {
    const v = parseClock($(id).value);
    return v === null ? null : v;
  };
  function sources() {
    const list = state().jobs.filter(
      j =>
        j.status === 'done' &&
        !j.archived &&
        j.assets?.flac === `${j.id}.flac` &&
        j.kind !== 'vocal-cover' &&
        (j.workspaceId || 'general') === workspace()
    );
    if (rw.pending && !list.some(j => j.id === rw.pending.id)) list.unshift(rw.pending);
    return list;
  }
  function fillSources() {
    const select = $('#rw-source');
    const keep = select.value;
    const list = sources();
    const key = JSON.stringify([list.map(j => [j.id, j.title, j.input.duration]), keep]);
    if (select.dataset.key === key) return;
    select.dataset.key = key;
    select.innerHTML =
      '<option value="">Choose a track from your library</option>' +
      list
        .map(
          j => `<option value="${j.id}">${escapeHtml(j.title)} · ${formatDuration(j.input.duration)}</option>`
        )
        .join('');
    select.value = list.some(j => j.id === keep) ? keep : '';
  }
  function applyReworkMode() {
    const part = mode() === 'repaint';
    $('#rw-intro').textContent = part
      ? 'Change only part of the track (for example, the chorus). The rest stays the same, with crossfaded joins.'
      : 'Recreate the full track from this one: keep its structure but change the style, instruments or lyrics.';
    $('#rw-part').hidden = !part;
    $('#rw-piece').hidden = part || !rw.total;
    $('#rw-tags-label').textContent = part
      ? 'What should change in this section? (this is added to the track style)'
      : 'What should it become?';
    $('#rw-tags').placeholder = part
      ? 'e.g. stronger orchestral strings, more energetic drums'
      : 'Style for the new track';
    $('#rw-lyrics-label').firstChild.textContent = part ? 'Lyrics for this section ' : 'Lyrics ';
    $('#rw-lyrics').placeholder = part
      ? 'Lyrics for this section (add a tag such as [Chorus - strings] if you like). Leave blank for instrumental.'
      : '';
    $('#rw-voice').closest('select').previousElementSibling.hidden = part;
    $('#rw-voice').hidden = part;
    $('#rw-go-label').textContent = part ? 'Change this section' : 'Create remix';
    const j = selectedJob();
    $('#rw-strength').value = part ? 70 : 50;
    $('#rw-strength-label').textContent = $('#rw-strength').value + '%';
    if (j) loadSource(j, true);
    paintVoice();
    drawPeaks();
  }
  function paintVoice() {
    const part = mode() === 'repaint';
    const voice = $('#rw-voice').value;
    $('#rw-lyrics-box').hidden = !part && voice === 'instrumental';
  }
  $('#rw-voice').addEventListener('change', paintVoice);
  async function loadSource(job, keepText = false) {
    const token = ++rw.token;
    rw.id = job.id;
    rw.total = job.input.duration;
    rw.peaks = null;
    const upload = job.kind === 'upload';
    $('#rw-preview').hidden = false;
    $('#rw-audio').src = `/api/jobs/${job.id}/audio?format=mp3`;
    $('#rw-piece').hidden = mode() === 'repaint';
    $('#rw-from').value = '0:00';
    $('#rw-to').value = formatDuration(Math.min(rw.total, 300));
    $('#rw-end').value = formatDuration(Math.min(rw.total, 10));
    $('#rw-start').value = '0:00';
    $('#rw-piece-note').textContent =
      rw.total > 300
        ? `This track is ${formatDuration(rw.total)}: Choose a section up to 5:00.`
        : 'ACE-Step processes 10 seconds to 5 minutes at a time. You can use just part of the track.';
    $('#rw-voice').querySelector('[value="same"]').hidden = upload;
    if (!keepText) {
      $('#rw-tags').value = mode() === 'repaint' || upload ? '' : job.input.tags || '';
      $('#rw-lyrics').value = mode() === 'repaint' ? '' : job.input.lyrics || '';
      $('#rw-voice').value = upload ? (job.input.lyrics ? 'vocal' : 'instrumental') : 'same';
    } else if (upload && $('#rw-voice').value === 'same') $('#rw-voice').value = 'instrumental';
    paintVoice();
    try {
      const bytes = await fetch(`/api/jobs/${job.id}/audio?format=mp3`).then(r => r.arrayBuffer());
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes);
      context.close();
      if (token !== rw.token) return;
      const samples = buffer.getChannelData(0),
        count = 220,
        step = Math.max(1, Math.floor(samples.length / count));
      rw.peaks = Array.from({ length: count }, (_, i) => {
        let peak = 0;
        for (let k = i * step; k < Math.min((i + 1) * step, samples.length); k += 24)
          peak = Math.max(peak, Math.abs(samples[k]));
        return peak;
      });
      rw.total = buffer.duration;
    } catch {
      rw.peaks = null;
    }
    drawPeaks();
  }
  function drawPeaks() {
    const canvas = $('#rw-wave');
    if ($('#rw-preview').hidden) return;
    const rect = canvas.getBoundingClientRect(),
      dpr = window.devicePixelRatio || 1;
    if (!rect.width) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const part = mode() === 'repaint';
    const a = rwSeconds(part ? '#rw-start' : '#rw-from'),
      b = rwSeconds(part ? '#rw-end' : '#rw-to');
    const total = rw.total || 1;
    if (a !== null && b !== null && b > a) {
      ctx.fillStyle = '#edb19133';
      ctx.fillRect((a / total) * rect.width, 0, ((b - a) / total) * rect.width, rect.height);
    }
    if (!rw.peaks) return;
    const max = Math.max(...rw.peaks, 0.01),
      step = rect.width / rw.peaks.length;
    rw.peaks.forEach((p, i) => {
      const h = Math.max(2, (p / max) * (rect.height - 4));
      const t = ((i + 0.5) / rw.peaks.length) * total;
      ctx.fillStyle = a !== null && b !== null && t >= a && t <= b ? '#edb191' : '#667266';
      ctx.fillRect(i * step, (rect.height - h) / 2, Math.max(1, step - 1.2), h);
    });
  }
  for (const id of ['#rw-from', '#rw-to', '#rw-start', '#rw-end']) $(id).addEventListener('input', drawPeaks);
  window.addEventListener('resize', drawPeaks);
  $('#rw-strength').addEventListener('input', () => {
    $('#rw-strength-label').textContent = $('#rw-strength').value + '%';
  });
  $('#rw-source').addEventListener('change', () => {
    const j = selectedJob();
    $('#rw-error').hidden = true;
    if (!j) {
      rw = { ...rw, id: '', total: 0, peaks: null };
      $('#rw-preview').hidden = true;
      $('#rw-piece').hidden = true;
      return;
    }
    loadSource(j);
  });
  function reworkError(message) {
    $('#rw-error').textContent = message;
    $('#rw-error').hidden = !message;
  }
  async function uploadSong(file) {
    if (!file) return;
    reworkError('');
    if (file.size > 150 * 1024 * 1024) return reworkError('The file is larger than 150 MB.');
    $('#rw-upload-note').textContent = `Uploading “${file.name}”…`;
    try {
      const r = await fetch('/api/library/upload', {
        method: 'POST',
        headers: {
          'X-Sonora': '1',
          'Content-Type': 'application/octet-stream',
          'X-Audio-Name': encodeURIComponent(file.name),
          'X-Workspace': workspace(),
        },
        body: file,
      });
      const job = await r.json();
      if (!r.ok) throw new Error(job.error || 'Upload failed.');
      rw.pending = job;
      $('#rw-source').dataset.key = '';
      fillSources();
      $('#rw-source').value = job.id;
      await loadSource(job);
      toast('Track uploaded. It is also available in your library.');
    } catch (e) {
      reworkError(e.message);
    } finally {
      $('#rw-upload-note').textContent =
        'You can also drop a file here (WAV, MP3, FLAC, M4A or OGG · up to 150 MB). Uploaded tracks are added to your library. Only use audio you have the rights to.';
    }
  }
  $('#rw-upload').addEventListener('change', async () => {
    const file = $('#rw-upload').files[0];
    $('#rw-upload').value = '';
    await uploadSong(file);
  });
  const drop = $('#rw-form');
  drop.addEventListener('dragover', e => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      $('#rw-drop').classList.add('dragging');
    }
  });
  drop.addEventListener('dragleave', e => {
    if (e.target === drop || e.target === $('#rw-drop')) $('#rw-drop').classList.remove('dragging');
  });
  drop.addEventListener('drop', e => {
    $('#rw-drop').classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    uploadSong(file);
  });
  $('#rw-form').addEventListener('submit', async e => {
    e.preventDefault();
    reworkError('');
    const job = selectedJob();
    if (!job) return reworkError('Choose or upload a track first.');
    const part = mode() === 'repaint';
    const voice = $('#rw-voice').value;
    const body = {
      mode: mode(),
      tags: $('#rw-tags').value,
      strength: Number($('#rw-strength').value) / 100,
      finish: $('#rw-finish').value,
      avoid: $('#rw-avoid').value,
    };
    if (part) {
      body.start = rwSeconds('#rw-start');
      body.end = rwSeconds('#rw-end');
      body.lyrics = $('#rw-lyrics').value;
      if (body.start === null || body.end === null)
        return reworkError('Enter times as 1:05 or in seconds.');
    } else {
      if (voice === 'instrumental') body.instrumental = true;
      else {
        body.lyrics = $('#rw-lyrics').value;
        if (voice === 'vocal') body.instrumental = false;
      }
      const from = rwSeconds('#rw-from'),
        to = rwSeconds('#rw-to');
      if (from === null || to === null) return reworkError('Enter times as 1:05 or in seconds.');
      if (to - from < 10 || to - from > 300)
        return reworkError('The section to process must be 10 seconds to 5 minutes long.');
      if (from > 0 || to < job.input.duration - 0.5) {
        body.sourceStart = from;
        body.sourceEnd = to;
      }
    }
    $('#rw-go').disabled = true;
    try {
      await api(`/api/jobs/${job.id}/rework`, 'POST', body);
      toast('New version queued. It will appear in your library when ready.');
      afterRework();
    } catch (err) {
      reworkError(err.message);
    } finally {
      $('#rw-go').disabled = false;
    }
  });
  /** Open Remix/Edit already pointing at a song (the "Rework" shortcut in a song's details). */
  function openRework(job, which = 'remix') {
    selectTab(which, true);
    fillSources();
    $('#rw-source').value = job.id;
    if ($('#rw-source').value !== job.id) {
      rw.pending = job;
      $('#rw-source').dataset.key = '';
      fillSources();
      $('#rw-source').value = job.id;
    }
    loadSource(job);
  }

  /* ---------- hooks used by app.js ---------- */
  function refresh() {
    const h = state().health || {};
    $('#rw-finish').querySelector('[value="final"]').disabled = !h.sftAvailable;
    if (!h.sftAvailable && $('#rw-finish').value === 'final') $('#rw-finish').value = 'fast';
    fillSources();
    if (dialog.open) renderSaved();
    paintFinish();
  }
  try {
    selectTab(localStorage.getItem('sonora-create-tab') || 'custom', true);
  } catch {
    selectTab('custom', true);
  }
  paintAuto();
  syncSlider();
  paintReference();
  paintFinish();
  return {
    /** Extra fields for the generate request (the form itself covers the named inputs). */
    extraInput: () => ({ autoMeta: autoList(), referenceName: reference.name }),
    applyAuto,
    resolveAuto,
    syncSlider,
    refresh,
    selectTab,
    openRework,
    saveFromJob,
    setReference(id, name) {
      reference = { id: id || '', name: name || '' };
      paintReference();
    },
    /** A fresh song: Auto everywhere, no reference. */
    reset() {
      applyAuto(AUTO_FIELDS);
      reference = { id: '', name: '' };
      paintReference();
      syncSlider();
      paintFinish();
    },
  };
}
