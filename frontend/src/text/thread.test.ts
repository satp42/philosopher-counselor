import { describe, expect, it } from "vitest";

import { attach, guideItem, nextStep, parseReply, toWire, visibleMessages, type Memo } from "./thread";

const memo = "memo" as Memo;

describe("text thread", () => {
  it("asks after a person, continues after answered tools, and waits after a finished line", () => {
    expect(nextStep([])).toBe("wait");
    expect(nextStep([{ kind: "user", text: "hello" }])).toBe("request");
    const guide = guideItem({ kind: "reply", text: "", calls: [{ id: "g0", name: "set_phase", args: { phase: "end" } }], memo });
    expect(nextStep([guide])).toBe("wait");
    expect(nextStep(attach([guide], [{ id: "g0", name: "set_phase", response: { phase: "ending" } }]))).toBe("request");
    expect(nextStep([{ kind: "guide", text: "Take care.", exchanges: [], memo }])).toBe("wait");
  });

  it("hides tool exchanges and sends the memo with results only", () => {
    const guide = guideItem({ kind: "reply", text: "One moment.", calls: [{ id: "m", name: "map_lenses" }], memo });
    const items = attach([{ kind: "user", text: "a promise" }, guide], [{ id: "m", name: "map_lenses", response: { lenses: [] } }]);
    expect(visibleMessages(items)).toEqual([
      { role: "user", text: "a promise" },
      { role: "guide", text: "One moment." },
    ]);
    expect(toWire(items)).toEqual([
      { kind: "user", text: "a promise" },
      { kind: "guide", memo, results: [{ id: "m", name: "map_lenses", response: { lenses: [] } }] },
    ]);
  });

  it("treats an unknown reply as withheld", () => {
    expect(parseReply(null)).toEqual({ kind: "withheld" });
    expect(parseReply({ kind: "reply", text: "hi", memo, calls: [{ id: "a", name: "update_situation", args: { summary: "s" } }] })).toMatchObject({
      kind: "reply",
      text: "hi",
    });
  });
});
