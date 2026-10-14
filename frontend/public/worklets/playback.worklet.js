class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioQueue = [];
    this.currentOffset = 0;
    this.port.onmessage = (event) => {
      if (event.data === "interrupt") {
        this.audioQueue = [];
        this.currentOffset = 0;
      } else if (event.data instanceof Float32Array) {
        this.audioQueue.push(event.data);
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output.length === 0) return true;
    const channel = output[0];
    let outputIndex = 0;

    while (outputIndex < channel.length && this.audioQueue.length > 0) {
      const current = this.audioQueue[0];
      if (!current || current.length === 0) {
        this.audioQueue.shift();
        this.currentOffset = 0;
        continue;
      }
      const copyLength = Math.min(channel.length - outputIndex, current.length - this.currentOffset);
      for (let i = 0; i < copyLength; i++) channel[outputIndex++] = current[this.currentOffset++];
      if (this.currentOffset >= current.length) {
        this.audioQueue.shift();
        this.currentOffset = 0;
      }
    }

    while (outputIndex < channel.length) channel[outputIndex++] = 0;
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
