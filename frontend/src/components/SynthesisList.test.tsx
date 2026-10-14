import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson, HttpError } from "../api";
import SynthesisList, { type CallSummary } from "./SynthesisList";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchJson: vi.fn() }));

const api = vi.mocked(fetchJson);

const call = (id: string, status: string, title: string | null = null): CallSummary => ({
  id,
  status,
  title,
  started_at: 1_760_000_000,
});

function mockApi(list: CallSummary[], deleteFails = false) {
  api.mockImplementation(async (path: string, _body?: unknown, method?: string) => {
    if (method === "DELETE") {
      if (deleteFails) throw new HttpError(500, null);
      return null;
    }
    if (path.endsWith("/retry")) return { id: "c", status: "generating" };
    return list;
  });
}

const rows = () => screen.getAllByRole("listitem");

describe("SynthesisList", () => {
  afterEach(() => {
    api.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it("lists pages in the order given with title, date and status, and offers retry only when failed", async () => {
    mockApi([call("a", "ready", "On staying"), call("b", "generating"), call("c", "failed", "On leaving")]);
    const onOpen = vi.fn();
    render(<SynthesisList onOpen={onOpen} onBack={vi.fn()} />);
    expect(await screen.findByText("On staying")).toBeInTheDocument();
    const [ready, writing, failed] = rows();
    expect(writing).toHaveTextContent("A conversation");
    expect(writing).toHaveTextContent("Writing…");
    expect(failed).toHaveTextContent("Couldn't be written");
    expect(ready).toHaveTextContent(/2025/);
    expect(within(ready).queryByRole("button", { name: /^Write the page again/ })).toBeNull();
    await userEvent.click(within(failed).getByRole("button", { name: /^Write the page again/ }));
    expect(api).toHaveBeenCalledWith("/api/calls/c/retry", {});
    expect(failed).toHaveTextContent("Writing…");
    await userEvent.click(screen.getByText("On staying"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("keeps a failed row and shows an error when the retry doesn't start", async () => {
    mockApi([call("c", "failed", "On leaving")]);
    render(<SynthesisList onOpen={vi.fn()} onBack={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: /^Write the page again/ });
    api.mockRejectedValueOnce(new HttpError(409, null));
    await userEvent.click(retry);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(rows()[0]).toHaveTextContent("Couldn't be written");
  });

  it("says when the list couldn't be loaded", async () => {
    api.mockRejectedValue(new HttpError(500, null));
    render(<SynthesisList onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText(/couldn't be loaded/)).toBeInTheDocument();
  });

  it("invites a first call when there are no pages", async () => {
    mockApi([]);
    const onBack = vi.fn();
    render(<SynthesisList onOpen={vi.fn()} onBack={onBack} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start your first call" }));
    expect(screen.getByText("No pages yet")).toBeInTheDocument();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("deletes a page only after confirmation", async () => {
    mockApi([call("a", "ready", "On staying"), call("b", "ready", "On leaving")]);
    render(<SynthesisList onOpen={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Delete page “On staying”/ }));
    const dialog = await screen.findByRole("dialog");
    expect(api).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(api).toHaveBeenLastCalledWith("/api/calls/a", undefined, "DELETE");
    await vi.waitFor(() => expect(screen.queryByText("On staying")).toBeNull());
    expect(screen.getByText("On leaving")).toBeInTheDocument();
  });

  it("keeps the page and shows an error when the delete fails", async () => {
    mockApi([call("a", "ready", "On staying")], true);
    render(<SynthesisList onOpen={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Delete page “On staying”/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(screen.getByText("On staying")).toBeInTheDocument();
  });
});
