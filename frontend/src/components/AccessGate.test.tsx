import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson, HttpError } from "../api";
import AccessGate from "./AccessGate";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchJson: vi.fn() }));

const api = vi.mocked(fetchJson);

async function submit(passphrase = "secret") {
  await userEvent.type(screen.getByLabelText("Passphrase"), passphrase);
  await userEvent.click(screen.getByRole("button", { name: "Enter" }));
}

describe("AccessGate", () => {
  afterEach(() => api.mockReset());

  it("unlocks on success", async () => {
    api.mockResolvedValue(null);
    const onUnlocked = vi.fn();
    render(<AccessGate onUnlocked={onUnlocked} />);
    await submit();
    expect(onUnlocked).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith("/api/login", { passphrase: "secret" });
  });

  it("shows an inline error on 401", async () => {
    api.mockRejectedValue(new HttpError(401, null));
    const onUnlocked = vi.fn();
    render(<AccessGate onUnlocked={onUnlocked} />);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("didn't work");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("explains the lockout on 429", async () => {
    api.mockRejectedValue(new HttpError(429, null));
    render(<AccessGate onUnlocked={vi.fn()} />);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });

  it("says when the server can't be reached", async () => {
    api.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<AccessGate onUnlocked={vi.fn()} />);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server");
  });
});
