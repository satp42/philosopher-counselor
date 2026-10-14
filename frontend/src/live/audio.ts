import type { Levels } from "../components/VoiceOrb";

const CAPTURE_RATE = 16_000;
const PLAYBACK_RATE = 24_000;
// ponytail: fixed gain maps speech RMS (~0.05-0.25) onto the orb's 0-1 range; tune by ear.
const LEVEL_GAIN = 4;
// ponytail: fixed RMS floor for "the person is speaking" (metrics only); a VAD if room noise ever trips it.
const SPEECH_RMS = 0.02;

export interface AudioIO {
  unlock(): void;
  openMic(onChunk: (base64: string) => void, onLost: (lost: boolean) => void): Promise<void>;
  closeMic(): void;
  play(base64: string): void;
  flush(): void;
  pendingMs(): number;
  levels(): Levels;
  lastSpeechAt(): number; // Date.now() of the last mic chunk above the speech floor, 0 if none
}

function rms(samples: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

// fromCharCode takes the bytes as arguments, so go in chunks well under the engine's argument limit.
function toBase64(pcm: Int16Array) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

function fromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  return Float32Array.from(pcm, (x) => x / 32768);
}

export function createAudio(): AudioIO {
  let capture: AudioContext | null = null;
  let playback: AudioContext | null = null;
  let captureNode: Promise<AudioWorkletNode>;
  let playbackNode: Promise<AudioWorkletNode>;
  let analyser: AnalyserNode | null = null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let input = 0;
  let lastSpeech = 0;
  let queuedUntil = 0;
  const frame = new Float32Array(1024);

  const closeMic = () => {
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    source = stream = null;
    input = 0;
  };

  return {
    // Must run synchronously inside a click handler (autoplay rules).
    unlock() {
      if (capture && playback) {
        void capture.resume();
        void playback.resume();
        return;
      }
      capture = new AudioContext({ sampleRate: CAPTURE_RATE });
      playback = new AudioContext({ sampleRate: PLAYBACK_RATE });
      const cap = capture;
      const out = playback;
      captureNode = cap.audioWorklet
        .addModule("/worklets/capture.worklet.js")
        .then(() => new AudioWorkletNode(cap, "audio-capture-processor"));
      playbackNode = out.audioWorklet.addModule("/worklets/playback.worklet.js").then(() => {
        const node = new AudioWorkletNode(out, "pcm-processor");
        analyser = out.createAnalyser();
        analyser.fftSize = frame.length;
        node.connect(analyser).connect(out.destination);
        return node;
      });
    },

    async openMic(onChunk, onLost) {
      closeMic();
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const [track] = s.getAudioTracks();
      track.onended = () => onLost(true);
      track.onmute = () => onLost(true);
      track.onunmute = () => onLost(false);
      const node = await captureNode;
      node.port.onmessage = (e: MessageEvent<Int16Array>) => {
        input = rms(e.data) / 0x8000;
        if (input > SPEECH_RMS) lastSpeech = Date.now();
        onChunk(toBase64(e.data));
      };
      stream = s;
      source = capture!.createMediaStreamSource(s);
      source.connect(node);
    },

    closeMic,

    play(base64) {
      const samples = fromBase64(base64);
      if (playback) queuedUntil = Math.max(queuedUntil, playback.currentTime) + samples.length / PLAYBACK_RATE;
      void playbackNode?.then((node) => node.port.postMessage(samples, [samples.buffer]));
    },

    flush() {
      queuedUntil = 0;
      void playbackNode?.then((node) => node.port.postMessage("interrupt"));
    },

    pendingMs: () => (playback ? Math.max(0, queuedUntil - playback.currentTime) * 1000 : 0),

    lastSpeechAt: () => lastSpeech,

    levels() {
      let output = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(frame);
        output = rms(frame);
      }
      return { input: Math.min(1, input * LEVEL_GAIN), output: Math.min(1, output * LEVEL_GAIN) };
    },
  };
}
