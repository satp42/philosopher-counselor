const CHUNK = 512;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.bufferIndex++] = Math.max(-1, Math.min(1, channel[i])) * 0x7fff;
        if (this.bufferIndex >= CHUNK) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Int16Array(CHUNK);
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
