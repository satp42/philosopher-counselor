import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { HttpError } from "../api";
import { createCallStore, type CallData } from "../state/callStore";
import { deferred, passage } from "../test/factories";
import {
  createCallEngine,
  FORCE_ROTATE_MS,
  GOODBYE_MS,
  RETRY_WINDOW_MS,
  ROTATE_AFTER_MS,
  SETUP_TIMEOUT_MS,
  type LiveCallbacks,
} from "./session";

interface FakeSession {
  callbacks: LiveCallbacks;
  sendRealtimeInput: Mock<(...args: any[]) => any>;
  sendClientContent: Mock<(...args: any[]) => any>;
  sendToolResponse: Mock<(...args: any[]) => any>;
  close: Mock<() => void>;
}

const RECONNECTED = "Reconnected. The call continues.";
const IDLE = { serverContent: { turnComplete: true, interactionStatus: "IDLE" } };
const END = { toolCall: { functionCalls: [{ id: "e1", name: "set_phase", args: { phase: "end" } }] } };

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

function setup(data: Partial<CallData> = { status: "idle" }) {
  const store = createCallStore(data);
  const log: string[] = [];
  const sessions: FakeSession[] = [];
  let failConnects = false;
  const scripts: ((callbacks: LiveCallbacks) => unknown)[] = [];
  let mic: { onChunk(b64: string): void; onLost(lost: boolean): void } | null = null;

  const routes: Record<string, (body: any) => unknown> = {
    "/api/calls": () => ({ id: "c1" }),
    "/api/token": () => ({ token: `tok${tokens().length}`, model: "m", api_version: "v1beta" }),
    "/api/warm": () => ({ warming: true }),
    "/end": () => ({ status: "ending" }),
  };
  const fetchJson = vi.fn(async (path: string, body?: any) => {
    log.push(path);
    return routes[path.endsWith("/end") ? "/end" : path](body);
  });
  const tokens = () => fetchJson.mock.calls.filter(([p]) => p === "/api/token").map(([, b]) => b);
  const ends = () => fetchJson.mock.calls.filter(([p]) => p.endsWith("/end"));

  const connect = vi.fn(async ({ callbacks }: { callbacks: LiveCallbacks }) => {
    if (failConnects) throw new Error("socket failed");
    const n = sessions.length + 1;
    const s: FakeSession = {
      callbacks,
      sendRealtimeInput: vi.fn(() => log.push(`audio${n}`)),
      sendClientContent: vi.fn(() => log.push(`context${n}`)),
      sendToolResponse: vi.fn(),
      close: vi.fn(),
    };
    sessions.push(s);
    const script = scripts.shift();
    if (script) await script(callbacks);
    else handshake(callbacks, n);
    return s;
  });
  const handshake = (callbacks: LiveCallbacks, n = sessions.length) => {
    callbacks.onmessage({ setupComplete: {} } as never);
    callbacks.onmessage({ sessionResumptionUpdate: { newHandle: `h${n}`, resumable: true } } as never);
  };

  const audio = {
    unlock: vi.fn(),
    openMic: vi.fn(async (onChunk: (b64: string) => void, onLost: (lost: boolean) => void) => {
      mic = { onChunk, onLost };
    }),
    closeMic: vi.fn(),
    play: vi.fn(),
    flush: vi.fn(),
    pendingMs: vi.fn(() => 0),
    levels: () => ({ input: 0, output: 0 }),
    lastSpeechAt: () => 0,
  };
  const post = vi.fn(async (_path: string, body: any) => {
    log.push(`events:${body.events.map((e: { type: string }) => e.type).join(",")}`);
    return { ok: true, status: 204 };
  });
  const notify = vi.fn();
  const onCallEnded = vi.fn();
  const engine = createCallEngine({ store, audio, connect, fetchJson, post, notify, onCallEnded });

  const last = () => sessions[sessions.length - 1];
  const emit = (message: object) => last().callbacks.onmessage(message as never);
  const posted = () => post.mock.calls.flatMap(([, body]) => body.events);
  const responses = () => sessions.flatMap((s) => s.sendToolResponse.mock.calls);
  return {
    store,
    engine,
    audio,
    connect,
    fetchJson,
    post,
    notify,
    onCallEnded,
    sessions,
    log,
    routes,
    tokens,
    ends,
    last,
    emit,
    posted,
    responses,
    scripts,
    handshake,
    speak: (data = "pcm") => mic!.onChunk(data),
    failConnects: (v: boolean) => (failConnects = v),
    mic: () => mic!,
  };
}

