import type { LiveServerMessage, Session } from "@google/genai";

import { fetchJson, HttpError } from "../api";
import type { CallStore } from "../state/callStore";
import type { AudioIO } from "./audio";
import { createMetrics, type MetricsTracker } from "./metrics";
import { createRecorder, type Recorder, type RecorderDeps } from "./recorder";
import { createDispatcher, withTimeout, type Dispatcher } from "./tools";

export const ROTATE_AFTER_MS = 9 * 60_000;
export const FORCE_ROTATE_MS = 9 * 60_000 + 40_000;
export const RETRY_WINDOW_MS = 30_000;
export const SETUP_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 5 * 60_000;
export const OPEN_TIMEOUT_MS = 15_000;
export const GOODBYE_MS = 4_000;
const HOLD_MAX = (10 * 16_000 * 2 * 4) / 3; // ~10s of 16kHz PCM16, base64
const MIME = "audio/pcm;rate=16000";
const LOST = "The connection couldn't be restored, so the call ended. Your page is being written from what was said.";
const LIMIT =
  "This call ran out of connection time, so it ended. Your page is being written from what was said. You can start a new call.";

export type LiveSession = Pick<Session, "sendRealtimeInput" | "sendClientContent" | "sendToolResponse" | "close">;

export interface LiveCallbacks {
  onmessage(message: LiveServerMessage): void;
  onclose(event: { code: number; reason: string }): void;
}

export type Connect = (opts: {
  token: string;
  model: string;
  apiVersion: string;
  callbacks: LiveCallbacks;
}) => Promise<LiveSession>;

export const liveConnect: Connect = async ({ token, model, apiVersion, callbacks }) => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion } });
  return ai.live.connect({ model, config: {}, callbacks });
};

