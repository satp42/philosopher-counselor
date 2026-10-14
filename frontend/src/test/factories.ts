import type { Passage } from "../live/tools";
import type { Card, Lens, Stance } from "../state/callStore";

export const passage = (id: string): Passage => ({
  passage_id: id,
  slug: `entry-${id}`,
  entry_title: `Entry ${id}`,
  section_path: `Entry ${id} > Section`,
  url: `https://plato.stanford.edu/entries/entry-${id}/`,
  text: `Full text ${id}`,
  excerpt: `Excerpt ${id}`,
  score: 0.9,
});

export const card = (id: string, over: Partial<Card> = {}): Card => ({
  passage_id: id,
  entry_title: `Entry ${id}`,
  section_path: `Entry ${id} > Section`,
  url: `https://plato.stanford.edu/entries/entry-${id}/`,
  excerpt: `Excerpt ${id}`,
  ...over,
});

export const lens = (lens_id: string, tradition = lens_id, stance: Stance = "aligned"): Lens => ({
  lens_id,
  tradition,
  stance,
  grounded: true,
});

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
