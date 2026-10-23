import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createCallStore } from "../state/callStore";
import { createTextEngine } from "../text/engine";
import TextCallScreen from "./TextCallScreen";

describe("TextCallScreen", () => {
  it("sends a typed message and shows the guide's reply without a microphone", async () => {
    const store = createCallStore({ status: "idle" });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/calls") return { id: "c1" };
      if (path === "/api/converse") return { kind: "reply", text: "What's at stake for you in saying yes?", calls: [], memo: "m" };
      return { warming: true };
    });
    const engine = createTextEngine({ store, fetchJson, post: vi.fn(async () => ({ ok: true, status: 204 })) });
    render(<TextCallScreen engine={engine} store={store} onOpenPages={vi.fn()} />);
    await engine.onStart();

    expect(await screen.findByRole("list", { name: "Call phase" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "My sister asked me to co-sign.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("What's at stake for you in saying yes?")).toBeInTheDocument();
    expect(screen.getByText("My sister asked me to co-sign.")).toBeInTheDocument();
    expect(fetchJson).not.toHaveBeenCalledWith("/api/token", expect.anything());
  });
});
