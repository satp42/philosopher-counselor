import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ALSO } from "../state/callStore";
import { card, lens } from "../test/factories";
import CitationCards from "./CitationCards";

describe("CitationCards", () => {
  it("groups cards under lens headings in plan order, with Also referenced last", () => {
    render(
      <CitationCards
        lensPlan={[lens("a", "Stoicism"), lens("b", "Existentialism", "challenges"), lens("c", "Buddhism")]}
        cards={{ [ALSO]: [card("x")], b: [card("b1")], a: [card("a1"), card("a2")] }}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.firstChild?.textContent);
    expect(headings).toEqual(["Stoicism", "Existentialism", "Also referenced"]);
    expect(within(screen.getByRole("region", { name: /Stoicism/ })).getAllByRole("article")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: /Existentialism/ })).getByText("Pushes back")).toBeInTheDocument();
  });

  it("clamps a very long title and section path to two lines, keeping the full text in the DOM", () => {
    const title = "Medieval Theories of Practical Reason: Aquinas, Scotus, and Ockham on the Will and Its Freedom";
    const section = "4. The Will > 4.2 Freedom of Exercise and Freedom of Specification > 4.2.1 Scotus's Contingency";
    render(<CitationCards lensPlan={[]} cards={{ [ALSO]: [card("long", { entry_title: title, section_path: section })] }} />);
    const heading = screen.getByRole("heading", { level: 4 });
    expect(heading).toHaveTextContent(title);
    expect(heading).toHaveClass("line-clamp-2");
    expect(screen.getByText(section)).toHaveClass("line-clamp-2");
  });

  it("wraps a long lens heading to two lines instead of cutting it", () => {
    const tradition = "Confucian role ethics and the Analects' account of ren as relational humaneness";
    render(<CitationCards lensPlan={[lens("l1", tradition)]} cards={{ l1: [card("p1")] }} />);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.firstChild).toHaveClass("line-clamp-2");
    expect(heading).toHaveTextContent(tradition);
  });

  it("links only to the SEP, in a new tab without an opener", () => {
    render(
      <CitationCards
        lensPlan={[]}
        cards={{
          [ALSO]: [
            card("sep"),
            card("evil", { url: "https://plato.stanford.edu.evil.example/entries/x/" }),
            card("js", { url: "javascript:alert(1)" }),
          ],
        }}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://plato.stanford.edu/entries/entry-sep/");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders passage text as text, never markup", () => {
    const hostile = '<img src=x onerror="alert(1)"> <b>bold</b>';
    const { container } = render(
      <CitationCards lensPlan={[]} cards={{ [ALSO]: [card("h", { entry_title: hostile, excerpt: hostile })] }} />,
    );
    expect(container.querySelector("img, b")).toBeNull();
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent(hostile);
  });

  it("shows a quiet placeholder before any passage arrives", () => {
    render(<CitationCards lensPlan={[lens("a", "Stoicism")]} cards={{}} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/will gather here/)).toBeInTheDocument();
  });
});
