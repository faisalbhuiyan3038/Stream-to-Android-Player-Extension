// AudioWorklet processor "sap-fx" (bundled to audio-worklet.bundle.js): runs the audio effects
// of src/audio-dsp.mjs on the audio thread. Messages from the page:
//   { params }       resolved parameters (resolveParams)
//   { report: bool } post the state (leveler gain, channels, …) about 4× a second
//   { end: true }    stop: the node is being dropped
import { AudioFx } from './audio-dsp.mjs';

class SapFx extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.fx = new AudioFx(sampleRate);
    const init = options && options.processorOptions && options.processorOptions.params;
    if (init) this.fx.setParams(init);
    this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 4));
    this.count = 0;
    this.report = false;
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.params) this.fx.setParams(m.params);
      if ('report' in m) this.report = !!m.report;
      if (m.end) this.alive = false;
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || new Float32Array(l.length);
    this.fx.process(inputs[0], l, r);
    if (this.report && ++this.count >= this.reportEvery) {
      this.count = 0;
      this.port.postMessage(this.fx.state());
    }
    return true;
  }
}

registerProcessor('sap-fx', SapFx);
