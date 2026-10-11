// @codedna
// description: Integrated Suno Prompt workspace with original categories, presets, local optimizer and optional AI.
// 
//
// 
//
// 
//
// exports: initPromptStudio
// used_by: sonora-studio/public/app.js
// rules:   Escape selected content. Send AI requests only on clicks; importing never starts audio generation.
// agent:   Codex - 2026-10-04 - Sonora-native interface for the user-owned prompt tool.
import * as P from './prompt-presets.mjs';
import { createEmptyState, buildPrompt, randomPromptState, bandBpm } from './prompt-core.mjs';
import { toSonora, sectionOrder, parseStructure } from './prompt-adapter.mjs';
import { parseDuration, formatDuration } from './song-duration.mjs';
import { bindDurationField } from './duration-field.mjs';

export function initPromptStudio({ onTransfer, currentContext, notify, onNewSong }) {
  const esc = s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const groups = [
    ['genres', 'Genre', [['genres', 'Genres and subgenres', P.GENRE_HIERARCHY]]],
    ['mood', 'Mood', [['mood', 'Track character', P.MOOD_OPTIONS]]],
    [
      'vocal',
      'Voice',
      [
        ['vocal', 'Vocal type and tone', P.VOCAL_HIERARCHY],
        ['melody', 'Vocal melody', P.MELODY_OPTIONS],
      ],
    ],
    ['instruments', 'Instruments', [['instruments', 'Your sound palette', P.INSTRUMENTS_OPTIONS]]],
    [
      'tempo',
      'Tempo and key',
      [
        ['tempo', 'Tempo', P.TEMPO_OPTIONS],
        ['key', 'Key', P.KEY_OPTIONS],
        ['modes', 'Mode', P.MODES_OPTIONS],
      ],
    ],
    [
      'structure',
      'Structure',
      [
        ['structure', 'Song form', P.STRUCTURE_OPTIONS],
        ['harmony_form', 'Harmony', P.HARMONY_FORM_OPTIONS],
      ],
    ],
    [
      'production',
      'Production',
      [
        ['production', 'Recording character', P.PRODUCTION_OPTIONS],
        ['era', 'Era', P.ERA_OPTIONS],
        ['mix_master', 'Mix and mastering', P.MIX_MASTER_HIERARCHY],
      ],
    ],
    [
      'texture',
      'Rhythm and texture',
      [
        ['rhythm_groove', 'Rhythm', P.RHYTHM_OPTIONS],
        ['groove_feel', 'Groove', P.GROOVE_FEEL_OPTIONS],
        ['bass_tone', 'Bass', P.BASS_TONE_OPTIONS],
        ['ear_candy_space', 'Space and detail', P.EAR_CANDY_SPACE_OPTIONS],
      ],
    ],
    [
      'reference',
      'References',
      [
        ['reference', 'Musical references', P.REFERENCES_BY_ERA],
        ['goal', 'Destination', P.GOAL_OPTIONS],
      ],
    ],
  ];
  let choices = createEmptyState(),
    active = 'genres',
    version = 'optimized',
    outputOverride = '',
    busy = false,
    ai = { available: false },
    saved = [];
  const root = document.createElement('section');
  root.id = 'prompt-studio';
  root.className = 'prompt-studio';
  root.hidden = true;
  root.setAttribute('aria-label', 'Suno Prompt studio');
  root.innerHTML = `<div class="prompt-heading"><div><div class="section-eyebrow">SONORA × SUNO PROMPT MASTER</div><h1>Design your sound.</h1><p>Your prompt categories, ready for your next Sonora track.</p></div><div class="prompt-heading-actions"><button id="prompt-new" class="pill-button">+ New song</button><button id="prompt-random" class="pill-button">↻ Surprise me</button><button id="prompt-reset" class="pill-button subtle">Reset choices</button></div></div><div class="prompt-grid"><section class="prompt-choices"><div class="prompt-card-heading"><span>01 / CHOOSE A DIRECTION</span><span id="prompt-selection-count">0 selected</span></div><div class="prompt-category-nav" role="group" aria-label="Prompt categories">${groups.map(([id, label]) => `<button data-category="${id}" class="${id === active ? 'selected' : ''}">${label}</button>`).join('')}</div><div class="prompt-option-search"><input id="prompt-search" type="search" placeholder="Search options…" aria-label="Search music options"></div><div id="prompt-options" class="prompt-options"></div><div class="prompt-custom"><div class="form-row"><div><label for="prompt-custom-genre">Custom genre</label><input id="prompt-custom-genre" maxlength="300" placeholder="Your genre blend"></div><div><label for="prompt-bpm">Exact BPM</label><input id="prompt-bpm" type="number" min="30" max="250" placeholder="e.g. 110"></div></div><label for="prompt-details">More details</label><textarea id="prompt-details" rows="3" maxlength="1600" placeholder="A gentle crescendo, rounded bass and close vocals…"></textarea><div class="prompt-saved-row"><select id="prompt-saved" aria-label="Personal presets"><option value="">Your personal presets</option></select><button id="prompt-save" class="pill-button subtle">Save choices</button></div><div id="prompt-save-panel" hidden><label for="prompt-preset-name">Preset name</label><div class="rename-row"><input id="prompt-preset-name" maxlength="70" placeholder="e.g. Indie night"><button id="prompt-save-confirm" class="pill-button">Save</button><button id="prompt-save-cancel" class="pill-button subtle">Cancel</button></div></div></div></section><section class="prompt-results"><div class="prompt-card-heading"><span>02 / REFINE THE PROMPT</span><span id="prompt-ai-status">Checking AI…</span></div><div class="prompt-result-tabs" role="group" aria-label="Prompt version"><button data-version="optimized" class="selected">Locally optimized</button><button data-version="raw">Original</button></div><label for="prompt-output" class="sr-only">Final music prompt</label><textarea id="prompt-output" rows="7" maxlength="3000" placeholder="Choose categories to build a prompt here, then edit it as needed."></textarea><div class="prompt-output-meta"><span id="prompt-word-count">0 characters</span><button id="prompt-copy" class="text-button">Copy prompt</button></div><div id="prompt-conflicts" class="prompt-conflicts" hidden></div><div class="prompt-ai-actions"><button id="prompt-boost" class="pill-button">✧ Improve with AI</button><span id="prompt-ai-provider-hint" class="field-hint">AI · uses your account</span></div><ul id="prompt-strategy" class="prompt-strategy" hidden></ul><details class="prompt-exclude"><summary>Suno Exclude and details</summary><p class="field-hint">Exclude remains available for Suno. Sonora receives the positive prompt, BPM, key and vocal type; Suno-specific controls are not converted.</p><label for="prompt-exclude-output">Exclude</label><textarea id="prompt-exclude-output" rows="2" readonly></textarea></details><div class="prompt-lyrics-card"><div class="prompt-card-heading"><span>03 / WRITE THE LYRICS</span><span>AI LYRICS</span></div><div class="form-row"><div><label for="prompt-lyrics-mode">Action</label><select id="prompt-lyrics-mode"><option value="write">Write original lyrics</option><option value="tag-existing">Structure my lyrics</option></select></div><div><label for="prompt-lyrics-language">Language</label><select id="prompt-lyrics-language"><option value="Italian">Italian</option><option value="English">English</option><option value="French">French</option><option value="Spanish">Spanish</option><option value="German">German</option><option value="Portuguese">Portuguese</option></select></div></div><label for="prompt-concept">Song idea</label><textarea id="prompt-concept" rows="2" maxlength="2500" placeholder="A night in the city, and someone you wish you could keep there a little longer…"></textarea><div class="form-row"><div><label for="prompt-tone">Tone</label><select id="prompt-tone"><option value="intimate and concrete">Intimate</option><option value="uplifting and hopeful">Uplifting</option><option value="melancholic and reflective">Melancholic</option><option value="playful and witty">Playful</option><option value="energetic and direct">Energetic</option></select></div><div><label for="prompt-pov">Point of view</label><select id="prompt-pov"><option value="first person">First person</option><option value="second person">Addressing someone</option><option value="third person">Third person</option></select></div></div><div class="form-row"><div><label for="prompt-lyrics-duration">Target duration</label><div class="duration-field"><div class="duration-controls"><input id="prompt-lyrics-duration" type="text" inputmode="numeric" autocomplete="off" value="0:30" placeholder="m:ss"><select id="prompt-lyrics-duration-preset" aria-label="Suggested durations"><option value="" selected>⋯</option><option value="0:15">0:15 · draft</option><option value="0:30">0:30</option><option value="1:00">1:00</option><option value="1:30">1:30</option><option value="2:00">2:00</option><option value="2:30">2:30</option><option value="3:00">3:00</option><option value="3:30">3:30</option><option value="4:00">4:00</option><option value="4:30">4:30</option><option value="5:00">5:00</option></select></div></div></div><div><label for="prompt-lyrics-voice">Lyrics voice</label><select id="prompt-lyrics-voice"><option value="as described in the music prompt">From the music prompt</option><option value="male lead">Male</option><option value="female lead">Female</option><option value="male and female duet">Duet</option></select></div></div><div><label for="prompt-structure-custom">Section order (optional)</label><input id="prompt-structure-custom" maxlength="200" placeholder="Es. verse, verse, chorus, verse, bridge, chorus, chorus"></div><p id="prompt-structure-note" class="field-hint"></p><button id="prompt-write-lyrics" class="pill-button">✧ Write AI lyrics</button><p class="field-hint">Review and edit the result before importing it. Structure my lyrics adds sections while preserving your words.</p><label for="prompt-lyrics-result">Lyrics to bring into Sonora</label><textarea id="prompt-lyrics-result" rows="9" maxlength="12000" placeholder="Your lyrics or the AI result will appear here."></textarea><label class="prompt-check"><input id="prompt-transfer-lyrics" type="checkbox" checked>Import these lyrics too</label></div><p id="prompt-error" class="error" role="alert" hidden></p><div class="prompt-transfer"><button id="prompt-use" class="generate">Use in Sonora <span class="arrow">↗</span></button><p class="field-hint">Transfers these fields. Music generation starts only when you press Generate track.</p></div></section></div>`;
  const aiSettings = document.createElement('details');
  aiSettings.id = 'prompt-ai-settings';
  aiSettings.className = 'prompt-ai-settings';
  aiSettings.innerHTML =
    '<summary>Configure AI</summary><p class="field-hint">Choose an AI provider and enter your API key. It is encrypted on this computer and kept separate from browser drafts and presets. Requests use your credits with the selected provider.</p>' +
    '<div class="prompt-provider" role="radiogroup" aria-label="AI provider"><label class="prompt-check"><input type="radio" name="prompt-provider" value="openai">OpenAI <small>· text and audio analysis</small></label><label class="prompt-check"><input type="radio" name="prompt-provider" value="deepseek">DeepSeek <small>· text only</small></label></div>' +
    '<label for="prompt-api-key" id="prompt-key-label">API key</label><input id="prompt-api-key" type="password" autocomplete="off" maxlength="512" placeholder="Paste your API key">' +
    '<div id="prompt-openai-models" hidden><div class="form-row"><div><label for="prompt-text-model">Text and prompt model</label><select id="prompt-text-model"></select></div><div><label for="prompt-audio-model">Audio model</label><select id="prompt-audio-model"></select></div></div><p class="field-hint">The list comes from your API key. The audio model receives short excerpts; audio usage costs more than text. See OpenAI pricing.</p></div>' +
    '<div class="prompt-ai-actions"><button id="prompt-save-key" class="pill-button">Save and verify</button><a id="prompt-keys-link" class="text-button" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">My API keys ↗</a></div><p id="prompt-ai-config-note" class="field-hint">Verification checks access and lists available models without generating text.</p>';
  root.querySelector('.prompt-ai-actions').before(aiSettings);
  const listenCard = document.createElement('div');
  listenCard.className = 'prompt-listen-card';
  listenCard.innerHTML =
    '<div class="prompt-card-heading"><span>00 / LISTEN TO A TRACK</span><span id="prompt-listen-badge">OPENAI</span></div>' +
    '<p class="field-hint">Upload a track: AI listens and prepares a style prompt, BPM, key, vocals, structure and themes for a <b>new</b> track with a similar sound. It does not transcribe lyrics or copy the melody.</p>' +
    '<div class="prompt-ai-actions"><label class="pill-button subtle prompt-file" for="prompt-listen-file">Choose a track</label><input id="prompt-listen-file" type="file" accept="audio/*" hidden><span id="prompt-listen-name" class="field-hint">No file selected</span></div>' +
    '<div class="prompt-ai-actions"><button id="prompt-listen" class="pill-button" disabled>✧ Listen and build prompt</button><span id="prompt-listen-note" class="field-hint"></span></div>' +
    '<div id="prompt-listen-result" class="prompt-listen-result" hidden></div>';
  root.querySelector('.prompt-results').prepend(listenCard);
  let listenFile = null,
    listening = false,
    consumed = false;
  document.querySelector('.main-layout').append(root);
  const $ = selector => root.querySelector(selector),
    $$ = selector => [...root.querySelectorAll(selector)];
  // Rules: a new song starts from the markup defaults of these fields, never from the previous song's draft.
  const resettable = [
    'prompt-concept',
    'prompt-lyrics-result',
    'prompt-lyrics-language',
    'prompt-tone',
    'prompt-pov',
    'prompt-lyrics-voice',
    'prompt-lyrics-mode',
    'prompt-structure-custom',
  ];
  const defaults = new Map(resettable.map(id => [id, $('#' + id).value]));
  const normalize = s => {
    const clean = createEmptyState();
    if (!s || typeof s !== 'object') return clean;
    for (const key of Object.keys(clean)) {
      if (Array.isArray(clean[key]))
        clean[key] = Array.isArray(s[key]) ? s[key].filter(v => typeof v === 'string').slice(0, 50) : [];
      else if (typeof clean[key] === 'string' && typeof s[key] === 'string')
        clean[key] = s[key].slice(0, 2000);
    }
    return clean;
  };
  try {
    const draft = JSON.parse(localStorage.getItem('sonora-prompt-draft-v1'));
    if (draft) {
      choices = normalize(draft.choices);
      outputOverride = typeof draft.output === 'string' ? draft.output.slice(0, 3000) : '';
      consumed = draft.consumed === true;
      for (const key of [
        'concept',
        'lyrics',
        'language',
        'tone',
        'pov',
        'voice',
        'duration',
        'mode',
        'structureCustom',
      ]) {
        const id = {
          concept: 'prompt-concept',
          lyrics: 'prompt-lyrics-result',
          language: 'prompt-lyrics-language',
          tone: 'prompt-tone',
          pov: 'prompt-pov',
          voice: 'prompt-lyrics-voice',
          duration: 'prompt-lyrics-duration',
          mode: 'prompt-lyrics-mode',
          structureCustom: 'prompt-structure-custom',
        }[key];
        if (typeof draft[key] === 'string')
          $('#' + id).value =
            key === 'duration' ? formatDuration(parseDuration(draft[key]) ?? 30) : draft[key];
      }
    }
    const stored = JSON.parse(localStorage.getItem('sonora-prompt-presets-v1'));
    saved = Array.isArray(stored)
      ? stored.filter(s => typeof s?.name === 'string' && s.choices).slice(0, 30)
      : [];
  } catch {}
  const persist = () => {
    try {
      localStorage.setItem(
        'sonora-prompt-draft-v1',
        JSON.stringify({
          choices,
          output: outputOverride,
          consumed,
          concept: $('#prompt-concept').value,
          lyrics: $('#prompt-lyrics-result').value,
          language: $('#prompt-lyrics-language').value,
          tone: $('#prompt-tone').value,
          pov: $('#prompt-pov').value,
          voice: $('#prompt-lyrics-voice').value,
          duration: $('#prompt-lyrics-duration').value,
          mode: $('#prompt-lyrics-mode').value,
          structureCustom: $('#prompt-structure-custom').value,
        })
      );
    } catch {
      notify('This browser could not save the prompt draft.');
    }
  };
  const showError = message => {
    $('#prompt-error').textContent = message;
    $('#prompt-error').hidden = !message;
  };
  /** Clean slate for a new song: choices, prompt, idea, lyrics, voice settings, duration and the listened file. */
  function resetSong() {
    choices = createEmptyState();
    outputOverride = '';
    consumed = false;
    for (const [id, value] of defaults) $('#' + id).value = value;
    lyricsDuration.write(30);
    $('#prompt-transfer-lyrics').checked = true;
    listenFile = null;
    $('#prompt-listen-file').value = '';
    $('#prompt-listen-name').textContent = 'No file selected';
    showError('');
    syncFields();
    renderOptions();
    updatePreview();
    updateButtons();
    try {
      localStorage.removeItem('sonora-prompt-draft-v1');
    } catch {}
  }
  const applyAiStatus = result => {
    ai = result;
    $('#prompt-ai-status').textContent = ai.available ? `${ai.providerName} · ${ai.model}` : 'Configure AI';
    $('#prompt-ai-provider-hint').textContent = `${ai.providerName || 'AI'} API · uses your account`;
    const openai = ai.providers?.openai || {};
    const fill = (select, list, value, empty) => {
      select.innerHTML =
        (empty ? `<option value="">${empty}</option>` : '') +
        [...new Set([...(value ? [value] : []), ...list])]
          .map(id => `<option value="${esc(id)}">${esc(id)}</option>`)
          .join('');
      select.value = value || '';
    };
    fill($('#prompt-text-model'), openai.textModels || [], openai.textModel, '');
    fill($('#prompt-audio-model'), openai.audioModels || [], openai.audioModel, 'None · do not analyze audio');
    const radio = $(`input[name="prompt-provider"][value="${ai.provider || 'deepseek'}"]`);
    if (radio) radio.checked = true;
    showProvider();
    if (!ai.available) $('#prompt-ai-settings').open = true;
    $('#prompt-listen-badge').textContent = ai.canListen ? 'OPENAI · ' + ai.listenModel : 'OPENAI REQUIRED';
    $('#prompt-listen-note').textContent = ai.canListen
      ? 'Up to 150 seconds of audio (the whole track if shorter). Uses your OpenAI credits.'
      : 'Select OpenAI with an audio-capable model in Configure AI.';
    updateButtons();
  };
  function showProvider() {
    const chosen = $('input[name="prompt-provider"]:checked')?.value || 'deepseek';
    const info = ai.providers?.[chosen] || {};
    $('#prompt-openai-models').hidden = chosen !== 'openai' || !info.configured;
    $('#prompt-key-label').textContent = `API key ${chosen === 'openai' ? 'OpenAI' : 'DeepSeek'}`;
    $('#prompt-api-key').placeholder = info.configured
      ? 'Key saved · paste a new key only to replace it'
      : 'Paste your API key';
    $('#prompt-keys-link').href =
      info.keysUrl ||
      (chosen === 'openai'
        ? 'https://platform.openai.com/api-keys'
        : 'https://platform.deepseek.com/api_keys');
    $('#prompt-save-key').textContent =
      info.configured && chosen !== ai.provider ? 'Use this provider' : 'Save and verify';
  }
  function getStructure() {
    const duration = lyricsDuration.read() ?? 30;
    // Rules: a typed section order wins over the preset form and the duration default.
    const custom = parseStructure($('#prompt-structure-custom').value);
    if (custom.length) return custom;
    return !choices.structure.length && duration <= 30 ? ['Verse', 'Chorus'] : sectionOrder(choices);
  }
  function updateButtons() {
    $$('button,input,select,textarea').forEach(b => (b.disabled = busy));
    const hasPrompt = !!$('#prompt-output').value.trim();
    $('#prompt-boost').disabled = busy || !ai.available || !hasPrompt;
    $('#prompt-write-lyrics').disabled = busy || !ai.available || choices.vocal.includes('instrumental-only');
    $('#prompt-use').disabled = busy || !hasPrompt;
    $('#prompt-listen').disabled = busy || !ai.canListen || !listenFile;
    $('#prompt-listen').textContent = busy && listening ? 'Listening…' : '✧ Listen and build prompt';
    $('#prompt-boost').textContent = busy ? 'AI in progress…' : '✧ Improve with AI';
    $('#prompt-write-lyrics').textContent = busy
      ? 'AI in progress…'
      : $('#prompt-lyrics-mode').value === 'write'
        ? '✧ Write AI lyrics'
        : '✧ Structure lyrics';
    $('#prompt-structure-note').textContent = choices.vocal.includes('instrumental-only')
      ? 'This prompt is instrumental. Choose a vocal type to write AI lyrics.'
      : 'Sezioni: ' + getStructure().join(' → ');
  }
  function updatePreview(invalidate = true) {
    if (invalidate) outputOverride = '';
    const fromBand = bandBpm(choices.tempo?.[0]);
    $('#prompt-bpm').placeholder = fromBand ? `Dalla fascia: ${fromBand}` : 'e.g. 110';
    const result = buildPrompt(choices);
    $('#prompt-output').value = outputOverride || result[version];
    $('#prompt-exclude-output').value = result.exclude;
    $('#prompt-word-count').textContent = `${$('#prompt-output').value.length} / 3000 characters`;
    $('#prompt-conflicts').hidden = !result.conflicts.length;
    $('#prompt-conflicts').textContent = result.conflicts.join(' · ');
    $('#prompt-selection-count').textContent =
      Object.values(choices)
        .filter(Array.isArray)
        .reduce((n, a) => n + a.length, 0) + ' selected';
    $('#prompt-strategy').hidden = true;
    updateButtons();
    persist();
  }
  function option(category, value, label, description = '') {
    const selected = choices[category].includes(value);
    return `<button type="button" class="prompt-option ${selected ? 'selected' : ''}" data-field="${category}" data-value="${esc(value)}" aria-pressed="${selected}" title="${esc(description || label)}">${esc(label)}</button>`;
  }
  function renderOptions() {
    const query = $('#prompt-search').value.trim().toLowerCase();
    const group = groups.find(g => g[0] === active);
    $('#prompt-options').innerHTML = group[2]
      .map(([category, title, options]) => {
        const hierarchical = options.some(v => typeof v !== 'string');
        const content = hierarchical
          ? options
              .map(parent => {
                const items = parent.subOptions?.length ? parent.subOptions : [parent];
                const matching = items.filter(o => `${parent.name} ${o.name}`.toLowerCase().includes(query));
                if (!matching.length) return '';
                return `<div class="prompt-option-group"><h4>${esc(parent.name)}</h4><div class="prompt-chips">${matching.map(o => option(category, category === 'reference' ? o.name : o.id, o.name, o.description)).join('')}</div></div>`;
              })
              .join('')
          : `<div class="prompt-chips">${options
              .filter(v => v.toLowerCase().includes(query))
              .map(v => option(category, v, v))
              .join('')}</div>`;
        return `<div class="prompt-option-section"><h3>${esc(title)}</h3>${content || '<p class="field-hint">No options found.</p>'}</div>`;
      })
      .join('');
  }
  function syncFields() {
    $('#prompt-custom-genre').value = choices.customGenre;
    $('#prompt-details').value = choices.customDetails;
    $('#prompt-bpm').value = choices.bpm;
  }
  function renderSaved() {
    $('#prompt-saved').innerHTML =
      '<option value="">Your personal presets</option>' +
      saved.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  }
  root.addEventListener('click', e => {
    const category = e.target.closest('[data-category]');
    if (category) {
      active = category.dataset.category;
      $$('[data-category]').forEach(b => b.classList.toggle('selected', b === category));
      $('#prompt-search').value = '';
      renderOptions();
      return;
    }
    const button = e.target.closest('[data-field]');
    if (button) {
      const { field, value } = button.dataset;
      const values = choices[field];
      if (values.includes(value)) choices[field] = values.filter(v => v !== value);
      else if (['key', 'tempo', 'structure', 'production', 'era', 'harmony_form'].includes(field))
        choices[field] = [value];
      else if (field === 'vocal' && value === 'instrumental-only') choices.vocal = ['instrumental-only'];
      else {
        if (field === 'vocal') choices.vocal = choices.vocal.filter(v => v !== 'instrumental-only');
        choices[field].push(value);
      }
      renderOptions();
      updatePreview();
    }
  });
  $('#prompt-search').addEventListener('input', renderOptions);
  for (const [id, key] of [
    ['prompt-custom-genre', 'customGenre'],
    ['prompt-details', 'customDetails'],
    ['prompt-bpm', 'bpm'],
  ])
    $('#' + id).addEventListener('input', e => {
      choices[key] = e.target.value;
      updatePreview();
    });
  $$('[data-version]').forEach(b =>
    b.addEventListener('click', () => {
      version = b.dataset.version;
      $$('[data-version]').forEach(x => x.classList.toggle('selected', x === b));
      updatePreview();
    })
  );
  $('#prompt-output').addEventListener('input', () => {
    outputOverride = $('#prompt-output').value;
    $('#prompt-word-count').textContent = `${outputOverride.length} / 3000 characters`;
    updateButtons();
    persist();
  });
  $('#prompt-random').addEventListener('click', () => {
    choices = randomPromptState();
    syncFields();
    renderOptions();
    updatePreview();
    showError('');
  });
  $('#prompt-new').addEventListener('click', () => {
    if (
      confirm(
        'Start over? This clears your selections, prompt, song idea and assistant lyrics, plus the style and lyrics in the composer.'
      )
    )
      onNewSong();
  });
  root.addEventListener('sonora:prompt-reset', resetSong);
  // Rules: once a song is created from this draft the next visit starts clean (and does not pull the old composer lyrics in).
  root.addEventListener('sonora:song-created', () => {
    consumed = true;
    persist();
  });
  $('#prompt-reset').addEventListener('click', () => {
    choices = createEmptyState();
    syncFields();
    renderOptions();
    updatePreview();
    showError('');
  });
  $('#prompt-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#prompt-output').value);
      notify('Prompt copiato.');
    } catch {
      notify('Select the prompt and copy it with Ctrl+C.');
    }
  });
  $('#prompt-save').addEventListener('click', () => {
    $('#prompt-save-panel').hidden = false;
    $('#prompt-preset-name').focus();
  });
  $('#prompt-save-cancel').addEventListener('click', () => ($('#prompt-save-panel').hidden = true));
  $('#prompt-save-confirm').addEventListener('click', () => {
    const name = $('#prompt-preset-name').value.trim();
    if (!name) {
      $('#prompt-preset-name').focus();
      return;
    }
    saved = saved.filter(p => p.name !== name);
    saved.unshift({ name, choices: structuredClone(choices) });
    saved = saved.slice(0, 30);
    try {
      localStorage.setItem('sonora-prompt-presets-v1', JSON.stringify(saved));
    } catch {
      showError('Could not save the preset.');
      return;
    }
    renderSaved();
    $('#prompt-save-panel').hidden = true;
    notify('Choices saved in your browser.');
  });
  $('#prompt-saved').addEventListener('change', e => {
    if (e.target.value === '') return;
    const selected = saved[Number(e.target.value)];
    if (selected) {
      choices = normalize(selected.choices);
      syncFields();
      renderOptions();
      updatePreview();
    }
  });
  const lyricsDuration = bindDurationField($('#prompt-lyrics-duration'), $('#prompt-lyrics-duration-preset'));
  for (const id of [
    'prompt-concept',
    'prompt-lyrics-result',
    'prompt-lyrics-language',
    'prompt-tone',
    'prompt-pov',
    'prompt-lyrics-voice',
    'prompt-lyrics-duration',
    'prompt-lyrics-mode',
    'prompt-structure-custom',
  ])
    $('#' + id).addEventListener('input', () => {
      updateButtons();
      persist();
    });
  const request = async (route, body) => {
    busy = true;
    showError('');
    updateButtons();
    try {
      const r = await fetch('/api/prompt-ai/' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) {
        fetch('/api/prompt-ai/status')
          .then(r => r.json())
          .then(applyAiStatus)
          .catch(() => {});
        throw new Error(result.error || 'AI request failed.');
      }
      return result;
    } finally {
      busy = false;
      updateButtons();
    }
  };
  $('#prompt-save-key').addEventListener('click', async () => {
    try {
      const provider = $('input[name="prompt-provider"]:checked')?.value || 'deepseek';
      const body = { provider };
      if ($('#prompt-api-key').value.trim()) body.apiKey = $('#prompt-api-key').value.trim();
      if (provider === 'openai' && !$('#prompt-openai-models').hidden) {
        if ($('#prompt-text-model').value) body.textModel = $('#prompt-text-model').value;
        body.audioModel = $('#prompt-audio-model').value || null;
      }
      const result = await request('config', body);
      $('#prompt-api-key').value = '';
      applyAiStatus(result);
      notify(
        `${result.providerName} active with ${result.model}${result.canListen ? ' · audio analysis with ' + result.listenModel : ''}.`
      );
      if (provider === 'openai' && !body.textModel)
        $('#prompt-ai-settings').open = true; // let the user review the models
      else $('#prompt-ai-settings').open = false;
    } catch (e) {
      showError(e.message);
    }
  });
  root.addEventListener('change', e => {
    if (e.target.name === 'prompt-provider') showProvider();
  });
  $('#prompt-listen-file').addEventListener('change', () => {
    listenFile = $('#prompt-listen-file').files[0] || null;
    $('#prompt-listen-name').textContent = listenFile ? listenFile.name : 'No file selected';
    updateButtons();
  });
  $('#prompt-listen').addEventListener('click', async () => {
    if (!listenFile) return;
    if (listenFile.size > 150 * 1024 * 1024) return showError('The file is larger than 150 MB.');
    busy = listening = true;
    showError('');
    updateButtons();
    try {
      const r = await fetch('/api/prompt-ai/listen', {
        method: 'POST',
        headers: {
          'X-Sonora': '1',
          'X-Audio-Name': encodeURIComponent(listenFile.name),
          'Content-Type': 'application/octet-stream',
        },
        body: listenFile,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Listening failed.');
      applyListen(result);
      notify('Track analyzed. The prompt and controls are updated; review them before using them in Sonora.');
    } catch (e) {
      showError(e.message);
    } finally {
      busy = listening = false;
      updateButtons();
    }
  });
  function applyListen(r) {
    outputOverride = r.stylePrompt;
    if (r.bpm) choices.bpm = String(r.bpm);
    if (r.key) choices.key = [r.key.replace(/\b(major|minor)\b/, m => m[0].toUpperCase() + m.slice(1))];
    if (r.vocal === 'instrumental') choices.vocal = ['instrumental-only'];
    else choices.vocal = choices.vocal.filter(v => v !== 'instrumental-only');
    syncFields();
    updatePreview(false);
    if (r.exclude) $('#prompt-exclude-output').value = r.exclude;
    const voices = { female: 'female lead', male: 'male lead', duet: 'male and female duet' };
    if (voices[r.vocal]) $('#prompt-lyrics-voice').value = voices[r.vocal];
    const languages = {
      it: 'Italian',
      en: 'English',
      fr: 'French',
      es: 'Spanish',
      de: 'German',
      pt: 'Portuguese',
    };
    if (languages[r.language]) $('#prompt-lyrics-language').value = languages[r.language];
    const target = Math.min(300, Math.round(r.duration || 0));
    if (target >= 10) lyricsDuration.write(target);
    const sections = r.structure.map(x => x.section + (x.seconds ? ` (${x.seconds} s)` : '')).join(' → ');
    if (r.lyricThemes)
      $('#prompt-concept').value = (
        r.lyricThemes + (sections ? `\nStructure of the analyzed track: ${sections}` : '')
      ).slice(0, 2500);
    const facts = [
      r.bpm && `≈ ${r.bpm} BPM`,
      r.key && r.key,
      r.timeSignature && `${r.timeSignature}/4`.replace('6/4', '6/8'),
      r.vocal &&
        {
          female: 'female voice',
          male: 'male voice',
          duet: 'duetto',
          choir: 'coro',
          instrumental: 'instrumental',
        }[r.vocal],
      `analyzed ${r.heardSeconds} sec of ${Math.round(r.duration)} sec`,
    ].filter(Boolean);
    $('#prompt-listen-result').innerHTML =
      `<p>${esc(r.summary)}</p><p class="field-hint">${facts.map(esc).join(' · ')}</p>` +
      (sections ? `<p class="field-hint">Struttura: ${esc(sections)}</p>` : '') +
      (r.notes.length
        ? `<ul class="prompt-strategy">${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`
        : '') +
      '<p class="field-hint">The style prompt is below, BPM and key are in the controls, and themes are in the song idea. Write original lyrics, then use them in Sonora.</p>';
    $('#prompt-listen-result').hidden = false;
    persist();
  }
  $('#prompt-boost').addEventListener('click', async () => {
    try {
      const result = await request('boost', {
        basePrompt: $('#prompt-output').value,
        exclude: $('#prompt-exclude-output').value,
      });
      outputOverride = result.boostedPrompt;
      updatePreview(false);
      $('#prompt-exclude-output').value = result.exclude;
      $('#prompt-strategy').innerHTML = result.strategy.map(s => `<li>${esc(s)}</li>`).join('');
      $('#prompt-strategy').hidden = !result.strategy.length;
      notify('Prompt improved. Edit it or use it in Sonora.');
    } catch (e) {
      showError(e.message);
    }
  });
  $('#prompt-write-lyrics').addEventListener('click', async () => {
    try {
      const result = await request('lyrics', {
        concept: $('#prompt-concept').value,
        language: $('#prompt-lyrics-language').value,
        tone: $('#prompt-tone').value,
        pov: $('#prompt-pov').value,
        vocalType: $('#prompt-lyrics-voice').value,
        mode: $('#prompt-lyrics-mode').value,
        existingLyrics: $('#prompt-lyrics-result').value,
        musicalContext: $('#prompt-output').value,
        structure: getStructure(),
        duration: lyricsDuration.read(),
      });
      $('#prompt-lyrics-result').value = result.lyrics;
      $('#prompt-transfer-lyrics').checked = true;
      persist();
      notify('Lyrics are ready. Review them before importing.');
    } catch (e) {
      showError(e.message);
    }
  });
  $('#prompt-use').addEventListener('click', () => {
    try {
      const lyrics = $('#prompt-transfer-lyrics').checked ? $('#prompt-lyrics-result').value : '';
      if (lyrics.trim() && choices.vocal.includes('instrumental-only'))
        throw new Error(
          'You selected Instrumental. Choose a voice or turn off Import these lyrics too.'
        );
      const patch = toSonora(choices, $('#prompt-output').value, lyrics);
      if (lyrics.trim()) {
        const languageMap = {
          Italian: 'it',
          English: 'en',
          French: 'fr',
          Spanish: 'es',
          German: 'de',
          Portuguese: 'pt',
        };
        patch.language = languageMap[$('#prompt-lyrics-language').value] || 'it';
        if (lyricsDuration.read() !== null) patch.duration = lyricsDuration.read();
      }
      onTransfer(patch);
    } catch (e) {
      showError(e.message);
    }
  });
  root.addEventListener('sonora:prompt-open', () => {
    if (consumed) {
      resetSong();
      persist();
      return;
    }
    const ctx = currentContext();
    if (!$('#prompt-lyrics-result').value) {
      if (ctx.lyrics) $('#prompt-lyrics-result').value = ctx.lyrics;
      if (Number.isInteger(ctx.duration) && ctx.duration >= 10 && ctx.duration <= 300)
        lyricsDuration.write(ctx.duration);
      const languageMap = {
        it: 'Italian',
        en: 'English',
        fr: 'French',
        es: 'Spanish',
        de: 'German',
        pt: 'Portuguese',
      };
      if (languageMap[ctx.language]) $('#prompt-lyrics-language').value = languageMap[ctx.language];
    }
    updateButtons();
    persist();
  });
  syncFields();
  renderOptions();
  renderSaved();
  updatePreview(false);
  fetch('/api/prompt-ai/status')
    .then(r => r.json())
    .then(applyAiStatus)
    .catch(() => {
      $('#prompt-ai-status').textContent = 'AI unavailable';
    });
}
