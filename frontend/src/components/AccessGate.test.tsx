import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import AccessGate from "./AccessGate";

describe("AccessGate", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders an OAuth sign-in link without a password input", () => {
    render(<AccessGate />);
    const link = screen.getByRole("link", { name: "Continue with OAuth" });
    expect(link).toHaveAttribute("href", "/api/auth/login");
    expect(screen.queryByLabelText(/passphrase|password/i)).toBeNull();
  });

  it("supports a custom login URL", () => {
    render(<AccessGate loginUrl="/api/auth/login?prompt=select_account" />);
    expect(screen.getByRole("link", { name: "Continue with OAuth" })).toHaveAttribute(
      "href",
      "/api/auth/login?prompt=select_account",
    );
  });

  it("shows an inline alert when the OAuth callback returns an error", () => {
    window.history.replaceState({}, "", "/?error=access_denied");
    render(<AccessGate />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't sign you in");
  });

  it("displays an explicit error prop when provided", () => {
    render(<AccessGate error="Session expired. Sign in again." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired. Sign in again.");
  });
});
