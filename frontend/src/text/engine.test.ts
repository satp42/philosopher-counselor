import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HttpError } from "../api";
import { createCallStore } from "../state/callStore";
import { deferred } from "../test/factories";
import { createTextEngine, MAX_TOOL_ROUNDS } from "./engine";

function setup() {
  const store = createCallStore({ status: "idle" });
  const log: string[] = [];
  const routes: Record<string, (body: any) => unknown> = {
    "/api/calls": () => ({ id: "c1" }),
    "/api/converse": () => ({ kind: "reply", text: "I hear you.", calls: [], memo: "m1" }),
    "/api/warm": () => ({ warming: true }),
  };
  const fetchJson = vi.fn(async (path: string, body?: any) => {
    log.push(path);
    const key = path.endsWith("/end") ? "/end" : path;
    return (routes[key] ?? (() => ({ status: "ending" })))(body);
  });
  const post = vi.fn(async () => ({ ok: true, status: 204 }));
  const engine = createTextEngine({ store, fetchJson, post, notify: vi.fn() });
  return { store, engine, fetchJson, post, log, routes };
}

const reply = (text: string, calls: object[] = [], memo = "m") => ({ kind: "reply", text, calls, memo });

describe("text engine", () => {
  it("starts a text call without a microphone and shows the guide's reply", async () => {
    const t = setup();
    await t.engine.onStart();
    expect(t.store.getState()).toMatchObject({ status: "listen", modality: "text", callId: "c1" });
    expect(t.fetchJson).toHaveBeenCalledWith("/api/calls", { modality: "text" });
    expect(t.log).not.toContain("/api/token");

    t.engine.onSend("  My sister asked me to co-sign. ");
    await waitFor(() => expect(t.engine.getSnapshot().lines.map((line) => line.text)).toEqual(["My sister asked me to co-sign.", "I hear you."]));
    expect(t.engine.getSnapshot().canSend).toBe(true);
    expect(t.post).toHaveBeenCalled();
  });

  it("holds a message typed while the guide is writing until that reply lands", async () => {
    const t = setup();
    const pending = deferred<unknown>();
    let calls = 0;
    t.routes["/api/converse"] = () => {
      calls += 1;
      if (calls === 1) return pending.promise;
      return reply("Both, then.");
    };
    await t.engine.onStart();
    t.engine.onSend("First");
    await waitFor(() => expect(t.fetchJson.mock.calls.filter(([path]) => path === "/api/converse")).toHaveLength(1));
    t.engine.onSend("Second");
    expect(t.engine.getSnapshot().lines.at(-1)).toMatchObject({ text: "Second", pending: true });
    pending.resolve(reply("I hear the first."));
    await waitFor(() => expect(t.engine.getSnapshot().lines.map((line) => line.text)).toEqual(["First", "I hear the first.", "Second", "Both, then."]));
  });

  it("stops a tool loop and leaves the call open", async () => {
    const t = setup();
    t.routes["/api/converse"] = () => reply("", [{ id: `u${t.fetchJson.mock.calls.length}`, name: "update_situation", args: { summary: "s", leaning: "go" } }]);
    await t.engine.onStart();
    t.engine.onSend("hello");
    await waitFor(() => expect(t.engine.getSnapshot().notice).toBeTruthy());
    const converseCalls = t.fetchJson.mock.calls.filter(([path]) => path === "/api/converse");
    expect(converseCalls).toHaveLength(1 + MAX_TOOL_ROUNDS);
    expect(t.store.getState().status).toBe("listen");
    expect(t.log).not.toContain("/api/calls/c1/end");
  });

  it("shows resources when the reply is withheld and says goodbye before ending", async () => {
    const t = setup();
    let calls = 0;
    t.routes["/api/converse"] = () => {
      calls += 1;
      if (calls === 1) return { kind: "withheld" };
      if (calls === 2) return reply("", [{ id: "e1", name: "set_phase", args: { phase: "end" } }]);
      return reply("Take care.");
    };
    await t.engine.onStart();
    t.engine.onSend("I don't want to be here anymore");
    await waitFor(() => expect(t.engine.getSnapshot().guide).toBe("withheld"));
    expect(t.engine.getSnapshot().lines).toEqual([{ role: "user", text: "I don't want to be here anymore", pending: false }]);

    t.engine.onSend("Please end");
    await waitFor(() => expect(t.store.getState().status).toBe("generating"));
    expect(t.engine.getSnapshot().lines.map((line) => line.text)).toContain("Take care.");
    expect(t.fetchJson).toHaveBeenCalledWith("/api/calls/c1/end", { interrupted: false });
  });

  it("ends on 409 from the server", async () => {
    const t = setup();
    t.routes["/api/converse"] = () => {
      throw new HttpError(409, { detail: "call ended" });
    };
    await t.engine.onStart();
    t.engine.onSend("hello");
    await waitFor(() => expect(t.store.getState().status).toBe("generating"));
  });
});
