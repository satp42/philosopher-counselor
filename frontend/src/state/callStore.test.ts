import { afterEach, describe, expect, it, vi } from "vitest";

import { card, lens } from "../test/factories";
import { ALSO, createCallStore, type Status } from "./callStore";

function at(status: Status) {
  return createCallStore({ status });
}

describe("callStore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("walks the happy path from gate to generating", () => {
    const store = createCallStore();
    const steps: Status[] = ["idle", "connecting", "listen", "mapping", "explore", "synthesize", "ending", "generating"];
    for (const s of steps) expect(store.getState().transition(s)).toBe(true);
    expect(store.getState().status).toBe("generating");
  });

  it.each([
    ["gate", "listen"],
    ["generating", "explore"],
    ["generating", "idle"],
    ["listen", "explore"],
    ["connecting", "explore"],
    ["crisis", "listen"],
  ] as [Status, Status][])("ignores and logs the invalid transition %s -> %s", (from, to) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = at(from);
    expect(store.getState().transition(to)).toBe(false);
    expect(store.getState().status).toBe(from);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("allows idle side states and retries", () => {
    const store = at("idle");
    store.getState().transition("micBlocked");
    store.getState().transition("idle");
    store.getState().transition("staleCall");
    store.getState().transition("idle");
    expect(store.getState().status).toBe("idle");
  });

  it("set_phase(listen) from explore voids the lens plan and archives its cards", () => {
    const store = at("explore");
    store.setState({ lensPlan: [lens("l1")] });
    store.getState().addCards([card("p1", { lens_id: "l1" }), card("p2")]);
    store.getState().setPhase("listen");
    const s = store.getState();
    expect(s.status).toBe("listen");
    expect(s.lensPlan).toEqual([]);
    expect(s.cards).toEqual({ [ALSO]: [card("p2")] });
    expect(s.archivedCards).toEqual([card("p1", { lens_id: "l1" })]);
  });

  it("set_phase(explore) from synthesize is allowed and set_phase(end) ends", () => {
    const store = at("synthesize");
    store.getState().setPhase("explore");
    expect(store.getState().status).toBe("explore");
    store.getState().setPhase("synthesize");
    store.getState().setPhase("end");
    expect(store.getState().status).toBe("ending");
  });

  it.each(["listen", "mapping", "explore", "synthesize"] as Status[])("crisis from %s is sticky", (from) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = at(from);
    store.getState().transition("crisis");
    expect(store.getState().crisis).toBe(true);
    for (const p of ["listen", "explore", "synthesize", "end"] as const) store.getState().setPhase(p);
    expect(store.getState().transition("mapping")).toBe(false);
    expect(store.getState().status).toBe("crisis");
    store.getState().transition("ending");
    expect(store.getState()).toMatchObject({ status: "ending", crisis: true });
  });

  it("groups cards by lens in one update, falls back to also, and dedupes", () => {
    const store = at("explore");
    store.setState({ lensPlan: [lens("l1")] });
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().addCards([card("p1", { lens_id: "l1" }), card("p1", { lens_id: "l1" }), card("p2")]);
    store.getState().addCards([card("p3", { lens_id: "unknown" }), card("p2")]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState().cards).toEqual({
      l1: [card("p1", { lens_id: "l1" })],
      [ALSO]: [card("p2"), card("p3", { lens_id: "unknown" })],
    });
  });

  it("reset returns to idle with empty call data", () => {
    const store = at("generating");
    store.setState({ callId: "c1", summary: "s", crisis: true, connection: "reconnecting" });
    store.getState().reset();
    expect(store.getState()).toMatchObject({ status: "idle", callId: null, summary: "", crisis: false, connection: "connecting" });
  });
});
