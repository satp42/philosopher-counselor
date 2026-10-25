import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createCallStore, type CallData } from "../state/callStore";
import CallScreen from "./CallScreen";

function setup(data: Partial<CallData>) {
  const store = createCallStore(data);
  const on = {
    onStart: vi.fn(),
    onHangUp: vi.fn(),
    onToggleMute: vi.fn(),
    onRetryMic: vi.fn(),
    onEndStaleCall: vi.fn(),
    onOpenPages: vi.fn(),
  };
  render(<CallScreen store={store} {...on} />);
  return { store, on };
}

const currentStep = () => screen.getByRole("listitem", { current: "step" });

describe("CallScreen", () => {
  it("offers writing beside the call, including when the microphone is blocked", async () => {
    const store = createCallStore({ status: "idle" });
    const onStartText = vi.fn();
    const { rerender } = render(<CallScreen store={store} {...{ onStart: vi.fn(), onHangUp: vi.fn(), onToggleMute: vi.fn(), onRetryMic: vi.fn(), onEndStaleCall: vi.fn(), onOpenPages: vi.fn() }} onStartText={onStartText} />);
    await userEvent.click(screen.getByRole("button", { name: "Write instead" }));
    expect(onStartText).toHaveBeenCalledOnce();

    store.setState({ status: "micBlocked", callId: "voice-call" });
    rerender(<CallScreen store={store} onStart={vi.fn()} onHangUp={vi.fn()} onToggleMute={vi.fn()} onRetryMic={vi.fn()} onEndStaleCall={vi.fn()} onOpenPages={vi.fn()} onStartText={onStartText} />);
    await userEvent.click(screen.getByRole("button", { name: "Write instead" }));
    expect(store.getState().status).toBe("idle");
    expect(onStartText).toHaveBeenCalledTimes(2);
  });

  it("starts a call and opens past pages from idle", async () => {
    const { on } = setup({ status: "idle" });
    await userEvent.click(screen.getByRole("button", { name: "Start call" }));
    await userEvent.click(screen.getByRole("button", { name: "Your pages" }));
    expect(on.onStart).toHaveBeenCalledOnce();
    expect(on.onOpenPages).toHaveBeenCalledOnce();
  });

  it("renders sign out with the account name when provided on idle", async () => {
    const store = createCallStore({ status: "idle" });
    const onSignOut = vi.fn();
    render(
      <CallScreen
        store={store}
        accountName="Ada Lovelace"
        onSignOut={onSignOut}
        onStart={vi.fn()}
        onHangUp={vi.fn()}
        onToggleMute={vi.fn()}
        onRetryMic={vi.fn()}
        onEndStaleCall={vi.fn()}
        onOpenPages={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out (Ada Lovelace)" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("announces phase and connection changes in a polite live region", () => {
    const { store } = setup({ status: "listen" });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Listening");

    act(() => void store.getState().transition("mapping"));
    expect(region).toHaveTextContent("Thinking through some perspectives…");

    act(() => store.setState({ connection: "reconnecting" }));
    expect(region).toHaveTextContent("Reconnecting — mic paused");
    expect(screen.getByText(/your mic is paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows mapping inside the explore step and re-highlights an earlier phase on a backward move", () => {
    const { store } = setup({ status: "mapping" });
    expect(currentStep()).toHaveTextContent("Explore");
    act(() => void store.getState().transition("explore"));
    act(() => void store.getState().transition("listen"));
    expect(currentStep()).toHaveTextContent("Listen");
  });

  it("keeps the indicator on the current phase while reconnecting", () => {
    setup({ status: "synthesize", connection: "reconnecting" });
    expect(currentStep()).toHaveTextContent("Synthesize");
  });

  it("shows no Reconnecting banner for the first connect or while wrapping up", () => {
    const { store } = setup({ status: "connecting", connection: "reconnecting" });
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    expect(screen.queryByText(/your mic is paused/)).toBeNull();
    act(() => store.setState({ status: "ending" }));
    expect(screen.getByRole("status")).toHaveTextContent("Wrapping up…");
    expect(screen.queryByText(/your mic is paused/)).toBeNull();
  });

  it("offers past pages while the page is being written", async () => {
    const { on } = setup({ status: "generating" });
    expect(screen.getByRole("status")).toHaveTextContent("Writing your page…");
    await userEvent.click(screen.getByRole("button", { name: "Your pages" }));
    expect(on.onOpenPages).toHaveBeenCalledOnce();
  });

  it("renders the stale call's start time and ends it on request", async () => {
    const started_at = 1_760_000_000;
    const { on } = setup({ status: "staleCall", staleCall: { active_id: "c1", started_at } });
    expect(screen.getByRole("heading", { name: /is still open/ }).querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(started_at * 1000).toISOString(),
    );
    await userEvent.click(screen.getByRole("button", { name: "End it and start a new call" }));
    expect(on.onEndStaleCall).toHaveBeenCalledOnce();
  });

  it("replaces the phase indicator with the crisis panel and keeps hang up available", async () => {
    const { on } = setup({ status: "crisis", crisis: true });
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.queryByRole("list", { name: "Call phase" })).toBeNull();
    expect(screen.queryByRole("button", { name: /close|dismiss/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(on.onHangUp).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "End call" }));
    expect(on.onHangUp).toHaveBeenCalledOnce();
  });

  it("asks before hanging up and keeps the call on cancel", async () => {
    const { on } = setup({ status: "listen" });
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(await screen.findByRole("alertdialog", { name: "End this call?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep talking" }));
    expect(on.onHangUp).not.toHaveBeenCalled();
  });

  it("shows the consulting state while the encyclopedia is being read", () => {
    const { store } = setup({ status: "explore" });
    act(() => store.setState({ consulting: true }));
    expect(screen.getByRole("status")).toHaveTextContent("Consulting the encyclopedia…");
    act(() => store.setState({ consulting: false }));
    expect(screen.getByRole("status")).toHaveTextContent("Exploring perspectives");
  });

  it("keeps the crisis panel through a reconnect", () => {
    setup({ status: "crisis", crisis: true, connection: "reconnecting" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/your mic is paused/)).toBeInTheDocument();
  });

  it("wires mute and reflects the muted state", async () => {
    const { store, on } = setup({ status: "listen" });
    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(mute);
    expect(on.onToggleMute).toHaveBeenCalledOnce();
    act(() => store.setState({ muted: true }));
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Muted");
  });

  it("offers a retry when the mic is blocked or lost", async () => {
    const { store, on } = setup({ status: "micBlocked" });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    act(() => store.setState({ status: "listen", micLost: true }));
    await userEvent.click(screen.getByRole("button", { name: "Turn mic back on" }));
    expect(on.onRetryMic).toHaveBeenCalledTimes(2);
  });
});
