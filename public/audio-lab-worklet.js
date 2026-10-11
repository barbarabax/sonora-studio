// @codedna
// description: Real-time Audio Lab compressor: the same stereo-linked envelope follower as audio_lab_dsp.compress.
// exports: none
// used_by: none
// related: public/audio-lab-ui.mjs (loaded dynamically through AudioWorklet)
// rules:   Keep the per-sample math identical to audio_lab_dsp._compressor_gain.
// agent:   Claude - 2026-10-04 - Real-time Audio Lab chain matching the offline master.
class SonoraCompressor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.envelope = 0;
    // [threshold dB, ratio, attack ms, release ms] or null for off. The initial preset comes with the
    // constructor so offline renders are compressed from the first sample; later changes use the port.
    const set = data => {
      this.preset = data && {
        threshold: 10 ** (data[0] / 20),
        ratio: data[1],
        attack: Math.exp(-1 / ((sampleRate * data[2]) / 1000)),
        release: Math.exp(-1 / ((sampleRate * data[3]) / 1000)),
      };
    };
    set(options?.processorOptions?.preset || null);
    this.port.onmessage = ({ data }) => set(data);
  }
  process(inputs, outputs) {
    const input = inputs[0],
      output = outputs[0];
    if (!input.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    const p = this.preset,
      frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let gain = 1;
      if (p) {
        let level = 0;
        for (const channel of input) level = Math.max(level, Math.abs(channel[i]));
        const coeff = level > this.envelope ? p.attack : p.release;
        this.envelope = coeff * this.envelope + (1 - coeff) * level;
        if (this.envelope > p.threshold)
          gain = (p.threshold + (this.envelope - p.threshold) / p.ratio) / this.envelope;
      }
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] ?? input[0])[i] * gain;
    }
    return true;
  }
}
registerProcessor('sonora-compressor', SonoraCompressor);
