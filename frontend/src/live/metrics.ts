// Per-call conversation metrics, after the turn-taking benchmark (arXiv 2610.12802): does the guide take the
// person's pauses for turn ends, how fast it answers, how much it talks, and how long lookups leave dead air.
// Reported once at the end of the call; backend/bandit.py turns the report into a reward.

export const UTTERANCE_GAP_MS = 1500; // this much silence between guide audio chunks starts a new utterance
export const TAKEOVER_WINDOW_MS = 2000; // interrupted this soon after starting: the guide took a pause for a turn end

export interface Metrics {
  utterances: number;
  takeovers: number;
  turn_latency_ms: number | null; // median, person's last speech to the guide's first audio
  tool_silence_ms: number | null; // median, tool call to the next guide audio
  words: Record<string, { user: number; guide: number }>; // by phase
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function createMetrics(now: () => number = Date.now) {
  let lastAudioAt = -Infinity;
  let utteranceAt = -Infinity;
  let toolCallAt: number | null = null;
  let utterances = 0;
  let takeovers = 0;
  const latencies: number[] = [];
  const silences: number[] = [];
  const text: Record<string, { user: string; guide: string }> = {};

  return {
    // A guide audio chunk. lastSpeechAt: when the mic last heard the person (0 if never).
    audio(lastSpeechAt: number) {
      const t = now();
      if (t - lastAudioAt > UTTERANCE_GAP_MS) {
        utterances++;
        utteranceAt = t;
        // A reply: the person spoke since the guide last made sound, and no lookup sits in between.
        if (lastSpeechAt > lastAudioAt && toolCallAt === null) latencies.push(t - lastSpeechAt);
      }
      lastAudioAt = t;
      if (toolCallAt !== null) {
        silences.push(t - toolCallAt);
        toolCallAt = null;
      }
    },
    toolCall() {
      toolCallAt ??= now();
    },
    interrupted() {
      if (now() - utteranceAt < TAKEOVER_WINDOW_MS) takeovers++;
    },
    transcript(phase: string, role: "user" | "guide", chunk: string) {
      (text[phase] ??= { user: "", guide: "" })[role] += chunk;
    },
    report(): Metrics {
      const words: Metrics["words"] = {};
      for (const [phase, t] of Object.entries(text)) words[phase] = { user: countWords(t.user), guide: countWords(t.guide) };
      return { utterances, takeovers, turn_latency_ms: median(latencies), tool_silence_ms: median(silences), words };
    },
  };
}

export type MetricsTracker = ReturnType<typeof createMetrics>;
