// @codedna
// description: AudioWorklet that captures every channel of the microphone/instrument input in blocks, stamped with the audio clock, for overdub recording in the mixer.
//
// exports: none
// used_by: none
// rules:   Never processes or alters the signal; every block carries the context time of its first sample so the recording can be aligned with the playback timeline, and all the interface's channels so the user can pick which ones to keep.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_rec | Raw multichannel capture worklet.
class SonoraRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.port.onmessage = event => {
      if (event.data === 'stop') this.on = false;
    };
  }
  process(inputs) {
    if (!this.on) return false;
    const input = inputs[0];
    if (!input?.length) return true;
    const channels = input.map(channel => channel.slice());
    this.port.postMessage(
      { time: currentTime, channels },
      channels.map(channel => channel.buffer)
    );
    return true;
  }
}
registerProcessor('sonora-rec', SonoraRec);
