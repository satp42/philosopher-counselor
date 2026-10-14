import { m, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef } from "react";

import { SEP_ORIGIN } from "../config";
import { ALSO, type Card, type Lens } from "../state/callStore";

export const STANCE = { aligned: "Resonates", challenges: "Pushes back" } as const;

interface Group {
  id: string;
  title: string;
  stance?: Lens["stance"];
  cards: Card[];
}

export function CitationCard({ card, index }: { card: Card; index: number }) {
  const href = card.url.startsWith(SEP_ORIGIN) ? card.url : null;
  const reduce = useReducedMotion();

  return (
    <m.li
      initial={{ opacity: 0, y: 12, filter: reduce ? "blur(0px)" : "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.3, ease: "easeOut", delay: Math.min(index, 3) * 0.1 }}
    >
      <article className="min-w-0 rounded-2xl border border-line bg-paper p-4">
        <h4 className="line-clamp-2 font-serif text-prose leading-snug [overflow-wrap:anywhere]">
          {card.entry_title}
        </h4>
        {card.section_path && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
            {card.section_path}
          </p>
        )}
        <p className="mt-3 font-serif text-ui leading-relaxed text-ink/85 [overflow-wrap:anywhere]">{card.excerpt}</p>
        {href && (
          <div className="mt-2 -mb-2 flex flex-wrap items-center gap-x-4">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Encyclopedia entry: ${card.entry_title}, Stanford Encyclopedia of Philosophy (opens in a new tab)`}
              className="inline-flex min-h-11 items-center text-sm text-muted underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              Encyclopedia entry ↗
            </a>
          </div>
        )}
      </article>
    </m.li>
  );
}

export default function CitationCards({ lensPlan, cards }: { lensPlan: Lens[]; cards: Record<string, Card[]> }) {
  const groups: Group[] = [
    ...lensPlan.map((l) => ({ id: l.lens_id, title: l.tradition, stance: l.stance, cards: cards[l.lens_id] ?? [] })),
    { id: ALSO, title: "Also referenced", cards: cards[ALSO] ?? [] },
  ].filter((g) => g.cards.length);

  const sections = useRef(new Map<string, HTMLElement>());
  const counts = useRef<Record<string, number> | null>(null);
  const reduce = useReducedMotion();
  const uid = useId();

  useEffect(() => {
    const prev = counts.current;
    counts.current = Object.fromEntries(groups.map((g) => [g.id, g.cards.length]));
    if (!prev) return;
    const grown = [...groups].reverse().find((g) => g.cards.length > (prev[g.id] ?? 0));
    if (grown) sections.current.get(grown.id)?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [cards, lensPlan]);

  if (!groups.length) {
    return (
      <p className="font-serif text-ui leading-relaxed text-muted italic">
        Passages from the Stanford Encyclopedia of Philosophy will gather here as we talk.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map((g, gi) => (
        <section
          key={g.id}
          aria-labelledby={`${uid}-${gi}`}
          ref={(el) => {
            if (el) sections.current.set(g.id, el);
            else sections.current.delete(g.id);
          }}
          className="scroll-mt-4"
        >
          <h3 id={`${uid}-${gi}`} className="mb-3 flex min-w-0 items-baseline gap-2">
            <span className="line-clamp-2 min-w-0 text-overline font-medium tracking-[0.14em] text-ink uppercase [overflow-wrap:anywhere]">
              {g.title}
            </span>
            {g.stance && <span className="shrink-0 text-xs text-muted italic">{STANCE[g.stance]}</span>}
          </h3>
          <ul className="space-y-3">
            {g.cards.map((card, i) => (
              <CitationCard key={card.passage_id} card={card} index={i} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
