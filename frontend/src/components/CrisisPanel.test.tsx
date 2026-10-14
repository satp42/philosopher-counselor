import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CRISIS_RESOURCES } from "../config";
import CrisisPanel, { COLLAPSE_AFTER_MS } from "./CrisisPanel";

describe("CrisisPanel", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the configured resources as an alert that takes focus", () => {
    render(<CrisisPanel />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    for (const resource of CRISIS_RESOURCES) {
      expect(alert).toHaveTextContent(resource.name);
      for (const action of resource.actions) {
        expect(screen.getByRole("link", { name: new RegExp(`^${action.label}`) })).toHaveAttribute("href", action.href);
      }
    }
    expect(screen.getByRole("link", { name: "Call 988" })).toHaveAttribute("href", "tel:988");
    expect(screen.getByRole("link", { name: /findahelpline\.com.*opens in a new tab/ })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses to a compact bar after 60s and can never be dismissed", () => {
    vi.useFakeTimers();
    render(<CrisisPanel />);
    act(() => vi.advanceTimersByTime(COLLAPSE_AFTER_MS));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Support is here");
    expect(screen.getByRole("link", { name: "Call 988" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /findahelpline.com/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /close|dismiss|hide/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All resources" }));
    expect(screen.getByRole("link", { name: /findahelpline.com/ })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBe(alert);
  });
});