async function started() {
  const t = setup();
  await t.engine.onStart();
  await settle();
  return t;
}

const lookup = (id: string) => ({ toolCall: { functionCalls: [{ id, name: "consult_sep", args: { query: "duty" } }] } });

describe("call engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates the call, checks the mic, mints a token and connects", async () => {
    const t = await started();
    expect(t.audio.unlock).toHaveBeenCalled();
    expect(t.log.slice(0, 2)).toEqual(["/api/calls", "/api/token"]);
    expect(t.tokens()).toEqual([{ call_id: "c1", resumption_handle: null }]);
    expect(t.connect).toHaveBeenCalledWith(expect.objectContaining({ token: "tok1", model: "m", apiVersion: "v1beta" }));
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live", callId: "c1" });
    t.speak();
    expect(t.last().sendRealtimeInput).toHaveBeenCalledWith({ audio: { data: "pcm", mimeType: "audio/pcm;rate=16000" } });
  });

  it("does not send audio while muted", async () => {
    const t = await started();
    t.engine.onToggleMute();
    expect(t.store.getState().muted).toBe(true);
    t.speak();
    expect(t.last().sendRealtimeInput).not.toHaveBeenCalled();
  });

  it("moves to staleCall on a 409 and ends the stale call before starting fresh", async () => {
    const t = setup();
    t.routes["/api/calls"] = () => {
      throw new HttpError(409, { detail: { active_id: "old", started_at: 100 } });
    };
    await t.engine.onStart();
    expect(t.store.getState()).toMatchObject({ status: "staleCall", staleCall: { active_id: "old", started_at: 100 } });
    expect(t.audio.openMic).not.toHaveBeenCalled();

    t.routes["/api/calls"] = () => ({ id: "c1" });
    await t.engine.onEndStaleCall();
    await settle();
    expect(t.fetchJson).toHaveBeenCalledWith("/api/calls/old/end", { interrupted: true });
    expect(t.store.getState()).toMatchObject({ status: "listen", callId: "c1", staleCall: null });
  });

  it("goes to micBlocked when the mic is denied, and retry reuses the call", async () => {
    const t = setup();
    t.audio.openMic.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await t.engine.onStart();
    expect(t.store.getState().status).toBe("micBlocked");
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.tokens()).toEqual([]);

    await t.engine.onRetryMic();
    await settle();
    expect(t.store.getState().status).toBe("listen");
    expect(t.fetchJson.mock.calls.filter(([p]) => p === "/api/calls")).toHaveLength(1);
  });

  it("routes tool calls to the dispatcher and cancellations drop them", async () => {
    const t = await started();
    t.emit({ toolCall: { functionCalls: [{ id: "u1", name: "update_situation", args: { summary: "Job offer", leaning: "go" } }] } });
    expect(t.last().sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "u1", name: "update_situation", response: { summary: "Job offer", leaning: "go", lens_plan: [] } }],
    });
    expect(t.store.getState().summary).toBe("Job offer");

    const res = deferred<unknown>();
    t.routes["/api/retrieve"] = () => res.promise;
    t.emit(lookup("q1"));
    t.emit({ toolCallCancellation: { ids: ["q1"] } });
    res.resolve({ passages: [passage("p1")] });
    await settle();
    expect(t.responses()).toHaveLength(1);
    expect(t.store.getState().cards).toEqual({});
  });

  it("flags consulting from a lookup until guide audio resumes after the result", async () => {
    const t = await started();
    const res = deferred<unknown>();
    t.routes["/api/retrieve"] = () => res.promise;
    t.emit(lookup("q1"));
    expect(t.store.getState().consulting).toBe(true);

    const audioMsg = { serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm" } }] } } };
    t.emit(audioMsg);
    expect(t.store.getState().consulting).toBe(true);

    res.resolve({ passages: [] });
    await settle();
    expect(t.last().sendToolResponse).toHaveBeenCalled();
    expect(t.store.getState().consulting).toBe(true);
    t.emit(audioMsg);
    expect(t.audio.play).toHaveBeenCalledWith("AAAA");
    expect(t.store.getState().consulting).toBe(false);
  });

  it("flushes playback and closes the transcript turn on interrupted", async () => {
    const t = await started();
    t.emit({ serverContent: { outputTranscription: { text: "Tell me more" } } });
    t.emit({ serverContent: { interrupted: true } });
    await settle();
    expect(t.audio.flush).toHaveBeenCalled();
    expect(t.posted()).toContainEqual(expect.objectContaining({ type: "turn", role: "guide", text: "Tell me more" }));
  });

  it("closes transcript turns on IDLE but not IN_PROGRESS", async () => {
    const t = await started();
    t.emit({ serverContent: { inputTranscription: { text: "I'm torn" } } });
    t.emit({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } });
    await settle();
    expect(t.posted().filter((e) => e.type === "turn")).toEqual([]);
    t.emit(IDLE);
    await settle();
    expect(t.posted()).toContainEqual(expect.objectContaining({ type: "turn", role: "user", text: "I'm torn" }));
  });

  it("rotates quietly on the first IDLE after 9:00, resuming with the saved handle", async () => {
    const t = await started();
    t.store.setState({ summary: "Job offer abroad", leaning: "stay" });

    await settle(ROTATE_AFTER_MS - 1000);
    t.emit(IDLE);
    await settle();
    expect(t.connect).toHaveBeenCalledTimes(1);

    const res = deferred<unknown>();
    t.routes["/api/retrieve"] = () => res.promise;
    t.emit(lookup("q1"));
    await settle(1000);
    const old = t.last();
    t.emit(IDLE);
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
    expect(old.close).toHaveBeenCalled();
    t.speak("held");
    expect(old.sendRealtimeInput).not.toHaveBeenCalled();

    await settle();
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.tokens()[1]).toEqual({ call_id: "c1", resumption_handle: "h1" });
    const fresh = t.last();
    expect(fresh.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: expect.stringMatching(/^\[Context — do not respond\].*Job offer abroad/) }] }],
      turnComplete: false,
    });
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
    t.speak();
    expect(t.log.filter((l) => l.endsWith("2"))).toEqual(["context2", "audio2", "audio2"]);
    expect(fresh.sendRealtimeInput.mock.calls.map(([m]) => m.audio.data)).toEqual(["held", "pcm"]);
    expect(t.notify).not.toHaveBeenCalledWith(RECONNECTED);

    res.resolve({ passages: [passage("p1")] });
    await settle();
    expect(t.responses()).toEqual([]);
    expect(t.store.getState().cards).toEqual({});
  });

  it("forces the rotation at 9:40 even without an IDLE", async () => {
    const t = await started();
    await settle(FORCE_ROTATE_MS - 1);
    expect(t.connect).toHaveBeenCalledTimes(1);
    await settle(1);
    await settle();
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.tokens()[1].resumption_handle).toBe("h1");
    expect(t.last().sendClientContent).toHaveBeenCalledOnce();
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("goAway rotates quietly with the latest handle", async () => {
    const t = await started();
    t.emit({ goAway: { timeLeft: "5s" } });
    expect(t.store.getState().connection).toBe("live");
    await settle();
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.tokens()[1].resumption_handle).toBe("h1");
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("falls back to a visible reconnect when a quiet rotation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await started();
    t.failConnects(true);
    await settle(FORCE_ROTATE_MS);
    await settle();
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "reconnecting" });
    t.failConnects(false);
    await settle(5_000);
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
    expect(t.notify).toHaveBeenCalledWith(RECONNECTED);
  });

  it("shows Reconnecting at once on an unexpected 1011 close, keeping the phase throughout", async () => {
    const t = await started();
    t.store.getState().transition("mapping");
    t.store.getState().transition("explore");
    t.last().callbacks.onclose({ code: 1011, reason: "The service is currently unavailable." });
    expect(t.store.getState()).toMatchObject({ status: "explore", connection: "reconnecting" });
    t.speak();
    await settle();
    expect(t.last().sendRealtimeInput).not.toHaveBeenCalled();
    expect(t.tokens()[1].resumption_handle).toBe("h1");
    expect(t.store.getState()).toMatchObject({ status: "explore", connection: "live" });
    expect(t.last().sendClientContent.mock.calls[0][0].turns[0].parts[0].text).toMatch(/Current phase: explore\.$/);
    expect(t.notify).toHaveBeenCalledWith(RECONNECTED);
    expect(t.posted().filter((e) => e.type === "phase").map((e) => e.phase)).toEqual(["listen", "mapping", "explore"]);
  });

  it("keeps crisis through a reconnect", async () => {
    const t = await started();
    t.emit({ toolCall: { functionCalls: [{ id: "c1", name: "signal_crisis" }] } });
    t.last().callbacks.onclose({ code: 1011, reason: "gone" });
    expect(t.store.getState()).toMatchObject({ status: "crisis", crisis: true, connection: "reconnecting" });
    await settle();
    expect(t.store.getState()).toMatchObject({ status: "crisis", crisis: true, connection: "live" });
    expect(t.last().sendClientContent.mock.calls[0][0].turns[0].parts[0].text).toMatch(
      /The person is in crisis: this call is care-only.*Current phase: crisis\.$/,
    );
  });

  it("a drop during mapping abandons it for listen", async () => {
    const t = await started();
    t.routes["/api/lens-map"] = () => new Promise(() => {});
    t.emit({ toolCall: { functionCalls: [{ id: "m1", name: "map_lenses", args: { lenses: [] } }] } });
    expect(t.store.getState().status).toBe("mapping");
    t.last().callbacks.onclose({ code: 1011, reason: "gone" });
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "reconnecting" });
    await settle();
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
  });

  it("ends the call as interrupted after 30s of failed reconnects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await started();
    t.failConnects(true);
    t.last().callbacks.onclose({ code: 1011, reason: "gone" });
    await settle(25_000);
    expect(t.ends()).toEqual([]);
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "reconnecting" });

    await settle(6_000);
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: true }]]);
    expect(t.posted()).toContainEqual(expect.objectContaining({ type: "flag", flag: "interrupted" }));
    expect(t.store.getState()).toMatchObject({ status: "generating", crisis: false });
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/couldn't be restored, so the call ended/));
    expect(t.notify).not.toHaveBeenCalledWith(RECONNECTED);
    expect(t.onCallEnded).toHaveBeenCalledWith("c1");
  });

  it("hang up flushes the recorder before ending the call", async () => {
    const t = await started();
    t.emit({ serverContent: { inputTranscription: { text: "Thanks" } } });
    await t.engine.onHangUp();
    expect(t.last().close).toHaveBeenCalled();
    expect(t.audio.flush).toHaveBeenCalled();
    expect(t.audio.closeMic).toHaveBeenCalled();
    const flushed = t.log.findIndex((l) => l.startsWith("events:") && l.includes("turn"));
    const ended = t.log.indexOf("/api/calls/c1/end");
    expect(flushed).toBeGreaterThan(-1);
    expect(flushed).toBeLessThan(ended);
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: false }]]);
    expect(t.store.getState().status).toBe("generating");
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.onCallEnded).toHaveBeenCalledWith("c1");
  });

  it("the guide's set_phase(end) lets the goodbye play out, then ends the call", async () => {
    const t = await started();
    t.store.getState().transition("synthesize");
    t.emit(END);
    const s = t.last();
    expect(t.store.getState().status).toBe("ending");
    expect(s.sendToolResponse).toHaveBeenCalled();
    t.speak();
    expect(s.sendRealtimeInput).not.toHaveBeenCalled();

    t.audio.pendingMs.mockReturnValue(1500);
    t.emit({ serverContent: { outputTranscription: { text: "Take care." } } });
    t.emit(IDLE);
    await settle(1000);
    expect(s.close).not.toHaveBeenCalled();
    expect(t.ends()).toEqual([]);

    t.audio.pendingMs.mockReturnValue(0);
    await settle(100);
    expect(s.close).toHaveBeenCalled();
    expect(t.audio.flush).toHaveBeenCalled();
    expect(t.audio.closeMic).toHaveBeenCalled();
    const flushed = t.log.findIndex((l) => l.startsWith("events:") && l.includes("turn"));
    expect(flushed).toBeGreaterThan(-1);
    expect(flushed).toBeLessThan(t.log.indexOf("/api/calls/c1/end"));
    expect(t.posted()).toContainEqual(expect.objectContaining({ type: "turn", role: "guide", text: "Take care." }));
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: false }]]);
    expect(t.store.getState().status).toBe("generating");
    expect(t.onCallEnded).toHaveBeenCalledWith("c1");
  });

  it("a guide-initiated end waits at most GOODBYE_MS", async () => {
    const t = await started();
    t.emit(END);
    await settle(GOODBYE_MS - 200);
    expect(t.ends()).toEqual([]);
    await settle(300);
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: false }]]);
    expect(t.store.getState().status).toBe("generating");
  });

  it.each(["token", "connect"])("hanging up while the %s is pending leaves no live session or timers", async (step) => {
    const t = setup();
    const gate = deferred<void>();
    if (step === "token") {
      const mint = t.routes["/api/token"];
      t.routes["/api/token"] = async (body) => (await gate.promise, mint(body));
    } else t.scripts.push(async (callbacks) => (await gate.promise, t.handshake(callbacks)));
    await t.engine.onStart();
    await settle();
    expect(t.store.getState().status).toBe("connecting");

    await t.engine.onHangUp();
    gate.resolve();
    await settle();
    expect(t.store.getState().status).toBe("generating");
    expect(t.connect).toHaveBeenCalledTimes(step === "token" ? 0 : 1);
    expect(t.sessions.every((s) => s.close.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds each attempt, so a hung token request still ends the call after the retry window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await started();
    t.routes["/api/token"] = () => new Promise(() => {});
    t.last().callbacks.onclose({ code: 1011, reason: "gone" });
    await settle(RETRY_WINDOW_MS - 1000);
    expect(t.ends()).toEqual([]);
    await settle(2000);
    expect(t.tokens()).toHaveLength(3);
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: true }]]);
    expect(t.store.getState().status).toBe("generating");
  });

  it("a close before setupComplete is retried by the opener alone, not a parallel reconnect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.scripts.push((callbacks) => callbacks.onclose({ code: 1011, reason: "early" }));
    await t.engine.onStart();
    await settle(500);
    await settle();
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.tokens()).toHaveLength(2);
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
  });

  it("re-mints when Live connects but never completes setup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.scripts.push(() => {});
    await t.engine.onStart();
    await settle(SETUP_TIMEOUT_MS - 1);
    expect(t.store.getState().status).toBe("connecting");
    await settle(1);
    expect(t.sessions[0].close).toHaveBeenCalled();
    await settle(500);
    await settle();
    expect(t.tokens()).toHaveLength(2);
    expect(t.store.getState()).toMatchObject({ status: "listen", connection: "live" });
  });

  it("a 429 from /api/token ends the call as interrupted at once instead of retrying", async () => {
    const t = await started();
    t.routes["/api/token"] = () => {
      throw new HttpError(429, { detail: "token limit reached for this call" });
    };
    t.last().callbacks.onclose({ code: 1011, reason: "gone" });
    await settle();
    expect(t.tokens()).toHaveLength(2);
    expect(t.ends()).toEqual([["/api/calls/c1/end", { interrupted: true }]]);
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/connection time/));
    expect(t.store.getState().status).toBe("generating");
  });

  it("reaches generating even when /end fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await started();
    t.routes["/end"] = () => {
      throw new HttpError(503, null);
    };
    await t.engine.onHangUp();
    expect(t.ends()).toHaveLength(1);
    expect(t.store.getState().status).toBe("generating");
    expect(t.onCallEnded).toHaveBeenCalledWith("c1");
  });

  it("ignores a second Start while the first is in progress", async () => {
    const t = setup();
    await Promise.all([t.engine.onStart(), t.engine.onStart()]);
    await settle();
    expect(t.fetchJson.mock.calls.filter(([p]) => p === "/api/calls")).toHaveLength(1);
    expect(t.audio.openMic).toHaveBeenCalledOnce();
    expect(t.connect).toHaveBeenCalledOnce();
  });

  it("notifies when re-acquiring a lost mic fails", async () => {
    const t = await started();
    t.mic().onLost(true);
    t.audio.openMic.mockRejectedValueOnce(new Error("NotReadableError"));
    await t.engine.onRetryMic();
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/Still can't reach your microphone/));
    expect(t.store.getState()).toMatchObject({ micLost: true, status: "listen" });
  });

  it("shows micLost on a dropped track and re-acquires capture without ending the call", async () => {
    const t = await started();
    t.mic().onLost(true);
    expect(t.store.getState().micLost).toBe(true);
    await t.engine.onRetryMic();
    expect(t.audio.openMic).toHaveBeenCalledTimes(2);
    expect(t.store.getState()).toMatchObject({ micLost: false, status: "listen" });
    expect(t.ends()).toEqual([]);
  });

  it("sends a warm heartbeat every 5 minutes during a call", async () => {
    const t = await started();
    await settle(5 * 60_000);
    expect(t.fetchJson).toHaveBeenCalledWith("/api/warm", {});
  });
});
