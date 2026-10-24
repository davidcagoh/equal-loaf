class BosonPushToTalkCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetSampleRate ?? 24_000;
    this.inputRate = sampleRate;
    this.inputPosition = 0;
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    const step = this.inputRate / this.targetRate;
    const samples = [];
    while (this.inputPosition < input.length) {
      const left = Math.floor(this.inputPosition);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = this.inputPosition - left;
      samples.push(input[left] + ((input[right] - input[left]) * fraction));
      this.inputPosition += step;
    }
    this.inputPosition -= input.length;
    if (samples.length) {
      const resampled = Float32Array.from(samples);
      this.port.postMessage(resampled, [resampled.buffer]);
    }
    return true;
  }
}

registerProcessor('boson-ptt-capture', BosonPushToTalkCapture);
