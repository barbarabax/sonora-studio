import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, buildWorkflow, withoutInstrumentalWords } from '../lib.mjs';

test('guidance and creativity are validated, defaulted and sent to the language model', () => {
  const base = { tags: 'pop', instrumental: true, duration: 30 };
  const input = validateInput(base);
  assert.equal(input.guidance, 2);
  assert.equal(input.creativity, 0.85);
  const id = '11111111-1111-4111-8111-111111111111';
  const config = { model: 'm', encoder: 'e', planner: 'p', vae: 'v' };
  const graph = buildWorkflow(validateInput({ ...base, guidance: 3.5, creativity: 1.1 }), 1, id, config);
  assert.equal(graph[4].inputs.cfg_scale, 3.5);
  assert.equal(graph[4].inputs.temperature, 1.1);
  assert.throws(() => validateInput({ ...base, guidance: 9 }), /guidance/);
  assert.throws(() => validateInput({ ...base, creativity: 0.1 }), /creativity/);
});

test('remix and final quality shape the graph: encoded source as latent, partial denoise, SFT steps and guidance', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const config = { model: 'turbo.safetensors', encoder: 'e', planner: 'p', vae: 'v' };
  const base = validateInput({ tags: 'pop', instrumental: true, duration: 30 });
  const turbo = buildWorkflow(base, 1, id, config);
  assert.equal(turbo[8].inputs.steps, 8);
  assert.equal(turbo[8].inputs.cfg, 1);
  assert.equal(turbo[8].inputs.denoise, 1);
  const remix = buildWorkflow(base, 1, id, config, null, { audio: `Sonora/${id}.mp3`, denoise: 0.6 });
  assert.deepEqual(remix[8].inputs.latent_image, ['13', 0]);
  assert.equal(remix[8].inputs.denoise, 0.6);
  assert.equal(remix[4].inputs.generate_audio_codes, false);
  assert.equal(remix[12].inputs.audio, `Sonora/${id}.mp3`);
  const final = buildWorkflow({ ...base, finish: 'final' }, 1, id, config);
  assert.equal(final[8].inputs.steps, 50);
  assert.equal(final[8].inputs.cfg, 7);
  assert.match(final[1].inputs.unet_name, /xl_sft/);
  assert.throws(
    () => buildWorkflow(base, 1, id, config, null, { audio: '../x.mp3', denoise: 0.5 }),
    /source audio/
  );
  assert.throws(
    () => buildWorkflow(base, 1, id, config, null, { audio: `Sonora/${id}.mp3`, denoise: 1 }),
    /Invalid strength/
  );
  assert.throws(() => validateInput({ tags: 'pop', instrumental: true, finish: 'x' }));
});

test('a style that says no vocals is cleaned before an instrumental becomes a sung remix', () => {
  assert.equal(
    withoutInstrumentalWords('indie rock, instrumental storytelling, no vocals, distorted electric guitar'),
    'indie rock, distorted electric guitar'
  );
  assert.equal(withoutInstrumentalWords('lo-fi, without vocals, vocalless, warm pads'), 'lo-fi, warm pads');
  // phrases about instrumental passages stay: the song can still have a solo
  assert.equal(withoutInstrumentalWords('pop, instrumental break, bright synths'), 'pop, instrumental break, bright synths');
  assert.equal(withoutInstrumentalWords('Instrumental, no vocals'), 'vocal song', 'never an empty style');
});
