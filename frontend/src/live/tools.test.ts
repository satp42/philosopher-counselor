import { afterEach, describe, expect, it, vi } from "vitest";

import { ALSO, createCallStore, type Status } from "../state/callStore";
import { card, deferred, passage } from "../test/factories";
import { createDispatcher, type Passage, type ToolResponse } from "./tools";

const forModel = (id: string) => ({
  passage_id: id,
  entry_title: `Entry ${id}`,
  section_path: `Entry ${id} > Section`,
  text: `Full text ${id}`,
});

const lensMap = {
  lenses: [
    { lens_id: "l1", tradition: "Stoicism", stance: "aligned" as const, grounded: true, passages: [passage("p1")] },
    { lens_id: "l2", tradition: "Existentialism", stance: "challenges" as const, grounded: true, passages: [passage("p2")] },
    { lens_id: "l3", tradition: "Confucianism", stance: "aligned" as const, grounded: false, passages: [] },
  ],
  challenges_grounded: true,
};

const plan = lensMap.lenses.map(({ passages, ...l }) => l);

const mapCall = {
  id: "m1",
  name: "map_lenses",
  args: { lenses: [{ tradition: "Stoicism", query: "control", stance: "aligned" }] },
};

const CARE_ONLY = "Care-only mode: no philosophy for the rest of this call.";

const lookup = (id: string, args: Record<string, unknown> = { query: "duty" }) => ({ id, name: "consult_sep", args });

function setup(status: Status = "listen") {
  const store = createCallStore({ status, callId: "c1", summary: "Job offer abroad", leaning: "stay" });
  const sendToolResponse = vi.fn((_responses: ToolResponse[], delivered: () => void) => delivered());
  const fetchJson = vi.fn();
  const record = vi.fn();
  const notify = vi.fn();
  const dispatcher = createDispatcher({ store, sendToolResponse, fetchJson, record, notify });
  const sent = () => sendToolResponse.mock.calls.flatMap(([r]) => r);
  const events = (type: string) => record.mock.calls.map(([e]) => e).filter((e) => e.type === type);
  return { store, sendToolResponse, fetchJson, record, notify, dispatcher, sent, events };
}