export interface EngineDeps {
  store: CallStore;
  audio: AudioIO;
  connect?: Connect;
  fetchJson?: (path: string, body?: unknown) => Promise<any>;
  post?: RecorderDeps["post"];
  notify?(message: string): void;
  onCallEnded?(callId: string): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCallEngine({
  store,
  audio,
  connect = liveConnect,
  fetchJson: request = fetchJson,
  post,
  notify = console.warn,
  onCallEnded = () => {},
}: EngineDeps) {
  const get = store.getState;
  let session: LiveSession | null = null;
  let conn = 0;
  let call = 0;
  let handle: string | null = null;
  let recorder: Recorder;
  let dispatcher: Dispatcher;
  let metrics: MetricsTracker;
  let busy = false;
  let ended = true;
  let paused = true;
  let reconnecting = false;
  let rotateDue = false;
  let sawIdle = false;
  let held: string[] = [];
  let heldSize = 0;
  let unsubscribe = () => {};
  let timers: ReturnType<typeof setTimeout>[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const setMicLost = (micLost: boolean) => store.setState({ micLost });

  function sendAudio(data: string) {
    if (get().muted) return;
    if (session && !paused) session.sendRealtimeInput({ audio: { data, mimeType: MIME } });
    // A quiet rotation keeps what the person says for the new session; a visible reconnect shows the mic paused.
    else if (reconnecting && get().connection === "live" && heldSize < HOLD_MAX) {
      held.push(data);
      heldSize += data.length;
    }
  }

  function dropSession() {
    conn++;
    timers.forEach(clearTimeout);
    timers = [];
    session?.close();
    session = null;
  }

  function contextTurn() {
    const { summary, leaning, lensPlan, status, crisis } = get();
    const lenses = lensPlan.map((l) => `${l.tradition} (${l.stance})`).join("; ") || "none yet";
    const care = crisis ? " The person is in crisis: this call is care-only, with no philosophy, lenses or lookups." : "";
    const text =
      `[Context — do not respond] The connection was briefly restored. Situation so far: ${summary || "not yet summarized"}. ` +
      `Leaning: ${leaning || "unclear"}. Lens plan: ${lenses}.${care} Current phase: ${status}.`;
    return { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false };
  }

  function onMessage(m: LiveServerMessage) {
    const update = m.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) handle = update.newHandle;
    if (m.goAway) void reconnect(true);

    const calls = m.toolCall?.functionCalls;
    if (calls?.length) {
      metrics.toolCall();
      void dispatcher.dispatch(calls.map((c) => ({ id: c.id ?? "", name: c.name ?? "", args: c.args })));
    }
    if (m.toolCallCancellation?.ids) dispatcher.cancel(m.toolCallCancellation.ids);

    const content = m.serverContent;
    if (!content) return;
    for (const part of content.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      metrics.audio(audio.lastSpeechAt());
      audio.play(part.inlineData.data);
      if (get().consulting && !dispatcher.consulting()) store.setState({ consulting: false });
    }
    for (const [role, text] of [
      ["user", content.inputTranscription?.text],
      ["guide", content.outputTranscription?.text],
    ] as const) {
      if (!text) continue;
      recorder.appendTranscript(role, text);
      metrics.transcript(get().status, role, text);
    }
    if (content.interrupted) {
      metrics.interrupted();
      audio.flush();
      void recorder.closeTurn();
    }
    if ((content.interactionStatus as string) === "IDLE") {
      sawIdle = true;
      void recorder.closeTurn();
      if (rotateDue) void reconnect(true);
    }
  }

  // Tokens are single-use with a 1-minute new-session window, so every connection mints right before connecting.
  async function open() {
    const my = ++conn;
    const stale = () => my !== conn;
    const { token, model, api_version } = await request("/api/token", {
      call_id: get().callId,
      resumption_handle: handle,
    });
    if (stale()) throw new Error("superseded");
    let up = false;
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const setup = new Promise<void>((res, rej) => ((ready = res), (failed = rej)));
    setup.catch(() => {});
    const s = await connect({
      token,
      model,
      apiVersion: api_version,
      callbacks: {
        onmessage(m) {
          if (stale()) return;
          if (m.setupComplete) {
            up = true;
            ready();
          }
          onMessage(m);
        },
        // Before setup the opener's own retry handles a close.
        onclose(e) {
          if (stale()) return;
          failed(new Error(`live closed ${e.code} ${e.reason}`));
          if (up) void reconnect(false);
        },
      },
    });
    if (stale()) {
      s.close();
      throw new Error("superseded");
    }
    session = s;
    try {
      await withTimeout(setup, SETUP_TIMEOUT_MS);
    } catch (e) {
      if (!stale()) dropSession();
      throw e;
    }
    // Token connections are hard-cut at 10:00 with no goAway, so rotate first.
    rotateDue = false;
    timers = [
      setTimeout(() => (rotateDue = true), ROTATE_AFTER_MS),
      setTimeout(() => void reconnect(true), FORCE_ROTATE_MS),
    ];
  }

  async function connectWithRetry() {
    const me = call;
    const over = () => ended || me !== call;
    const deadline = Date.now() + RETRY_WINDOW_MS;
    for (let delay = 500; !over(); delay = Math.min(delay * 2, 4000)) {
      try {
        await withTimeout(open(), OPEN_TIMEOUT_MS);
        return !over();
      } catch (e) {
        if (over()) return false;
        // The call's token budget is spent; retrying can't help.
        if (e instanceof HttpError && e.status === 429) {
          await finish(true, { notice: LIMIT });
          return false;
        }
        console.warn("live: connect failed", e);
        dropSession();
      }
      store.setState({ connection: "reconnecting" });
      if (Date.now() + delay > deadline) {
        await finish(true);
        return false;
      }
      await sleep(delay);
    }
    return false;
  }

  async function reconnect(quiet: boolean) {
    if (reconnecting || ended) return;
    const me = call;
    reconnecting = true;
    paused = true;
    if (!quiet) store.setState({ connection: "reconnecting" });
    dropSession();
    dispatcher.newSession();
    const ok = await connectWithRetry();
    if (me !== call) return;
    reconnecting = false;
    const replay = held;
    held = [];
    heldSize = 0;
    if (!ok) return;
    // A resume that didn't take is silent, so always re-seed the context before the mic resumes.
    session!.sendClientContent(contextTurn());
    for (const data of replay) session!.sendRealtimeInput({ audio: { data, mimeType: MIME } });
    paused = false;
    if (get().connection === "reconnecting") notify("Reconnected. The call continues.");
    store.setState({ connection: "live" });
  }

  async function finish(interrupted: boolean, { goodbye = false, notice = LOST } = {}) {
    if (ended) return;
    ended = true;
    paused = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (goodbye) {
      sawIdle = false;
      for (let waited = 0; waited < GOODBYE_MS && !(sawIdle && audio.pendingMs() === 0); waited += 100) await sleep(100);
    }
    dropSession();
    audio.flush();
    audio.closeMic();
    const callId = get().callId!;
    if (interrupted) {
      recorder.record({ type: "flag", flag: "interrupted" });
      notify(notice);
    }
    store.setState({ consulting: false, micLost: false, muted: false });
    get().transition("ending");
    recorder.record({ type: "metrics", metrics: metrics.report() });
    await recorder.end();
    await request(`/api/calls/${callId}/end`, { interrupted }).catch((e) => console.warn("call: end failed", e));
    get().transition("generating");
    onCallEnded(callId);
  }

  async function begin(callId: string) {
    dropSession();
    call++;
    ended = false;
    paused = true;
    reconnecting = false;
    handle = null;
    held = [];
    heldSize = 0;
    metrics = createMetrics();
    recorder = createRecorder({ callId, store, post, onCallEnded: () => void finish(false) });
    dispatcher = createDispatcher({
      store,
      sendToolResponse: (functionResponses) => session?.sendToolResponse({ functionResponses }),
      fetchJson: request,
      record: (e) => recorder.record(e),
      notify,
    });
    unsubscribe = store.subscribe((s, prev) => {
      if (s.status === "ending" && prev.status !== "ending") void finish(false, { goodbye: true });
    });
    heartbeat = setInterval(() => void request("/api/warm", {}).catch(() => {}), HEARTBEAT_MS);
    store.setState({ connection: "connecting" });
    get().transition("connecting");
    if (!(await connectWithRetry())) return;
    paused = false;
    store.setState({ connection: "live" });
    get().transition("listen");
  }

  async function onStart() {
    audio.unlock();
    if (busy || get().status !== "idle") return;
    busy = true;
    try {
      let callId = get().callId;
      if (!callId) {
        try {
          ({ id: callId } = await request("/api/calls", {}));
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) {
            store.setState({ staleCall: e.body.detail });
            get().transition("staleCall");
          } else notify("Couldn't start a call. Try again.");
          return;
        }
        store.setState({ callId });
      }
      try {
        await audio.openMic(sendAudio, setMicLost);
      } catch {
        get().transition("micBlocked");
        return;
      }
      void begin(callId!);
    } finally {
      busy = false;
    }
  }

  async function onEndStaleCall() {
    audio.unlock();
    const stale = get().staleCall;
    if (!stale) return;
    try {
      await request(`/api/calls/${stale.active_id}/end`, { interrupted: true });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) return notify("Couldn't end the open call. Try again.");
    }
    store.setState({ staleCall: null });
    get().transition("idle");
    await onStart();
  }

  async function onRetryMic() {
    audio.unlock();
    if (get().status === "micBlocked") {
      get().transition("idle");
      return onStart();
    }
    try {
      await audio.openMic(sendAudio, setMicLost);
      setMicLost(false);
    } catch {
      notify("Still can't reach your microphone. Allow it from the icon in your browser's address bar, then try again.");
    }
  }

  return {
    onStart,
    onEndStaleCall,
    onRetryMic,
    onHangUp: () => finish(false),
    onToggleMute: () => store.setState(({ muted }) => ({ muted: !muted })),
    getLevels: () => audio.levels(),
  };
}

export type CallEngine = ReturnType<typeof createCallEngine>;
