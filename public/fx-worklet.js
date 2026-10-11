// @codedna
// description: AudioWorklet that runs the shared effects processor (compressor, distortion, wah, envelope filter, chorus, flanger) in the mixer preview.
//
// exports: none
// used_by: none
// rules:   Contains no DSP of its own: everything comes from dsp-fx.mjs, the same module the server uses for the export, so preview and export match.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_dsp | Thin wrapper with parameter messages and a gain-reduction meter.
import { createFxProcessor } from './dsp-fx.mjs';

class SonoraFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fx = createFxProcessor(sampleRate);
    this.since = 0;
    this.port.onmessage = event => {
      if (event.data.params) this.fx.setParams(event.data.params, event.data.bpm);
      if (event.data.reset) this.fx.reset();
    };
  }
  process(inputs, outputs) {
    const input = inputs[0],
      output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const left = output[0],
      right = output[1] || output[0];
    left.set(input[0]);
    right.set(input[1] || input[0]);
    this.fx.process(left, right, left.length);
    this.since += left.length;
    if (this.since >= 4096) {
      this.since = 0;
      this.port.postMessage({ reduction: this.fx.takeReduction() });
    }
    return true;
  }
}
registerProcessor('sonora-fx', SonoraFx);
