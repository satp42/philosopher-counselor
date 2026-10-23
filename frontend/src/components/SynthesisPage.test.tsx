import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson, HttpError } from "../api";
import { card } from "../test/factories";
import SynthesisPage, { POLL_MS, type Page } from "./SynthesisPage";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchJson: vi.fn() }));

const api = vi.mocked(fetchJson);

const page = (over: Partial<Page> = {}): Page => ({
  variant: "full",
  title: "On staying",
  situation: "You are weighing a move.",
  lenses: [
    {
      lens_id: "lens-1",
      tradition: "Stoicism",
      stance: "aligned",
      take: "What is up to you.",
      own_reading: false,
      citations: [card("p1", { url: "https://plato.stanford.edu/entries/epictetus/" })],
    },
    { lens_id: "lens-2", tradition: "Existentialism", stance: "challenges", take: "Freedom.", own_reading: true, citations: [] },
  ],
  synthesis: "Both, together.",
  open_questions: ["What would staying give you?"],
  unexplored: [],
  ...over,
});

const detail = (status: string, p?: Page) => ({
  id: "a",
  started_at: 1_760_000_000,
  status,
  synthesis: p ? { status, page: p } : status === "failed" ? { status } : null,
});

function mockApi(...responses: object[]) {
  api.mockImplementation(async (path: string) =>
    path.endsWith("/retry") ? { id: "a", status: "generating" } : responses.length > 1 ? responses.shift() : responses[0],
  );
  return api;
}

describe("SynthesisPage", () => {
  afterEach(() => {
    api.mockReset();
    vi.useRealTimers();
  });

  it("renders a full page with stances, SEP citations and the guide's own reading", async () => {
    mockApi(detail("ready", page()));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "On staying" })).toBeInTheDocument();
    const stoic = screen.getByRole("region", { name: "Stoicism" });
    expect(stoic).toHaveTextContent("Resonates");
    expect(within(stoic).getByRole("link")).toHaveAttribute("href", "https://plato.stanford.edu/entries/epictetus/");
    expect(screen.getByRole("region", { name: "Existentialism" })).toHaveTextContent("The guide's own reading");
    expect(screen.getByText("Both, together.")).toBeInTheDocument();
    expect(screen.getByText("What would staying give you?")).toBeInTheDocument();
    expect(screen.queryByText("Situation notes")).toBeNull();
  });

  it("labels a partial page and lists the lenses not explored", async () => {
    mockApi(detail("ready", page({ variant: "partial", unexplored: [{ tradition: "Buddhism", stance: "aligned" }] })));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByText("Partway through")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Not explored this time" })).toHaveTextContent("Buddhism");
  });

  it("shows situation notes without perspectives", async () => {
    mockApi(detail("ready", page({ variant: "situation_notes", lenses: [], synthesis: null })));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByText("Situation notes")).toBeInTheDocument();
    expect(screen.queryByText("Perspectives")).toBeNull();
  });

  it("keeps support resources up while a crisis page is still being written", async () => {
    mockApi({ ...detail("generating"), flags: { crisis: true, interrupted: false } });
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("link", { name: "Call 988" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Writing your page…");
  });

  it("puts support resources first on a crisis page, with no philosophy", async () => {
    mockApi(detail("ready", page({ variant: "crisis", lenses: [], synthesis: null })));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("link", { name: "Call 988" })).toHaveAttribute("href", "tel:988");
    expect(screen.queryByText("Perspectives")).toBeNull();
  });

  it("renders model text as text, never as markup", async () => {
    mockApi(detail("ready", page({ title: "<img src=x onerror=alert(1)>" })));
    const { container } = render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("polls while generating until the page is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi(detail("generating"), detail("generating"), detail("ready", page()));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Writing your page…");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(await screen.findByRole("heading", { level: 1, name: "On staying" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("offers retry when writing failed, then resumes polling", async () => {
    const fetchMock = mockApi(detail("failed"), detail("ready", page()));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Write the page again" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/calls/a/retry", {});
    expect(await screen.findByRole("heading", { level: 1, name: "On staying" })).toBeInTheDocument();
  });

  it("keeps polling through a server error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi(detail("ready", page())).mockRejectedValueOnce(new HttpError(503, null));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(await screen.findByRole("heading", { level: 1, name: "On staying" })).toBeInTheDocument();
  });

  it("survives worst-case data: empty title, long unbroken tradition, duplicate questions, sparse lenses", async () => {
    const tradition = "Confucian role ethics and the Analects' account of ren (仁) as relational humaneness";
    mockApi(
      detail(
        "ready",
        page({
          title: "",
          situation: "https://example.com/a-very-long-unbroken-token-that-must-wrap-somewhere-" + "x".repeat(80),
          lenses: [
            { lens_id: "l1", tradition, stance: "challenges", take: "A take.", own_reading: false, citations: [] },
            { lens_id: "l2", tradition, stance: "aligned", take: "Another take.", own_reading: true, citations: [] },
          ],
          synthesis: null,
          open_questions: ["Why?", "Why?"],
          unexplored: [
            { tradition: "Stoicism", stance: "aligned" },
            { tradition: "Stoicism", stance: "challenges" },
          ],
        }),
      ),
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "A conversation" })).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getAllByRole("region", { name: tradition })).toHaveLength(2);
    expect(screen.getAllByText("Why?")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Drawing it together" })).toBeNull();
    expect(warn).not.toHaveBeenCalled(); // no duplicate-key warnings
    warn.mockRestore();
  });

  it("says when the page is gone", async () => {
    api.mockRejectedValue(new HttpError(404, null));
    render(<SynthesisPage id="a" onBack={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("This page was deleted.");
    expect(api).toHaveBeenCalledOnce();
  });
});
