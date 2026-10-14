import { postJson } from "../api";
import { CONVERSING, type CallStore } from "../state/callStore";

export type Role = "user" | "guide";
export type RecorderEvent = { type: string; [key: string]: unknown };
type Sequenced = RecorderEvent & { seq: number };

export interface RecorderDeps {
  callId: string;
  store: CallStore;
  onCallEnded(): void;
  post?(path: string, body: unknown): Promise<{ ok: boolean; status: number }>;
  beacon?(path: string, body: unknown): boolean;
}

const now = () => Date.now() / 1000;
// Under the server's 64KB cap, so a backlog requeued after a 5xx never gets a permanent 413.
export const MAX_BATCH_BYTES = 48 * 1024;
const encoder = new TextEncoder();
const size = (e: Sequenced) => encoder.encode(JSON.stringify(e)).length + 1;

export const sendBeacon = (path: string, body: unknown) =>
  navigator.sendBeacon(path, new Blob([JSON.stringify(body)], { type: "application/json" }));

export function createRecorder({ callId, store, onCallEnded, post = postJson, beacon = sendBeacon }: RecorderDeps) {
  const path = `/api/calls/${callId}/events`;
  let seq = 0;
  let queue: Sequenced[] = [];
  let sending: Sequenced[] = [];
  let inflight: Promise<void> | null = null;
  let stopped = false;
  const turns: Partial<Record<Role, { text: string; ts: number }>> = {};

  function record(event: RecorderEvent) {
    if (!stopped) queue.push({ seq: ++seq, ...event });
  }

  function appendTranscript(role: Role, text: string) {
    (turns[role] ??= { text: "", ts: now() }).text += text;
  }

  function closeTurns() {
    for (const role of ["user", "guide"] as const) {
      const turn = turns[role];
      if (turn?.text.trim()) record({ type: "turn", role, text: turn.text.trim(), ts: turn.ts });
      delete turns[role];
    }
  }

  async function drain() {
    while (!stopped && queue.length) {
      let n = 0;
      for (let bytes = 0; n < queue.length; n++) {
        bytes += size(queue[n]);
        if (n && bytes > MAX_BATCH_BYTES) break;
      }
      sending = queue.splice(0, n);
      try {
        const res = await post(path, { events: sending });
        if (res.status === 409) return stop(true);
        if (res.status >= 500) throw new Error(`events ${res.status}`);
        if (!res.ok) console.warn(`call: events rejected with ${res.status}`);
      } catch {
        queue = [...sending, ...queue];
        return;
      } finally {
        sending = [];
      }
    }
  }

  // ponytail: one batch in flight, since the server only keeps the highest seq; buffer gaps server-side to parallelize.
  function flush() {
    inflight ??= drain().finally(() => (inflight = null));
    return inflight;
  }

  // The in-flight batch rides along, or a beacon overtaking it would strand it behind the server's seq watermark.
  function sendFinal() {
    closeTurns();
    const events = [...sending, ...queue];
    if (stopped || !events.length) return;
    if (beacon(path, { events })) queue = [];
  }

  const onVisibility = () => document.visibilityState === "hidden" && sendFinal();

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.status === prev.status || !(CONVERSING.has(s.status) || s.status === "ending")) return;
    record({ type: "phase", phase: s.status, ts: now() });
    void flush();
  });

  window.addEventListener("pagehide", sendFinal);
  document.addEventListener("visibilitychange", onVisibility);

  function stop(callEnded = false) {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    window.removeEventListener("pagehide", sendFinal);
    document.removeEventListener("visibilitychange", onVisibility);
    if (callEnded) onCallEnded();
  }

  return {
    record,
    appendTranscript,
    closeTurn() {
      closeTurns();
      return flush();
    },
    flush,
    async end() {
      closeTurns();
      await flush();
      for (let i = 1; i <= 2 && queue.length && !stopped; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500 * i));
        await flush();
      }
      sendFinal();
      stop();
    },
    stop: () => stop(),
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
