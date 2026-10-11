const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export function initLoraTrainer({ api, toast }) {
  const root = document.querySelector('#lora-trainer');
  let state = { projects: [] },
    selected = '',
    active = false,
    busy = false;
  const openHelp = new Set();
  const helpTopics = [
    ['start', '1. Full workflow', `<ol><li>Choose one goal: a singing voice or a musical style.</li><li>Prepare representative 10–30 second excerpts.</li><li>Select <strong>Create project</strong>, name the LoRA, and upload your audio.</li><li>For each track, choose Vocals or Instrumental, add a description and exact lyrics when needed, then select <strong>Save annotations</strong>.</li><li>Set the epoch count, select <strong>Start training</strong>, and follow the project status.</li><li>When the LoRA is ready, choose RunPod in <strong>Create music</strong> and select it from the LoRA menu.</li><li>Generate a short sample and compare it with one made without the LoRA.</li></ol>`],
    ['purpose', '2. What a LoRA learns', `<p>A LoRA is an adapter for the ACE-Step 1.5 XL Turbo music model. It can guide generation toward recurring traits in your examples. It is not an audio sample inserted into a track and cannot guarantee an exact reproduction of a person.</p><p><strong>Voice:</strong> use sung examples from the same singer. Speech recordings alone cannot guarantee an equivalent singing voice. Isolated vocals can be useful, but listen to the results; distinctive backing instruments may also be learned.</p><p><strong>Style:</strong> use instrumental tracks or songs with consistent arrangements. Instrumental examples do not teach a voice. Create separate projects for different voices and styles. Use audio you own or have permission to train on.</p>`],
    ['audio', '3. Audio requirements and limits', `<p>The trainer uses <strong>only the first 30 seconds of each file</strong>. Trim your audio first if the useful section starts later.</p><ul><li>Each file must be 10 seconds to 5 minutes long; 10–30 second excerpts avoid unused audio.</li><li>Limit: 20 tracks, 100 MB per file and 200 MB per project.</li><li>WAV, MP3, FLAC, OGG and M4A are accepted. Training audio is prepared as 48 kHz stereo WAV. Originals stay on disk.</li></ul><p>Choose clear recordings without distortion, long silences or dominant noise. For a voice, include varied phrases and registers from the same singer. For a style, include sections that show its instruments, rhythm and mood. Repeating the same excerpt adds no variety.</p><p>One track is enough for a technical check, but not proof that the model learned a voice or style. The trainer cannot remove stems or change an excerpt; create a new project if your examples need revision.</p>`],
    ['notes', '4. Captions and lyrics', `<p>Describe what is actually audible: instruments, genre, rhythm, tone, singing style and mood. The project name is a menu label; the model does not learn it as a special word.</p><p><strong>Vocal example:</strong> “Soft female mid-range voice, intimate singing with little vibrato, piano accompaniment, slow ballad.”</p><p><strong>Instrumental example:</strong> “Fingerpicked acoustic guitar, warm bass and light drums, steady rhythm, intimate mood.” Do not guess BPM or key.</p><p>For <strong>Vocals</strong>, enter the exact words sung in the excerpt, in order. Do not paste full-track lyrics when training uses only 30 seconds. For <strong>Instrumental</strong>, leave lyrics blank. Automatic transcription is unavailable; check and save each track's annotations yourself.</p>`],
    ['epochs', '5. Choosing epochs', `<p>An epoch is one pass through the prepared examples. More epochs increase training work but do not guarantee better results and can overfit the model.</p><ul><li><strong>1 epoch:</strong> a technical upload and generation check, not a measure of vocal quality.</li><li><strong>20 epochs:</strong> the default; evaluate it by listening to your own material.</li><li><strong>1–100:</strong> allowed range. A job can stop at its time limit before finishing all epochs.</li></ul><p>Use separate projects to compare settings. Each new run starts from the base model; it does not continue the previous run and can replace that project's adapter. Existing tracks remain in your library.</p>`],
    ['cost', '6. GPU usage, cost and time', `<p>Creating a project and uploading audio do not start GPU training. Selecting <strong>Start training</strong> sends the dataset to RunPod, prepares examples and trains the model. These actions can use GPU credits.</p><p>The trainer starts its own worker; you do not need to start a generation GPU session. Finish any generation jobs first. Sonora prevents generation and training from running at the same time.</p><p>Each job is limited to <strong>30 minutes</strong>. Dataset transfer and GPU wait time add to the total; this does not promise completion within 30 minutes of clicking. Startup may take several minutes and GPU availability varies.</p><p>The trainer returns to zero permanent workers after a job. <strong>Persistent storage continues to cost money</strong> while the volume exists. Check your balance and rates in RunPod; Sonora does not estimate charges or set a spending limit.</p>`],
    ['states', '7. Job status and recovery', `<dl><dt>GPU startup and dataset transfer</dt><dd>Examples are sent through the authenticated RunPod API. Worker startup may take time.</dd><dt>Waiting for a GPU</dt><dd>The request is registered and waiting for a worker. Do not submit it again.</dd><dt>Preparing data and training</dt><dd>The worker prepares examples and trains the model. Epoch progress is not shown.</dd><dt>LoRA ready</dt><dd>The adapter is available in the generation selector.</dd><dt>Training stopped or cancelled</dt><dd>Read the project message. Audio stays on disk; a partial checkpoint is not a selectable LoRA.</dd><dt>Uncertain receipt</dt><dd>Sonora cannot tell whether RunPod accepted the job. Check the RunPod console before starting another; Sonora will not resubmit automatically.</dd></dl><p><strong>Cancel training</strong> appears when a RunPod receipt is available. Wait for the final status; cancellation does not refund credits already used.</p><p>Closing the browser does not cancel the job or stop GPU charges. Return to this section to check status or cancel the job.</p><p>The dataset is locked while a job runs. After a restart, Sonora checks registered jobs without duplicating them. An interrupted transfer can be retried only when status confirms that no training job was submitted. Checkpoints stay on the volume, but this interface cannot resume from one.</p>`],
    ['use', '8. Evaluating the model', `<p>In <strong>Create music</strong>, choose <strong>RunPod</strong> and select the project in the <strong>LoRA</strong> menu. Incomplete models are hidden. Add a music description and lyrics as usual; the LoRA does not replace those fields. This integration supports Sonora's XL Turbo model, not local ComfyUI.</p><p>Compare a short sample with and without the LoRA, keeping lyrics, style, duration and seed the same. Listen for tone, pronunciation, instrument consistency, noise and repetition. Then test different lyrics or a melody not present in the examples. One good result does not prove good generalization.</p><p>If the effect is weak, review example consistency and annotation accuracy before increasing epochs. If the output repeats examples or loses quality, try fewer epochs in a new project. LoRA strength is fixed in this version. Download generated tracks from the library as <strong>MP3 or WAV</strong>.</p>`],
  ];
  const helpSection = (id, title, content) =>
    `<details class="trainer-help-topic" data-trainer-help="${id}" ${openHelp.has(id) ? 'open' : ''}><summary>${title}</summary><div>${content}</div></details>`;
  const help = () =>
    `<details class="trainer-guide" data-trainer-help="guide" ${openHelp.has('guide') ? 'open' : ''}><summary>Complete guide · from audio to a LoRA track</summary><div class="trainer-guide-content"><p>This guide explains the features currently available in Sonora. Open the sections you need.</p>${helpTopics.map(t => helpSection(...t)).join('')}<p class="trainer-guide-sources">More information: <a href="https://ace-step.github.io/ACE-Step-1.5/en/LoRA_Training_Tutorial" target="_blank" rel="noopener noreferrer">ACE-Step guide</a> · <a href="https://www.runpod.io/pricing" target="_blank" rel="noopener noreferrer">RunPod pricing</a>. Provider documentation may describe options Sonora does not expose.</p></div></details>`;
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
    uploading: 'GPU startup and dataset transfer',
    queued: 'Waiting for a GPU',
    running: 'Preparing data and training',
    done: 'LoRA ready',
    failed: 'Training failed',
    cancelled: 'Cancelled',
    uncertain: 'Uncertain receipt · check RunPod',
    submitting: 'Submitting',
    cancelling: 'Cancelling',
  };
  function draw() {
    if (!active || busy) return;
    const p = state.projects.find(p => p.id === selected) || state.projects[0];
    if (p) selected = p.id;
    root.innerHTML = `<div class="section-eyebrow">PERSONAL VOICE AND STYLE</div><h1>LoRA Trainer</h1><p>Upload music examples with lyrics or captions. Training uses your RunPod GPU endpoint for up to 30 minutes. Speech alone cannot guarantee a singing voice clone.</p>${help()}${!state.configured ? '<p class="error">Training endpoint is not configured. You can prepare and annotate a dataset.</p>' : ''}<form id="trainer-create"><label>LoRA name<input name="name" maxlength="100" required placeholder="My style"></label><button class="pill-button">Create project</button></form><label>Project<select id="trainer-project">${state.projects.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>${p ? `<h2>${esc(p.name)}</h2><p>${esc(labels[p.job?.status] || 'Dataset to prepare')} · ${p.tracks.length} ${p.tracks.length === 1 ? 'track' : 'tracks'}</p>${p.job?.error ? `<p class="error">${esc(p.job.error)}</p>` : ''}<label>Upload WAV, MP3 or FLAC<input id="trainer-files" type="file" accept="audio/*" multiple></label><p>10 seconds to 5 minutes per track; 100 MB per file and 200 MB per project. Training uses the first 30 seconds of each example, so upload representative excerpts. Originals are kept.</p>${p.tracks.map(t => `<form class="trainer-track" data-track="${t.id}"><h3>${esc(t.name)} · ${Math.round(t.duration)} s</h3><label>Track type<select name="instrumental"><option value="true" ${t.instrumental ? 'selected' : ''}>Instrumental</option><option value="false" ${!t.instrumental ? 'selected' : ''}>Vocals</option></select></label><label>Style or voice description<textarea name="caption" maxlength="3000" required>${esc(t.caption)}</textarea></label><label>Exact lyrics in this excerpt<textarea name="lyrics" maxlength="12000">${esc(t.lyrics)}</textarea></label><button class="pill-button">Save annotations</button></form>`).join('')}<form id="trainer-start"><label>Epochs<input name="epochs" type="number" value="20" min="1" max="100" required></label><p>Training uses GPU credits. Start with a short run; you can cancel it. Any checkpoints remain on storage.</p><button class="pill-button" ${!state.configured || !p.tracks.length || (p.job && !['done', 'failed', 'cancelled'].includes(p.job.status)) ? 'disabled' : ''}>Start training · up to 30 min</button></form>${(p.job?.remoteId || p.job?.uploadRemoteId) && !['done', 'failed', 'cancelled'].includes(p.job.status) ? '<button id="trainer-cancel" class="pill-button">Cancel training</button>' : ''}` : ''}`;
  }
  async function run(task) {
    if (busy) return;
    busy = true;
    root.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      state = await task();
      toast('Progetto aggiornato.');
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
    if (f.id === 'trainer-create') run(() => api('/api/trainer/projects', 'POST', b));
    else if (f.id === 'trainer-start')
      run(() => api(`/api/trainer/${selected}/start`, 'POST', { epochs: Number(b.epochs) }));
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
  });
  return {
    setActive(v) {
      active = v;
      draw();
    },
    render(next) {
      state = next.trainer || state;
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