describe("tool dispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("map_lenses moves listen -> mapping -> explore with cards grouped by lens", async () => {
    const t = setup();
    const res = deferred<typeof lensMap>();
    t.fetchJson.mockReturnValue(res.promise);
    const done = t.dispatcher.dispatch([mapCall]);
    expect(t.store.getState()).toMatchObject({ status: "mapping", consulting: true });
    expect(t.dispatcher.consulting()).toBe(true);
    expect(t.fetchJson).toHaveBeenCalledWith("/api/lens-map", { call_id: "c1", lenses: mapCall.args.lenses });

    res.resolve(lensMap);
    await done;

    const s = t.store.getState();
    expect(s.status).toBe("explore");
    expect(s.lensPlan).toEqual(plan);
    expect(s.cards).toEqual({ l1: [card("p1", { lens_id: "l1" })], l2: [card("p2", { lens_id: "l2" })] });
    expect(t.dispatcher.consulting()).toBe(false);
    expect(t.sent()).toEqual([
      {
        id: "m1",
        name: "map_lenses",
        response: {
          lenses: [
            { ...plan[0], passages: [forModel("p1")] },
            { ...plan[1], passages: [forModel("p2")] },
            { ...plan[2], passages: [] },
          ],
          challenges_grounded: true,
          summary: "Job offer abroad",
          leaning: "stay",
          lens_plan: plan,
        },
      },
    ]);
    expect(t.events("lens_plan")).toEqual([]);
    expect(t.events("ack")).toEqual([{ type: "ack", passage_ids: ["p1", "p2"] }]);
  });

  it("update_situation stores the summary, records it and echoes context", async () => {
    const t = setup();
    await t.dispatcher.dispatch([{ id: "u1", name: "update_situation", args: { summary: "New", leaning: "go" } }]);
    expect(t.store.getState()).toMatchObject({ summary: "New", leaning: "go", consulting: false });
    expect(t.events("summary")).toEqual([{ type: "summary", summary: "New", leaning: "go" }]);
    expect(t.sent()[0].response).toEqual({ summary: "New", leaning: "go", lens_plan: [] });
  });

  it("set_phase moves the store and echoes the phase and context", async () => {
    const t = setup("synthesize");
    await t.dispatcher.dispatch([{ id: "s1", name: "set_phase", args: { phase: "explore" } }]);
    expect(t.store.getState().status).toBe("explore");
    expect(t.sent()[0].response).toEqual({
      phase: "explore",
      summary: "Job offer abroad",
      leaning: "stay",
      lens_plan: [],
    });
    await t.dispatcher.dispatch([{ id: "s2", name: "set_phase", args: { phase: "end" } }]);
    expect(t.store.getState().status).toBe("ending");
  });

  it("signal_crisis is sticky and records the flag", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("explore");
    await t.dispatcher.dispatch([{ id: "c1", name: "signal_crisis" }]);
    expect(t.store.getState()).toMatchObject({ status: "crisis", crisis: true });
    expect(t.events("flag")).toEqual([{ type: "flag", flag: "crisis" }]);

    await t.dispatcher.dispatch([
      { id: "s1", name: "set_phase", args: { phase: "listen" } },
      { id: "s2", name: "set_phase", args: { phase: "end" } },
      { id: "m2", name: "map_lenses", args: { lenses: [] } },
    ]);
    expect(t.store.getState().status).toBe("crisis");
    expect(t.sent().find((r) => r.id === "s2")?.response).toMatchObject({ phase: "crisis" });
    expect(t.fetchJson).not.toHaveBeenCalled();
    expect(t.sent().find((r) => r.id === "m2")?.response).toHaveProperty("error");
  });

  it.each([
    ["map_lenses", mapCall, lensMap],
    ["consult_sep", lookup("q1"), { passages: [passage("p1")] }],
  ])("a %s result landing after signal_crisis delivers care only: no lens plan, cards or acks", async (_, call, result) => {
    const t = setup();
    const res = deferred<unknown>();
    t.fetchJson.mockReturnValue(res.promise);
    const done = t.dispatcher.dispatch([call]);
    await t.dispatcher.dispatch([{ id: "c1", name: "signal_crisis" }]);
    res.resolve(result);
    await done;
    expect(t.sent().find((r) => r.id === call.id)?.response).toEqual({ error: CARE_ONLY });
    expect(t.store.getState()).toMatchObject({ status: "crisis", lensPlan: [], cards: {} });
    expect(t.events("ack")).toEqual([]);
    expect(t.notify).not.toHaveBeenCalled();

    await t.dispatcher.dispatch([lookup("q2")]);
    expect(t.fetchJson).toHaveBeenCalledOnce();
    expect(t.sent().find((r) => r.id === "q2")?.response).toEqual({ error: CARE_ONLY });
  });

  it("drops a cancelled call's late result: no send, no card, no ack", async () => {
    const t = setup("explore");
    const res = deferred<{ passages: Passage[] }>();
    t.fetchJson.mockReturnValue(res.promise);
    const done = t.dispatcher.dispatch([lookup("q1")]);
    expect(t.dispatcher.consulting()).toBe(true);
    t.dispatcher.cancel(["q1"]);
    expect(t.dispatcher.consulting()).toBe(false);
    res.resolve({ passages: [passage("p1")] });
    await done;
    expect(t.sendToolResponse).not.toHaveBeenCalled();
    expect(t.store.getState().cards).toEqual({});
    expect(t.events("ack")).toEqual([]);
  });

  it("cancelling map_lenses returns to listen right away and drops its late result", async () => {
    const t = setup();
    const res = deferred<typeof lensMap>();
    t.fetchJson.mockReturnValue(res.promise);
    const done = t.dispatcher.dispatch([mapCall]);
    expect(t.store.getState().status).toBe("mapping");
    t.dispatcher.cancel(["m1"]);
    expect(t.store.getState().status).toBe("listen");
    res.resolve(lensMap);
    await done;
    expect(t.store.getState()).toMatchObject({ status: "listen", lensPlan: [], cards: {} });
    expect(t.sendToolResponse).not.toHaveBeenCalled();
  });

  it("cancelling an unrelated call keeps mapping going", () => {
    const t = setup();
    t.fetchJson.mockReturnValue(new Promise(() => {}));
    void t.dispatcher.dispatch([mapCall, lookup("q1")]);
    t.dispatcher.cancel(["q1"]);
    expect(t.store.getState().status).toBe("mapping");
  });

  it("handles a duplicate id once", async () => {
    const t = setup("explore");
    t.fetchJson.mockResolvedValue({ passages: [passage("p1")] });
    const call = lookup("q1");
    await t.dispatcher.dispatch([call, call]);
    await t.dispatcher.dispatch([call]);
    expect(t.fetchJson).toHaveBeenCalledOnce();
    expect(t.sendToolResponse).toHaveBeenCalledOnce();
    expect(t.events("ack")).toHaveLength(1);
  });

  it("drops results from a replaced session", async () => {
    const t = setup("explore");
    const res = deferred<{ passages: Passage[] }>();
    t.fetchJson.mockReturnValue(res.promise);
    const done = t.dispatcher.dispatch([lookup("q1")]);
    t.dispatcher.newSession();
    res.resolve({ passages: [passage("p1")] });
    await done;
    expect(t.sendToolResponse).not.toHaveBeenCalled();
    expect(t.store.getState().cards).toEqual({});
  });

  it("a replaced session abandons a pending mapping", () => {
    const t = setup();
    t.fetchJson.mockReturnValue(new Promise(() => {}));
    void t.dispatcher.dispatch([mapCall]);
    t.dispatcher.newSession();
    expect(t.store.getState().status).toBe("listen");
  });

  it("retries a lens-map timeout once, then succeeds", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.fetchJson.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(lensMap);
    const done = t.dispatcher.dispatch([mapCall]);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(t.fetchJson).toHaveBeenCalledTimes(2);
    expect(t.store.getState().status).toBe("explore");
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("after two lens-map failures sends {error}, returns to listen with no cards and notifies", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.fetchJson.mockReturnValue(new Promise(() => {}));
    const done = t.dispatcher.dispatch([mapCall]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(t.fetchJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.store.getState().status).toBe("mapping");
    expect(t.sendToolResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(t.fetchJson).toHaveBeenCalledTimes(2);
    const s = t.store.getState();
    expect(s.status).toBe("listen");
    expect(s.cards).toEqual({});
    expect(s.lensPlan).toEqual([]);
    expect(t.notify).toHaveBeenCalledOnce();
    expect(t.sent()[0].response).toMatchObject({ error: expect.any(String), summary: "Job offer abroad" });
    expect(t.events("ack")).toEqual([]);
  });

  it("a rejected lens-map request also retries once", async () => {
    const t = setup();
    t.fetchJson.mockRejectedValue(new Error("502"));
    await t.dispatcher.dispatch([mapCall]);
    expect(t.fetchJson).toHaveBeenCalledTimes(2);
    expect(t.store.getState().status).toBe("listen");
    expect(t.sent()[0].response).toHaveProperty("error");
  });

  it("consult_sep times out after 3s with {error} and no retry", async () => {
    vi.useFakeTimers();
    const t = setup("explore");
    t.fetchJson.mockReturnValue(new Promise(() => {}));
    const done = t.dispatcher.dispatch([lookup("q1")]);
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(t.fetchJson).toHaveBeenCalledOnce();
    expect(t.sent()).toEqual([{ id: "q1", name: "consult_sep", response: { error: expect.any(String) } }]);
    expect(t.store.getState().cards).toEqual({});
  });

  it("AE4: consult_sep during explore is sent and carded under its lens or also", async () => {
    const t = setup("explore");
    t.store.setState({ lensPlan: plan });
    t.fetchJson
      .mockResolvedValueOnce({ lens_id: "l1", stance: "aligned", grounded: true, passages: [passage("p5")] })
      .mockResolvedValueOnce({ lens_id: null, stance: null, grounded: true, passages: [passage("p6")] });

    await t.dispatcher.dispatch([lookup("q1", { query: "Stoic control", lens_id: "l1", stance: "aligned" })]);
    await t.dispatcher.dispatch([lookup("q2", { query: "follow-up" })]);

    expect(t.fetchJson).toHaveBeenNthCalledWith(1, "/api/retrieve", { call_id: "c1", query: "Stoic control", lens_id: "l1" });
    expect(t.sent()).toEqual([
      { id: "q1", name: "consult_sep", response: { passages: [forModel("p5")] } },
      { id: "q2", name: "consult_sep", response: { passages: [forModel("p6")] } },
    ]);
    expect(t.store.getState().cards).toEqual({ l1: [card("p5", { lens_id: "l1" })], [ALSO]: [card("p6")] });
    expect(t.events("ack")).toEqual([
      { type: "ack", passage_ids: ["p5"] },
      { type: "ack", passage_ids: ["p6"] },
    ]);
  });

  it("acks only after the tool response was sent", async () => {
    const t = setup("explore");
    t.fetchJson.mockResolvedValue({ passages: [passage("p1")] });
    t.sendToolResponse.mockImplementation((_responses: ToolResponse[], delivered: () => void) => {
      expect(t.store.getState().cards).toEqual({});
      expect(t.events("ack")).toEqual([]);
      delivered();
    });
    await t.dispatcher.dispatch([lookup("q1")]);
    expect(t.events("ack")).toEqual([{ type: "ack", passage_ids: ["p1"] }]);
  });

  it("does not ack a passage the model never received", async () => {
    const t = setup("explore");
    t.fetchJson.mockResolvedValue({ passages: [passage("p1")] });
    t.sendToolResponse.mockImplementation(() => {});
    await t.dispatcher.dispatch([lookup("q1")]);
    expect(t.events("ack")).toEqual([]);
    expect(t.store.getState().cards).toEqual({});
  });

  it("answers an unknown tool with an error", async () => {
    const t = setup();
    await t.dispatcher.dispatch([{ id: "x1", name: "google_search" }]);
    expect(t.sent()[0].response).toHaveProperty("error");
  });
});
