import { describe, expect, it } from "vitest";

import { createMetrics } from "./metrics";

describe("metrics", () => {
  it("scores takeovers, latency, tool silence and words per phase", () => {
    let t = 0;
    const m = createMetrics(() => t);
    m.transcript("listen", "user", "I am torn ");
    m.transcript("listen", "user", "between two cities");
    m.transcript("listen", "guide", "Tell me more");
    // Reply 1: person last spoke at 1000, guide audio at 1800 → 800ms latency; chunks 200ms apart stay one utterance.
    t = 1800;
    m.audio(1000);
    t = 2000;
    m.audio(1000);
    // Interrupted 500ms in: the guide took a pause for a turn end.
    t = 2300;
    m.interrupted();
    // Reply 2 after a lookup: not a latency sample, but 4s of tool silence.
    t = 5000;
    m.toolCall();
    t = 9000;
    m.audio(4000);
    // Interrupted long after an utterance started is a normal barge-in, not a takeover.
    t = 14_000;
    m.interrupted();
    // Reply 3, person spoke at 15_000 → 1200ms.
    t = 16_200;
    m.audio(15_000);
    expect(m.report()).toEqual({
      utterances: 3,
      takeovers: 1,
      turn_latency_ms: 1000,
      tool_silence_ms: 4000,
      words: { listen: { user: 6, guide: 3 } },
    });
  });

  it("reports nulls for an empty call", () => {
    expect(createMetrics().report()).toEqual({ utterances: 0, takeovers: 0, turn_latency_ms: null, tool_silence_ms: null, words: {} });
  });
});
