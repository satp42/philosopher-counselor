import { afterEach, describe, expect, it, vi } from "vitest";

import { createCallStore } from "../state/callStore";
import { deferred } from "../test/factories";
import { createRecorder, MAX_BATCH_BYTES, sendBeacon, type Recorder } from "./recorder";

const PATH = "/api/calls/c1/events";
const ok = { ok: true, status: 204 };
let recorders: Recorder[] = [];

function setup(post = vi.fn().mockResolvedValue(ok)) {
  const store = createCallStore({ status: "connecting", callId: "c1" });
  const beacon = vi.fn().mockReturnValue(true);
  const onCallEnded = vi.fn();
  const recorder = createRecorder({ callId: "c1", store, post, beacon, onCallEnded });
  recorders.push(recorder);
  const posted = () => post.mock.calls.map(([, body]) => body.events);
  return { store, post, beacon, onCallEnded, recorder, posted };
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("recorder", () => {
  afterEach(() => {
    recorders.forEach((r) => r.stop());
    recorders = [];
    setVisibility("visible");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("numbers events with increasing seq and posts them on flush", async () => {
    const t = setup();
    t.recorder.record({ type: "summary", summary: "s", leaning: "l" });
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    await t.recorder.flush();
    t.recorder.record({ type: "flag", flag: "crisis" });
    await t.recorder.flush();
    expect(t.post).toHaveBeenCalledWith(PATH, expect.anything());
    expect(t.posted().map((batch) => batch.map((e: { seq: number }) => e.seq))).toEqual([[1, 2], [3]]);
  });

  it("closes a transcript turn per role and flushes", async () => {
    const t = setup();
    t.recorder.appendTranscript("user", "I got an ");
    t.recorder.appendTranscript("user", "offer abroad.");
    t.recorder.appendTranscript("guide", " Tell me more. ");
    await t.recorder.closeTurn();
    expect(t.posted()).toEqual([
      [
        { seq: 1, type: "turn", role: "user", text: "I got an offer abroad.", ts: expect.any(Number) },
        { seq: 2, type: "turn", role: "guide", text: "Tell me more.", ts: expect.any(Number) },
      ],
    ]);
    await t.recorder.closeTurn();
    expect(t.post).toHaveBeenCalledOnce();
  });

  it("records phase changes from the store and flushes, but not a reconnect", async () => {
    const t = setup();
    t.store.getState().transition("listen");
    t.store.setState({ connection: "reconnecting" });
    t.store.setState({ connection: "live" });
    t.store.getState().transition("ending");
    t.store.getState().transition("generating");
    await t.recorder.flush();
    expect(t.posted().flat()).toEqual([
      { seq: 1, type: "phase", phase: "listen", ts: expect.any(Number) },
      { seq: 2, type: "phase", phase: "ending", ts: expect.any(Number) },
    ]);
  });

  it("keeps one batch in flight; two quick flushes post sequentially", async () => {
    const first = deferred<typeof ok>();
    const t = setup(vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    const a = t.recorder.flush();
    t.recorder.record({ type: "ack", passage_ids: ["p2"] });
    const b = t.recorder.flush();
    expect(t.post).toHaveBeenCalledOnce();

    first.resolve(ok);
    await Promise.all([a, b]);
    expect(t.posted().map((batch) => batch.map((e: { seq: number }) => e.seq))).toEqual([[1], [2]]);
  });

  it("requeues a batch after a server error and resends the same seqs", async () => {
    const t = setup(vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(ok));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    await t.recorder.flush();
    t.recorder.record({ type: "ack", passage_ids: ["p2"] });
    await t.recorder.flush();
    expect(t.posted().map((batch) => batch.map((e: { seq: number }) => e.seq))).toEqual([[1], [1, 2]]);
  });

  it.each([
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    ["visibilitychange hidden", () => setVisibility("hidden")],
  ])("%s beacons the in-flight batch along with the queue", async (_, fire) => {
    const first = deferred<typeof ok>();
    const t = setup(vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    void t.recorder.flush();
    t.recorder.record({ type: "ack", passage_ids: ["p2"] });
    t.recorder.appendTranscript("user", "half a sentence");

    fire();

    expect(t.beacon).toHaveBeenCalledWith(PATH, {
      events: [
        { seq: 1, type: "ack", passage_ids: ["p1"] },
        { seq: 2, type: "ack", passage_ids: ["p2"] },
        { seq: 3, type: "turn", role: "user", text: "half a sentence", ts: expect.any(Number) },
      ],
    });
    first.resolve(ok);
    await t.recorder.flush();
    expect(t.post).toHaveBeenCalledOnce();
  });

  it("caps each POST at MAX_BATCH_BYTES, including a backlog requeued after a 5xx", async () => {
    const t = setup(vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(ok));
    const text = "x".repeat(20 * 1024);
    for (let i = 0; i < 2; i++) t.recorder.record({ type: "turn", role: "user", text });
    await t.recorder.flush();
    for (let i = 0; i < 3; i++) t.recorder.record({ type: "turn", role: "user", text });
    await t.recorder.flush();
    const batches = t.posted();
    expect(batches.map((b) => b.map((e: { seq: number }) => e.seq))).toEqual([[1, 2], [1, 2], [3, 4], [5]]);
    for (const events of batches) expect(JSON.stringify({ events }).length).toBeLessThan(MAX_BATCH_BYTES);
  });

  it("end retries a failed tail twice, then beacons the rest and stops", async () => {
    vi.useFakeTimers();
    const t = setup(vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    t.recorder.appendTranscript("guide", "Goodbye");
    const done = t.recorder.end();
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(t.post).toHaveBeenCalledTimes(3);
    expect(t.beacon).toHaveBeenCalledWith(PATH, {
      events: [
        { seq: 1, type: "ack", passage_ids: ["p1"] },
        { seq: 2, type: "turn", role: "guide", text: "Goodbye", ts: expect.any(Number) },
      ],
    });
    t.recorder.record({ type: "ack", passage_ids: ["p2"] });
    await t.recorder.flush();
    expect(t.post).toHaveBeenCalledTimes(3);
  });

  it("end stops retrying once the tail lands", async () => {
    vi.useFakeTimers();
    const t = setup(vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(ok));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    const done = t.recorder.end();
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(t.post).toHaveBeenCalledTimes(2);
    expect(t.beacon).not.toHaveBeenCalled();
  });

  it("does not beacon when the page stays visible or nothing is unsent", () => {
    const t = setup();
    setVisibility("visible");
    window.dispatchEvent(new Event("pagehide"));
    expect(t.beacon).not.toHaveBeenCalled();
  });

  it("stops the engine on 409", async () => {
    const t = setup(vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    t.recorder.record({ type: "ack", passage_ids: ["p1"] });
    await t.recorder.flush();
    expect(t.onCallEnded).toHaveBeenCalledOnce();

    t.recorder.record({ type: "ack", passage_ids: ["p2"] });
    t.store.getState().transition("listen");
    await t.recorder.flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(t.post).toHaveBeenCalledOnce();
    expect(t.beacon).not.toHaveBeenCalled();
  });

  it("default beacon sends a JSON blob with navigator.sendBeacon", async () => {
    const send = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: send, configurable: true });
    expect(sendBeacon(PATH, { events: [] })).toBe(true);
    const [path, blob] = send.mock.calls[0];
    expect(path).toBe(PATH);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toEqual({ events: [] });
  });
});
