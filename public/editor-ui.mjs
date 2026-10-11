// @codedna
// description: Synchronized Web Audio stem mixer, waveform preview and replacement vocal controls.
// 
//
// 
//
// 
//
// exports: initAudioEditor
// used_by: sonora-studio/public/app.js
// rules:   Escape stored titles; never autoplay or alter original audio.
// agent:   Codex - 2026-10-04 - Personal two-track audio editor.
// Claude - 2026-10-04 - Open exported mixes in Audio Lab.
export function initAudioEditor({ api, toast, pauseLibrary, openView, openLab }) {
  const panel = document.querySelector('#audio-editor');
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const time = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  const url = (id, kind, voice = 'original', download = false, format = 'flac') =>
    `/api/editor/${id}/audio?kind=${kind}&id=${encodeURIComponent(voice)}${download ? '&download=1' : ''}${format ? `&format=${format}` : ''}`;
  panel.innerHTML = `<div class="editor-heading"><div><div class="section-eyebrow">03 / REFINE</div><h1>Sound, your way.</h1><p>Separate vocals and instrumental. Listen, replace, and find your balance.</p></div><span class="editor-badge">EDITOR · 2 TRACKS</span></div>
    <div class="editor-source"><label for="edit-track">Track to edit</label><div class="editor-source-row"><select id="edit-track"><option value="">Choose a track from your library or upload one</option></select><label class="pill-button subtle editor-upload-btn" for="edit-upload-song" style="cursor: pointer; display: inline-flex; align-items: center; white-space: nowrap;">Upload an external track</label><input id="edit-upload-song" type="file" accept="audio/*" hidden><button id="edit-separate" class="pill-button">Separate vocals and instrumental</button><button id="edit-remove-session" class="text-button" hidden style="margin-left: 4px;">Remove</button></div><p id="edit-status" class="field-hint" role="status">Choose a completed track or upload an audio file to get started.</p><p id="edit-error" class="error" hidden></p></div>
    <div id="edit-workspace" hidden><div class="editor-toolbar"><div class="editor-listen" role="group" aria-label="Editor monitoring"><button class="selected" data-listen="mix">Mix</button><button data-listen="base">Instrumental only</button><button data-listen="voice">Vocals only</button><button data-listen="original">Original</button></div><button id="edit-play" class="pill-button" disabled style="display: inline-flex; align-items: center; gap: 6px;">▶ Play mix</button></div>
      <div class="editor-timeline"><span id="edit-elapsed">0:00</span><input id="edit-seek" type="range" min="0" max="1000" value="0" aria-label="Pan nell’editor"><span id="edit-total">0:00</span></div>
      <div class="stem-track base-track"><div class="stem-head"><div><span class="stem-mark">B</span><strong>Instruments (original backing)</strong></div><div style="display:flex;gap:10px;align-items:center;"><a id="edit-base-download" class="text-button">Download FLAC</a><a id="edit-base-download-mp3" class="text-button">Download MP3</a></div></div><canvas id="edit-base-wave" aria-label="Backing waveform"></canvas><div class="stem-controls"><button id="edit-base-mute" class="pill-button subtle" aria-pressed="false">Mute instrumental</button><label for="edit-base-gain">Instrumental level</label><input id="edit-base-gain" type="range" min="0" max="2" step="0.01" value="1"><output id="edit-base-level">100%</output></div></div>
      <div class="stem-track voice-track"><div class="stem-head"><div><span class="stem-mark">V</span><strong>Voice</strong></div><div style="display:flex;gap:10px;align-items:center;"><a id="edit-voice-download" class="text-button">Download FLAC</a><a id="edit-voice-download-mp3" class="text-button">Download MP3</a></div></div><label for="edit-voice-choice">Vocal track</label><select id="edit-voice-choice"><option value="original">Original separated vocals</option></select><canvas id="edit-voice-wave" aria-label="Vocal waveform"></canvas><div class="stem-controls"><button id="edit-voice-mute" class="pill-button subtle" aria-pressed="false">Mute vocals</button><label for="edit-voice-gain">Vocal level</label><input id="edit-voice-gain" type="range" min="0" max="2" step="0.01" value="1"><output id="edit-voice-level">100%</output></div><div class="voice-offset"><label for="edit-offset">Vocal alignment (ms)</label><input id="edit-offset" type="number" min="-10000" max="10000" step="10" value="0"><span class="field-hint">Positive = later · negative = earlier</span></div></div>
      <div class="editor-export"><button id="edit-export" class="pill-button">Export mix as FLAC</button><button id="edit-reset" class="text-button">Reset adjustments</button><span id="edit-export-status" class="field-hint"></span></div><div id="edit-mixes" class="editor-mixes"></div>
      <div class="editor-replace"><div class="section-eyebrow">A NEW PERFORMANCE</div><h2>Change the vocals. Keep the instrumental.</h2><p>Import recorded vocals or try ACE-Step on the instrumental. The mix always uses the separated backing saved here.</p><div class="editor-import"><label class="pill-button subtle" for="edit-import">Import audio vocals</label><input id="edit-import" type="file" accept="audio/*" hidden><span class="field-hint">WAV, FLAC, MP3 · up to 150 MB / 10 minutes</span></div>
        <details id="edit-cover-options"><summary>Generate new vocals with ACE-Step · experimental</summary><label for="edit-cover-tags">Desired style and voice</label><textarea id="edit-cover-tags" rows="3" maxlength="3000" placeholder="warm female vocals, jazz, soft intimate singing…"></textarea><label for="edit-cover-lyrics">Lyrics to sing</label><textarea id="edit-cover-lyrics" rows="8" maxlength="12000"></textarea><p class="field-hint">ACE-Step creates a full cover using the track as a reference. Sonora extracts the vocals and mixes them over the preserved instrumental. Melody, pronunciation and timing may vary; vocal separation can leave artifacts.</p><button id="edit-cover" class="pill-button">Generate new vocals</button><p id="edit-cover-status" class="field-hint" role="status"></p></details>
      </div><p class="editor-note">Originals stay in your library. The separated instrumental may contain vocal residue. The new mix keeps the original duration and trims vocals that extend past the ending. If the combined level is too high, export lowers the overall volume to prevent distortion.</p></div>`;
  const $ = id => panel.querySelector('#' + id);
  let state = {},
    selected = null,
    active = false,
    session = null,
    ctx = null,
    buffers = {},
    sources = [],
    gains = {},
    position = 0,
    started = 0,
    playing = false,
    listen = 'mix',
    loadToken = 0,
    loadedKey = '',
    loading = false,
    lastSessionKey = '',
    settingsTimer,
    dirtySettings = null,
    frame,
    baseMuted = false,
    voiceMuted = false;
  const value = () => ({
    baseGain: baseMuted ? 0 : Number($('edit-base-gain').value),
    voiceGain: voiceMuted ? 0 : Number($('edit-voice-gain').value),
    offsetMs: Math.max(-10000, Math.min(10000, Number($('edit-offset').value) || 0)),
    voiceId: $('edit-voice-choice').value || 'original',
  });
  function currentPosition() {
    return playing
      ? Math.max(0, Math.min(buffers.base?.duration || 0, position + ctx.currentTime - started))
      : position;
  }
  function pause() {
    position = currentPosition();
    for (const source of sources)
      try {
        source.stop();
      } catch {}
    sources = [];
    playing = false;
    cancelAnimationFrame(frame);
    $('edit-play').textContent = '▶ Play ' + (listen === 'original' ? 'originale' : 'mix');
    draw();
  }
  function updateGains() {
    const v = value();
    if (gains.base) gains.base.gain.value = listen === 'voice' ? 0 : v.baseGain;
    if (gains.voice) gains.voice.gain.value = listen === 'base' ? 0 : v.voiceGain;
  }
  async function play() {
    if (loading || !buffers.base) return;
    if (playing) {
      pause();
      return;
    }
    pauseLibrary();
    await ctx.resume();
    if (position >= buffers.base.duration) position = 0;
    started = ctx.currentTime + 0.025;
    playing = true;
    sources = [];
    gains = {};
    const start = (name, buffer, shift = 0) => {
      const offset = position - shift;
      if (offset >= buffer.duration) return;
      const source = ctx.createBufferSource(),
        gain = ctx.createGain();
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      gains[name] = gain;
      const delay = Math.max(0, -offset),
        begin = Math.max(0, offset),
        duration = Math.min(buffer.duration - begin, buffers.base.duration - position - delay);
      if (duration <= 0) return;
      source.start(started + delay, begin, duration);
      sources.push(source);
    };
    if (listen === 'original') start('original', buffers.original);
    else {
      start('base', buffers.base);
      start('voice', buffers.voice, value().offsetMs / 1000);
      updateGains();
    }
    $('edit-play').textContent = '⏸ Pause';
    tick();
  }
  function tick() {
    draw();
    if (currentPosition() >= buffers.base.duration) {
      pause();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  function draw() {
    const at = currentPosition(),
      duration = buffers.base?.duration || session?.duration || 0;
    $('edit-elapsed').textContent = time(at);
    $('edit-total').textContent = time(duration);
    $('edit-seek').value = duration ? (at / duration) * 1000 : 0;
    for (const name of ['base', 'voice']) {
      const canvas = $('edit-' + name + '-wave'),
        buffer = buffers[name];
      if (!canvas || !buffer) continue;
      const width = Math.max(1, canvas.clientWidth),
        height = 64,
        dpr = devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      const c = canvas.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      const samples = buffer.getChannelData(0),
        step = Math.max(1, Math.floor(samples.length / width));
      c.fillStyle = name === 'base' ? '#9dac8e' : '#dcb195';
      for (let x = 0; x < width; x += 3) {
        let peak = 0;
        for (let j = 0; j < step; j += Math.max(1, Math.floor(step / 20)))
          peak = Math.max(peak, Math.abs(samples[Math.min(samples.length - 1, x * step + j)]));
        const h = Math.max(2, peak * 60);
        c.fillRect(x, (height - h) / 2, 2, h);
      }
      c.fillStyle = '#ffffff70';
      c.fillRect(duration ? (at / duration) * width : 0, 0, 1, height);
    }
  }
  async function load() {
    const key = selected + ':' + (session?.settings?.voiceId || 'original');
    if (!session?.stems || key === loadedKey || !active) return;
    const token = ++loadToken;
    pause();
    loading = true;
    buffers = {};
    $('edit-play').disabled = true;
    $('edit-play').textContent = '⏳ Uploading…';
    $('edit-status').textContent = 'Loading tracks for playback…';
    try {
      ctx ??= new AudioContext();
      const decode = async route => {
        const r = await fetch(route);
        if (!r.ok) throw new Error('Track audio is unavailable.');
        return ctx.decodeAudioData(await r.arrayBuffer());
      };
      const [base, voice, original] = await Promise.all([
        decode(url(selected, 'base', 'original', false, 'mp3')),
        decode(url(selected, 'voice', session.settings.voiceId, false, 'mp3')),
        decode(url(selected, 'original', 'original', false, 'mp3')),
      ]);
      if (token !== loadToken) return;
      buffers = { base, voice, original };
      loadedKey = key;
      position = 0;
      $('edit-play').disabled = false;
      $('edit-play').textContent = '▶ Play ' + (listen === 'original' ? 'originale' : 'mix');
      draw();
    } catch (e) {
      if (token === loadToken) {
        loadedKey = key;
        $('edit-play').disabled = true;
        $('edit-play').textContent = '▶ Play mix';
        toast(e.message);
      }
    } finally {
      if (token === loadToken) {
        loading = false;
        render(state);
      }
    }
  }
  async function select(id) {
    pause();
    selected = id || null;
    loadedKey = '';
    lastSessionKey = '';
    buffers = {};
    position = 0;
    loadToken++;
    $('edit-track').value = id || '';
    const job = state.jobs?.find(j => j.id === id);
    $('edit-cover-tags').value = job?.input.tags || '';
    $('edit-cover-lyrics').value = job?.input.lyrics || '';
    render(state);
  }
  function applySettings(s) {
    const v = s.settings || {};
    baseMuted = v.baseGain === 0;
    voiceMuted = v.voiceGain === 0;
    $('edit-base-gain').value = v.baseGain || 1;
    $('edit-voice-gain').value = v.voiceGain || 1;
    $('edit-offset').value = v.offsetMs ?? 0;
    $('edit-voice-choice').innerHTML =
      '<option value="original">Original separated vocals</option>' +
      (s.voices || []).map(v => `<option value="${v.id}">${esc(v.label)}</option>`).join('');
    $('edit-voice-choice').value = v.voiceId || 'original';
    updateLabels();
  }
  function updateLabels() {
    for (const name of ['base', 'voice']) {
      const muted = name === 'base' ? baseMuted : voiceMuted;
      $('edit-' + name + '-mute').setAttribute('aria-pressed', String(muted));
      $('edit-' + name + '-level').textContent = muted
        ? 'Mute'
        : Math.round(Number($('edit-' + name + '-gain').value) * 100) + '%';
    }
  }
  function render(next) {
    state = next;
    const jobs = (state.jobs || []).filter(j => j.status === 'done' && !j.archived);
    const externalSessions = (state.editor?.sessions || []).filter(s => s.source?.kind === 'import');
    let options = '<option value="">Choose a track from your library or upload one</option>';
    if (externalSessions.length) {
      options += `<optgroup label="External tracks">${externalSessions.map(s => `<option value="${s.id}">${esc(s.title || 'Track esterno')}</option>`).join('')}</optgroup>`;
    }
    if (jobs.length) {
      options += `<optgroup label="Sonora library">${jobs.map(j => `<option value="${j.id}">${esc(j.title)}</option>`).join('')}</optgroup>`;
    }
    if ($('edit-track').innerHTML !== options) {
      $('edit-track').innerHTML = options;
      $('edit-track').value = selected || '';
    }
    session = state.editor?.sessions.find(s => s.id === selected);
    if (session && dirtySettings?.id === selected) session = { ...session, settings: dirtySettings.values };
    const busy = ['queued', 'processing'].includes(session?.status);
    if ($('edit-remove-session')) {
      const isImported = session?.source?.kind === 'import';
      $('edit-remove-session').hidden = !isImported;
      $('edit-remove-session').disabled = busy;
    }
    $('edit-separate').disabled = !selected || busy || !!session?.stems || !state.editor?.available;
    $('edit-separate').textContent = busy
      ? 'Processing…'
      : session?.stems
        ? 'Tracce separate'
        : 'Separate vocals and instrumental';
    $('edit-workspace').hidden = !session?.stems;
    $('edit-status').textContent = loading
      ? 'Loading tracks for playback…'
      : !selected
        ? 'Choose a completed track or upload an audio file to get started.'
        : busy
          ? session.phase
          : session?.stems
            ? 'Due tracks pronte · ' +
              time(session.duration) +
              (session.stemAttenuation < 1 ? ' · overall level lowered to prevent distortion' : '')
            : 'Separation runs on this computer. The first use prepares the model.';
    const error = session?.error || session?.coverError;
    $('edit-error').hidden = !error;
    $('edit-error').textContent = error || '';
    for (const control of ['edit-import', 'edit-export', 'edit-cover', 'edit-reset'])
      $(control).disabled = busy || !session?.stems;
    const isImported = session?.source?.kind === 'import';
    const coverDetails = panel.querySelector('#edit-cover-options');
    if (coverDetails) coverDetails.hidden = isImported;
    $('edit-cover').disabled =
      busy || !session?.stems || !!session.pendingCoverId || !state.health?.ready || isImported;
    const pending = state.jobs?.find(j => j.id === session?.pendingCoverId);
    $('edit-cover-status').textContent = pending
      ? 'New vocals · ' +
        pending.phase +
        (pending.progress ? ` ${pending.progress.value}/${pending.progress.max}` : '')
      : '';
    if (!session?.stems) return;
    const sessionKey = JSON.stringify([session.settings, session.voices]);
    if (sessionKey !== lastSessionKey) {
      lastSessionKey = sessionKey;
      applySettings(session);
    }
    const weak = session.voices?.find(v => v.id === session.settings.voiceId)?.quiet;
    let hint = panel.querySelector('#edit-voice-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.id = 'edit-voice-hint';
      hint.className = 'field-hint';
      $('edit-voice-choice').after(hint);
    }
    hint.hidden = !weak;
    hint.textContent = weak
      ? 'The extracted vocals are very quiet. Try another style or import an audio vocal.'
      : '';
    $('edit-base-download').href = url(selected, 'base', 'original', true, 'flac');
    if ($('edit-base-download-mp3'))
      $('edit-base-download-mp3').href = url(selected, 'base', 'original', true, 'mp3');
    $('edit-voice-download').href = url(selected, 'voice', session.settings.voiceId, true, 'flac');
    if ($('edit-voice-download-mp3'))
      $('edit-voice-download-mp3').href = url(selected, 'voice', session.settings.voiceId, true, 'mp3');
    $('edit-mixes').innerHTML = (session.mixes || [])
      .map(
        (m, i) =>
          `<a class="pill-button subtle" href="${url(selected, 'mix', m.id, true)}">${i === 0 ? 'Latest mix' : 'Mix ' + (session.mixes.length - i)} · FLAC</a><button class="text-button" data-lab-mix="${m.id}">Master in Audio Lab</button><span class="field-hint">${m.attenuation < 1 ? 'Level reduced by ' + Math.round((1 - m.attenuation) * 100) + '% to prevent clipping.' : ''}</span>`
      )
      .join('');
    $('edit-export-status').textContent = busy ? session.phase : '';
    void load();
  }
  function saveSettings() {
    updateLabels();
    updateGains();
    clearTimeout(settingsTimer);
    const pending = { id: selected, values: value() };
    dirtySettings = pending;
    if (session) session = { ...session, settings: pending.values };
    lastSessionKey = JSON.stringify([session?.settings, session?.voices]);
    settingsTimer = setTimeout(async () => {
      try {
        const saved = await api(`/api/editor/${pending.id}/settings`, 'PATCH', pending.values);
        if (dirtySettings === pending) {
          dirtySettings = null;
          const index = state.editor.sessions.findIndex(s => s.id === pending.id);
          if (index >= 0) state.editor.sessions[index] = saved;
          render(state);
        }
      } catch (e) {
        if (dirtySettings === pending) dirtySettings = null;
        toast(e.message);
        render(state);
      }
    }, 400);
  }
  $('edit-track').addEventListener('change', () => void select($('edit-track').value));
  $('edit-separate').addEventListener('click', async () => {
    try {
      await api(`/api/editor/${selected}/separate`, 'POST', {});
      toast('Vocal/instrumental separation started.');
    } catch (e) {
      toast(e.message);
    }
  });
  $('edit-play').addEventListener('click', () => play().catch(e => toast(e.message)));
  $('edit-seek').addEventListener('input', () => {
    const at = (Number($('edit-seek').value) / 1000) * (buffers.base?.duration || 0),
      resume = playing;
    pause();
    position = at;
    draw();
    if (resume) void play();
  });
  panel.querySelectorAll('[data-listen]').forEach(button =>
    button.addEventListener('click', () => {
      const resume = playing;
      pause();
      listen = button.dataset.listen;
      panel.querySelectorAll('[data-listen]').forEach(b => b.classList.toggle('selected', b === button));
      if (resume) void play();
    })
  );
  for (const name of ['base', 'voice']) {
    $('edit-' + name + '-gain').addEventListener('input', saveSettings);
    $('edit-' + name + '-mute').addEventListener('click', () => {
      if (name === 'base') baseMuted = !baseMuted;
      else voiceMuted = !voiceMuted;
      saveSettings();
    });
  }
  $('edit-offset').addEventListener('change', () => {
    const resume = playing;
    pause();
    saveSettings();
    if (resume) void play();
  });
  $('edit-voice-choice').addEventListener('change', () => {
    pause();
    saveSettings();
    loadedKey = '';
    void load();
  });
  $('edit-reset').addEventListener('click', () => {
    pause();
    baseMuted = voiceMuted = false;
    $('edit-base-gain').value = $('edit-voice-gain').value = 1;
    $('edit-offset').value = 0;
    saveSettings();
  });
  $('edit-export').addEventListener('click', async () => {
    try {
      clearTimeout(settingsTimer);
      await api(`/api/editor/${selected}/mix`, 'POST', value());
      dirtySettings = null;
      toast('Mix export started.');
    } catch (e) {
      toast(e.message);
    }
  });
  $('edit-import').addEventListener('change', async () => {
    const file = $('edit-import').files[0];
    if (!file) return;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('The file is larger than 150 MB.');
      const r = await fetch(`/api/editor/${selected}/voice`, {
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
      toast('Preparing new vocals.');
    } catch (e) {
      toast(e.message);
    } finally {
      $('edit-import').value = '';
    }
  });
  $('edit-upload-song').addEventListener('change', async () => {
    const file = $('edit-upload-song').files[0];
    if (!file) return;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('The file is larger than 150 MB.');
      pause();
      $('edit-status').textContent = 'Uploading external track…';
      const r = await fetch('/api/editor/import', {
        method: 'POST',
        headers: {
          'X-Sonora': '1',
          'X-Audio-Name': encodeURIComponent(file.name),
          'Content-Type': 'application/octet-stream',
        },
        body: file,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Upload failed.');
      toast('External track uploaded and ready for separation.');
      await select(result.id);
    } catch (e) {
      toast(e.message);
    } finally {
      $('edit-upload-song').value = '';
    }
  });
  $('edit-remove-session').addEventListener('click', async () => {
    if (!selected) return;
    try {
      pause();
      const idToRemove = selected;
      await api(`/api/editor/${idToRemove}`, 'DELETE');
      selected = null;
      session = null;
      toast('External track removed.');
      render(state);
    } catch (e) {
      toast(e.message);
    }
  });
  $('edit-cover').addEventListener('click', async () => {
    try {
      const tags = $('edit-cover-tags').value.trim(),
        lyrics = $('edit-cover-lyrics').value.trim();
      if (!tags || !lyrics) throw new Error('Enter a style and lyrics for the new vocals.');
      $('edit-cover').disabled = true;
      await api(`/api/editor/${selected}/cover`, 'POST', { tags, lyrics });
      toast('Cover queued. The new vocals will appear here after separation.');
    } catch (e) {
      toast(e.message);
      render(state);
    }
  });
  $('edit-mixes').addEventListener('click', e => {
    const mix = e.target.closest('[data-lab-mix]');
    if (mix) {
      pause();
      openLab(selected, mix.dataset.labMix);
    }
  });
  window.addEventListener('resize', draw);
  return {
    render,
    setActive: value => {
      active = value;
      if (!value) pause();
      else void load();
    },
    open: async id => {
      openView();
      await select(id);
    },
    pause,
  };
}
