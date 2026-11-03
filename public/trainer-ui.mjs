const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export function initLoraTrainer({ api, toast }) {
  const root = document.querySelector('#lora-trainer');
  let state = { projects: [] },
    yueRuns = [],
    selected = '',
    active = false,
    busy = false;
  const openHelp = new Set();
  const helpTopics = [
    [
      'start',
      '1. The complete path',
      `<ol>
      <li>Choose a single goal: a sung voice or a musical style.</li>
      <li>Prepare representative excerpts of 10 to 30 seconds.</li>
      <li>In <strong>Create project</strong> give the LoRA a recognisable name, then upload the audio or import the annotated tracks from another project.</li>
      <li>For each track choose Sung or Instrumental, write the description and, if sung, the exact lyrics. Press <strong>Save annotations</strong> on each track.</li>
      <li>Set the epochs and press <strong>Start training</strong>. Segui lo stato del progetto.</li>
      <li>When <strong>LoRA ready</strong> appears, open <strong>Create music</strong>, select RunPod and choose the LoRA in its menu.</li>
      <li>Generate a short test, listen to it and compare it with a test without the LoRA.</li>
    </ol>`,
    ],
    [
      'purpose',
      '2. What a LoRA learns',
      `<p>A LoRA is an adapter of the ACE-Step 1.5 XL Turbo music model: it can steer the generation towards recurring characteristics of your examples. It is not an audio sample to paste into the song and it does not guarantee the exact reproduction of a person.</p>
      <p><strong>Voice:</strong> use sung examples of the same voice. Spoken recordings alone do not guarantee an equivalent sung voice. An isolated voice can be useful as an example, but the quality must be checked; if the examples contain very characteristic accompaniment, the model may learn that too.</p>
      <p><strong>Style:</strong> use instrumental tracks or songs with consistent arrangements. An instrumental does not teach a voice. To try different voices and styles, create separate projects. Use your own audio or audio you have permission to train on.</p>`,
    ],
    [
      'audio',
      '3. Preparing the audio and respecting the limits',
      `<p>The first version uses <strong>only the first 30 seconds of each file</strong>, even if you upload a long song. If the useful part starts later, prepare the excerpt before uploading: the trainer has no start-point selector.</p>
      <ul><li>Each file must last from 10 seconds to 5 minutes; a 10–30 second excerpt avoids ignored content.</li><li>Maximum 20 tracks, 100 MB per file and 200 MB in total per project.</li><li>WAV, MP3, FLAC, OGG and M4A are accepted. For training, 48 kHz stereo WAV files are prepared; the originals are kept.</li></ul>
      <p>As a practical rule, choose clear recordings, without distortion, long silences or dominant noise. For a voice, include different phrases and different registers of the same singer. For a style, include passages that show instruments, rhythm and atmosphere. Repeating the same excerpt many times adds no variety.</p>
      <p>One track is enough for a technical test, but it does not prove that the model learned a voice or a style well. You can remove examples from the dataset or import copies with annotations from other projects. The original audio stays on disk; the excerpt used by the training cannot be edited here.</p>`,
    ],
    [
      'notes',
      '4. Descriptions and lyrics: what to write',
      `<p>Describe what you really hear in the excerpt: instruments, genre, rhythm, timbre, way of singing and atmosphere. The project name is a label for the menu; it is not a special word that the model learns automatically.</p>
      <p><strong>Sung example:</strong> “Soft female voice in the middle register, intimate singing with little vibrato, piano accompaniment, slow ballad”.</p>
      <p><strong>Instrumental example:</strong> “Arpeggiated acoustic guitar, warm bass and light drums, steady rhythm, intimate atmosphere”. Do not state BPM or key if you do not know them.</p>
      <p>For <strong>Sung</strong>, enter the words actually sung in the excerpt used, in the correct order. Do not paste the lyrics of the whole song if the training only listens to 30 seconds. For <strong>Instrumental</strong>, leave the lyrics empty. There is no automatic transcription: check the words yourself, then save the annotations of each track.</p>`,
    ],
    [
      'epochs',
      '5. Epochs: how to choose and compare',
      `<p>An epoch is one pass through the prepared examples. More epochs increase the training work; they do not guarantee a better result and can make the model too tied to the examples.</p>
      <ul><li><strong>1 epoch:</strong> technical test of upload and generation. It is not a measure of vocal quality.</li><li><strong>20 epochs:</strong> default value in the interface, to be judged by listening on your material.</li><li><strong>Da 1 a 100:</strong> allowed range. The job may still stop at the time limit before completing them all.</li></ul>
      <p>To compare different settings, create a new project and import the already annotated examples, then add or remove tracks. A new training on the same project restarts from the base model: it does not automatically continue the previous training and may replace the project's adapter. Songs already generated remain in the library.</p>`,
    ],
    [
      'cost',
      '6. GPU, costs and duration',
      `<p>Creating the project and uploading the audio to Sonora does not start the GPU training. By pressing <strong>Start training</strong> you authorise the copy to RunPod, the preparation of the examples and the training: these operations can use GPU credit.</p>
      <p>The trainer starts its own worker; <strong>you do not need to press Start GPU session</strong>, which is for generating songs. Stop that session first and wait for the generations to finish. Sonora prevents starting new trainings or new generations at the same time as a training.</p>
      <p>The training job limit is <strong>30 minutes</strong>. Copying the dataset and waiting for a GPU can add time: this is not a promise of completion within 30 minutes of the click. The first start can take minutes and GPU availability varies.</p>
      <p>The trainer goes back to zero permanent workers after the job. The <strong>persistent storage stays paid</strong> as long as the volume exists. Check balance, usage and rates in the RunPod console; Sonora shows no cost estimate and sets no dollar limit.</p>`,
    ],
    [
      'states',
      '7. States, interruption and problems',
      `<dl>
      <dt>GPU start and private copy of the dataset</dt><dd>The examples are copied through the authenticated RunPod API. Starting the worker can take time.</dd>
      <dt>Queued for GPU</dt><dd>The request is registered and is waiting for a worker. Avoid sending it again.</dd>
      <dt>Preparation and training</dt><dd>The worker prepares the examples and trains the model. No epoch progress percentage is shown.</dd>
      <dt>LoRA ready</dt><dd>The completed adapter is available in the generation selector.</dd>
      <dt>Training interrupted / Cancelled</dt><dd>Read the project message. The audio stays kept; a partial checkpoint does not automatically become a selectable LoRA.</dd>
      <dt>Uncertain receipt</dt><dd>Sonora does not know whether RunPod accepted the training. Check the job in the RunPod console before starting other jobs; Sonora does not resend it automatically.</dd>
    </dl><p><strong>Stop training</strong> appears when the RunPod receipt is available and also lets you cancel the pending copy. Wait for the final state: cancelling does not return the credit already used.</p>
      <p>Closing the browser page does not cancel the job and does not stop GPU usage. You can come back to this section to check its status; to stop it use <strong>Stop training</strong>.</p>
      <p>During a job the dataset is locked. After a restart, a training already registered is checked without duplicating it; an interrupted copy can be retried when the message confirms that no training was sent. Any checkpoints stay on the volume, but resuming from a checkpoint is not available in this interface.</p>`,
    ],
    [
      'use',
      '8. Using and evaluating the model',
      `<p>In <strong>Create music</strong>, choose <strong>RunPod</strong> and the project name in the <strong>LoRA</strong>. Incomplete models do not appear. Still write the musical description and the lyrics of the new song: the LoRA does not replace these fields. It is compatible with the XL Turbo model used by Sonora; loading it in local ComfyUI is not provided by this integration.</p>
      <p>To compare the result, generate a short example with the LoRA and one choosing <strong>No LoRA</strong>, keeping the lyrics, description, duration and seed the same. Listen to timbre, pronunciation, instrument coherence, noise and repetitions. Then try lyrics or a melody different from the examples: a good result on a single song does not prove good generalisation.</p>
      <p>In Create music, after choosing the LoRA, adjust <strong>LoRA strength</strong>: 0% uses the base model, 50% halves the adapter weight, 100% applies full strength. The perceived effect is not an exact percentage of the style in the song. If you hear little effect, review the examples before increasing the epochs. Songs are downloaded as <strong>MP3 or WAV</strong>.</p>`,
    ],
  ];
  const helpSection = (id, title, content) =>
    `<details class="trainer-help-topic" data-trainer-help="${id}" ${openHelp.has(id) ? 'open' : ''}><summary>${title}</summary><div>${content}</div></details>`;
  const help = () =>
    `<details class="trainer-guide" data-trainer-help="guide" ${openHelp.has('guide') ? 'open' : ''}><summary>Complete guide · from audio to a song with a LoRA</summary><div class="trainer-guide-content"><p>This guide describes the functions currently available in Sonora. Open the topics you need.</p>${helpTopics.map(t => helpSection(...t)).join('')}<p class="trainer-guide-sources">Further reading: <a href="https://ace-step.github.io/ACE-Step-1.5/en/LoRA_Training_Tutorial" target="_blank" rel="noopener noreferrer">official ACE-Step guide</a> · <a href="https://www.runpod.io/pricing" target="_blank" rel="noopener noreferrer">RunPod rates</a>. Le istruzioni dei servizi originali possono includere opzioni che Sonora non espone.</p></div></details>`;
  root.addEventListener(
    'toggle',
    e => {
      const id = e.target.dataset?.trainerHelp;
      if (!id || !e.target.isConnected) return;
      if (e.target.open) openHelp.add(id);
      else openHelp.delete(id);
    },
    true
  );
  const labels = {
    uploading: 'GPU start and private copy of the dataset',
    queued: 'Queued for GPU',
    running: 'Preparation and training',
    done: 'LoRA ready',
    failed: 'Training interrupted',
    cancelled: 'Cancelled',
    uncertain: 'Uncertain receipt: check RunPod',
    submitting: 'Sending',
    cancelling: 'Cancelling',
  };
  function draw() {
    if (!active || busy) return;
    const p = state.projects.find(p => p.id === selected) || state.projects[0];
    if (p) selected = p.id;
    const yueRun = yueRuns.find(run => run.projectId === p?.id);
    const yueBusy = yueRuns.some(run => !['done', 'failed', 'cancelled'].includes(run.status));
    root.innerHTML = `<div class="section-eyebrow">PERSONAL VOICE AND STYLE</div><h1>LoRA trainer</h1><p>Upload musical examples and their lyrics or description. ACE-Step training uses a dedicated RunPod GPU for a maximum of 30 minutes; YuE2 has different recipes and timings. Neither guarantees cloning a voice from speech.</p>${help()}${!state.configured ? '<p class="error">Training worker being prepared. You can already create and annotate the dataset.</p>' : ''}<form id="trainer-create"><label>LoRA name<input name="name" maxlength="100" required placeholder="My style"></label><button class="pill-button">Create project</button></form><label>Project<select id="trainer-project">${state.projects.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>${p ? `<h2>${esc(p.name)}</h2><p>${esc(labels[p.job?.status] || 'Dataset to prepare')} · ${p.tracks.length} ${p.tracks.length === 1 ? 'track' : 'tracks'}</p>${p.job?.error ? `<p class="error">${esc(p.job.error)}</p>` : ''}<label>Upload WAV, MP3 or FLAC<input id="trainer-files" type="file" accept="audio/*" multiple></label><p>From 10 seconds to 5 minutes per track; 100 MB per file, 200 MB per project. In this first version the training uses the first 30 seconds of each example: upload representative excerpts. We keep the originals.</p>${p.tracks.map(t => `<form class="trainer-track" data-track="${t.id}"><h3>${esc(t.name)} · ${Math.round(t.duration)} s</h3><label>Type<select name="instrumental"><option value="true" ${t.instrumental ? 'selected' : ''}>Instrumental</option><option value="false" ${!t.instrumental ? 'selected' : ''}>Sung</option></select></label><label>Description of the style or voice<textarea name="caption" maxlength="3000" required>${esc(t.caption)}</textarea></label><label>Exact words sung in the example<textarea name="lyrics" maxlength="12000">${esc(t.lyrics)}</textarea></label><button class="pill-button">Save annotations</button></form>`).join('')}<form id="trainer-start"><label>Epochs<input name="epochs" type="number" value="20" min="1" max="100" required></label><p>The training uses GPU credit. Start with a short test; you can stop it. Any checkpoints stay in storage.</p><button class="pill-button" ${!state.configured || !p.tracks.length || (p.job && !['done', 'failed', 'cancelled'].includes(p.job.status)) ? 'disabled' : ''}>Start training · max 30 min</button></form>${(p.job?.remoteId || p.job?.uploadRemoteId) && !['done', 'failed', 'cancelled'].includes(p.job.status) ? '<button id="trainer-cancel" class="pill-button">Stop training</button>' : ''}` : ''}`;
    if (!p) return;
    const locked = !!p.job && !['done', 'failed', 'cancelled'].includes(p.job.status);
    const sources = state.projects.filter(project => project.id !== p.id && project.tracks.length);
    const importMarkup = sources.length
      ? `<form id="trainer-import" class="trainer-import"><h3>Import tracks from another project</h3><p>Audio and annotations are copied. You can edit them here without changing the original project.</p><label>Source project<select id="trainer-import-source">${sources.map(source => `<option value="${source.id}">${esc(source.name)} · ${source.tracks.length} ${source.tracks.length === 1 ? 'track' : 'tracks'}</option>`).join('')}</select></label><div id="trainer-import-list"></div><button class="pill-button" ${locked ? 'disabled' : ''}>Import selected tracks</button></form>`
      : '<p class="field-hint">To reuse annotated tracks, create another project and import them from here.</p>';
    root.querySelector('#trainer-start')?.insertAdjacentHTML('beforebegin', importMarkup);
    root
      .querySelector('#trainer-start')
      ?.insertAdjacentHTML(
        'afterend',
        `<section class="trainer-yue2"><h3>LoRA for YuE2</h3><p>This training uses the YuE2 GPU on RunPod and uses credit. During the training you cannot create other YuE2 songs on RunPod. The finished LoRA appears in <strong>Yue2 adapters (LoRA) → Your LoRAs</strong> when you choose <strong>Where to create it: RunPod</strong>.</p><form id="trainer-yue2-start"><label>LoRA name<input name="name" maxlength="60" required value="${esc(p.name)}"></label><label>Recipe<select name="preset"><option value="fast">Fast · first test</option><option value="balanced">Balanced</option><option value="thorough">Thorough · more GPU</option></select></label><button class="pill-button" ${!p.tracks.length || yueBusy ? 'disabled' : ''}>Train for YuE2 (RunPod)</button></form>${yueRun ? `<p role="status"><strong>${esc(yueRun.name)}</strong> · ${esc(yueRun.phase || yueRun.status)}${yueRun.status === 'done' ? ` · ${esc(yueRun.result?.step || '?')} steps` : ''}</p>${yueRun.error ? `<p class="error">${esc(yueRun.error)}</p>` : ''}${!['done', 'failed', 'cancelled'].includes(yueRun.status) ? `<button id="trainer-yue2-cancel" class="text-button" data-run="${yueRun.id}">Cancel YuE2 training</button>` : ''}` : ''}</section>`
      );
    p.tracks.forEach(track => {
      const form = [...root.querySelectorAll('.trainer-track')].find(item => item.dataset.track === track.id);
      form?.insertAdjacentHTML(
        'beforeend',
        `<button class="text-button trainer-remove" type="button" data-remove-track="${track.id}" ${locked ? 'disabled' : ''}>Remove from the project</button>`
      );
    });
    const upload = root.querySelector('#trainer-files');
    if (upload) upload.disabled = locked;
    renderImportList();
  }
  function renderImportList() {
    const sourceId = root.querySelector('#trainer-import-source')?.value;
    const source = state.projects.find(project => project.id === sourceId);
    const list = root.querySelector('#trainer-import-list');
    if (!list) return;
    list.innerHTML = (source?.tracks || [])
      .map(
        track =>
          `<label class="trainer-import-choice"><input type="checkbox" name="trackIds" value="${track.id}"><span>${esc(track.name)} · ${Math.round(track.duration)} s<br><small>${esc(track.caption || 'Annotations to complete')}</small></span></label>`
      )
      .join('');
  }
  async function run(task) {
    if (busy) return;
    busy = true;
    root.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      state = await task();
      toast('Project updated.');
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
      draw();
    }
  }
  root.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target,
      b = Object.fromEntries(new FormData(f));
    if (f.id === 'trainer-create')
      run(async () => {
        const next = await api('/api/trainer/projects', 'POST', b);
        selected = next.projects[0]?.id || selected;
        return next;
      });
    else if (f.id === 'trainer-import') {
      const sourceProjectId = f.querySelector('#trainer-import-source').value;
      const trackIds = [...f.querySelectorAll('input[name="trackIds"]:checked')].map(input => input.value);
      if (!trackIds.length) return toast('Select at least one track to import.');
      run(() => api(`/api/trainer/${selected}/import`, 'POST', { sourceProjectId, trackIds }));
    } else if (f.id === 'trainer-start')
      run(() => api(`/api/trainer/${selected}/start`, 'POST', { epochs: Number(b.epochs) }));
    else if (f.id === 'trainer-yue2-start')
      run(async () => {
        await api(`/api/trainer/${selected}/yue2`, 'POST', { name: b.name, preset: b.preset });
        const next = await api('/api/state');
        yueRuns = next.yue2Training || [];
        return next.trainer;
      });
    else if (f.dataset.track)
      run(() =>
        api(`/api/trainer/${selected}/tracks/${f.dataset.track}`, 'POST', {
          ...b,
          instrumental: b.instrumental === 'true',
        })
      );
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'trainer-project') {
      selected = e.target.value;
      draw();
    }
    if (e.target.id === 'trainer-import-source') renderImportList();
    if (e.target.id === 'trainer-files') {
      const files = [...e.target.files];
      run(async () => {
        let next;
        for (const file of files) {
          const r = await fetch(`/api/trainer/${selected}/upload`, {
            method: 'POST',
            headers: { 'X-Sonora': '1', 'X-Audio-Name': encodeURIComponent(file.name) },
            body: file,
          });
          const b = await r.json();
          if (!r.ok) throw new Error(b.error);
          next = b;
        }
        return next || state;
      });
    }
  });
  root.addEventListener('click', e => {
    if (e.target.id === 'trainer-cancel') run(() => api(`/api/trainer/${selected}/cancel`, 'POST', {}));
    if (e.target.id === 'trainer-yue2-cancel')
      run(async () => {
        await api(`/api/yue2/training/${e.target.dataset.run}/cancel`, 'POST', {});
        const next = await api('/api/state');
        yueRuns = next.yue2Training || [];
        return next.trainer;
      });
    const trackId = e.target.closest('[data-remove-track]')?.dataset.removeTrack;
    if (
      trackId &&
      window.confirm('Remove this track from the project? The original audio will stay on the disk.')
    )
      run(() => api(`/api/trainer/${selected}/tracks/${trackId}`, 'DELETE'));
  });
  return {
    setActive(v) {
      active = v;
      draw();
    },
    render(next) {
      state = next.trainer || state;
      yueRuns = next.yue2Training || yueRuns;
      const select = document.querySelector('#lora-select'),
        value = select.value;
      const ready = state.projects.filter(p => p.job?.status === 'done' && p.loraName);
      const options =
        `<option value="">No LoRA</option>` +
        ready.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      if (select.innerHTML !== options) {
        select.innerHTML = options;
        select.value = value;
      }
      if (!root.contains(document.activeElement)) draw();
    },
  };
}
