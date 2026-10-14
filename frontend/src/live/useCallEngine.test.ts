import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "../api";
import { createCallStore } from "../state/callStore";
import { useCallEngine, WARM_POLL_MS } from "./useCallEngine";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchJson: vi.fn() }));

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

describe("useCallEngine", () => {
  afterEach(() => vi.useRealTimers());

  it("warms the library after unlock and polls status until ready", async () => {
    vi.useFakeTimers();
    const ready = [false, true];
    const api = vi.mocked(fetchJson).mockImplementation(async (path: string) =>
      path === "/api/warm/status" ? { ready: ready.shift() } : { warming: true },
    );
    const store = createCallStore({ status: "idle" });
    const { result, rerender } = renderHook(({ unlocked }) => useCallEngine({ unlocked, store }), {
      initialProps: { unlocked: false },
    });
    await advance(0);
    expect(api).not.toHaveBeenCalled();
    expect(result.current.libraryReady).toBeUndefined();

    rerender({ unlocked: true });
    await advance(0);
    expect(result.current.libraryReady).toBe(false);
    await advance(WARM_POLL_MS);
    expect(result.current.libraryReady).toBe(true);
    await advance(WARM_POLL_MS * 3);
    expect(api.mock.calls).toEqual([["/api/warm", {}], ["/api/warm/status"], ["/api/warm/status"]]);
  });
});
