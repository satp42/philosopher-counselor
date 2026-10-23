import clsx from "clsx";
import { MotionConfig } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { fetchJson, HttpError } from "../api";
import type { Card, Stance } from "../state/callStore";
import { button } from "./button";
import { CitationCard, STANCE } from "./CitationCards";
import { ResourceList } from "./CrisisPanel";
import { formatDate, PENDING, retryPage } from "./SynthesisList";

export const POLL_MS = 2000;

export interface Page {
  variant: "full" | "partial" | "situation_notes" | "crisis";
  title: string;
  situation: string;
  lenses: { lens_id: string; tradition: string; stance: Stance; take: string; citations: Card[]; own_reading: boolean }[];
  synthesis: string | null;
  open_questions: string[];
  unexplored: { tradition: string; stance: Stance }[];
}

interface CallDetail {
  id: string;
  started_at: number;
  status: string;
  flags?: { crisis: boolean; interrupted: boolean };
  synthesis: { status: string; page?: Page } | null;
}

const label = "mb-3 text-overline font-medium tracking-[0.14em] text-muted uppercase";
const prose = "font-serif text-prose leading-relaxed whitespace-pre-line text-pretty [overflow-wrap:anywhere]";

const BANNER: Partial<Record<Page["variant"], [string, string]>> = {
  situation_notes: [
    "Situation notes",
    "The call ended before we looked at this from any philosophical perspective, so these notes stay with what you shared.",
  ],
  partial: ["Partway through", "The call ended before every perspective was explored. This page covers the ones we reached."],
};

function Resources() {
  return (
    <section aria-labelledby="support" className="rounded-3xl bg-ink p-6 text-paper">
      <h2 id="support" className="font-serif text-2xl leading-tight">
        Support is here, any time.
      </h2>
      <ResourceList className="mt-4 space-y-4" />
    </section>
  );
}

function PageBody({ page, startedAt, h1 }: { page: Page; startedAt: number; h1: React.RefObject<HTMLHeadingElement | null> }) {
  const banner = BANNER[page.variant];
  return (
    <article className="space-y-12">
      <header className="space-y-4">
        {page.variant === "crisis" && <Resources />}
        {banner && (
          <div className="rounded-2xl border border-line px-4 py-3">
            <p className="text-sm font-medium">{banner[0]}</p>
            <p className="mt-0.5 text-sm leading-relaxed text-muted">{banner[1]}</p>
          </div>
        )}
        <div className="space-y-2">
        <p className="text-sm text-muted">{formatDate(startedAt)}</p>
        <h1 ref={h1} tabIndex={-1} className="font-serif text-4xl leading-tight tracking-tight text-balance outline-none [overflow-wrap:anywhere]">
          {page.title || "A conversation"}
        </h1>
        </div>
      </header>

      <section aria-labelledby="situation">
        <h2 id="situation" className={label}>
          Your situation
        </h2>
        <p className={prose}>{page.situation}</p>
      </section>

      {page.lenses.length > 0 && (
        <section aria-labelledby="lenses" className="space-y-10">
          <h2 id="lenses" className={label}>
            Perspectives
          </h2>
          {page.lenses.map((l) => (
            <section key={l.lens_id} aria-label={l.tradition}>
              <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2">
                <span className="font-serif text-2xl">{l.tradition}</span>
                <span className="text-sm text-muted italic">{STANCE[l.stance]}</span>
              </h3>
              <p className={prose}>{l.take}</p>
              {l.own_reading ? (
                <p className="mt-3 text-sm text-muted italic">The guide's own reading. No encyclopedia passage is cited for it.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {l.citations.map((c, i) => (
                    <CitationCard key={c.passage_id} card={c} index={i} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </section>
      )}

      {page.synthesis && (
        <section aria-labelledby="synthesis">
          <h2 id="synthesis" className={label}>
            Drawing it together
          </h2>
          <p className={prose}>{page.synthesis}</p>
        </section>
      )}

      {page.open_questions.length > 0 && (
        <section aria-labelledby="questions">
          <h2 id="questions" className={label}>
            Questions to sit with
          </h2>
          <ul className="space-y-3">
            {page.open_questions.map((q, i) => (
              <li key={`${i}-${q}`} className={clsx(prose, "border-l-2 border-line pl-4")}>
                {q}
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.unexplored.length > 0 && (
        <section aria-labelledby="unexplored">
          <h2 id="unexplored" className={label}>
            Not explored this time
          </h2>
          <ul className="space-y-1 text-ui">
            {page.unexplored.map((u, i) => (
              <li key={`${i}-${u.tradition}`}>
                {u.tradition} <span className="text-muted italic">· {STANCE[u.stance]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export default function SynthesisPage({ id, onBack }: { id: string; onBack(): void }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const h1 = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next: CallDetail = await fetchJson(`/api/calls/${id}`);
        if (stopped) return;
        setCall(next);
        if (!PENDING.has(next.status)) return;
      } catch (e) {
        if (!stopped && e instanceof HttpError && e.status === 404) return setMissing(true);
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, attempt]);

  async function retry() {
    const status = await retryPage(id);
    if (!status) return;
    setCall((c) => c && { ...c, status });
    setAttempt((a) => a + 1);
  }

  const page = call?.status === "ready" ? call.synthesis?.page : undefined;
  // The page landing is what the reader waited for: move focus to its title so it is announced.
  useEffect(() => {
    if (page) h1.current?.focus();
  }, [!!page]);
  const writing = !!call && !page && call.status !== "failed" && !missing;
  let body;
  if (missing) {
    body = <p className="text-ui text-muted">This page was deleted.</p>;
  } else if (page && call) {
    body = (
      <>
        {call.flags?.crisis && page.variant !== "crisis" && (
          <div className="mb-12">
            <Resources />
          </div>
        )}
        <PageBody page={page} startedAt={call.started_at} h1={h1} />
      </>
    );
  } else if (call?.status === "failed") {
    body = (
      <div className="flex flex-col items-start gap-4">
        {call.flags?.crisis && <Resources />}
        <h1 className="font-serif text-3xl text-balance">The page couldn't be written</h1>
        <p className="text-ui leading-relaxed text-muted">Your call is saved. Trying again usually works.</p>
        <button type="button" onClick={retry} className={button({ tone: "primary" })}>
          Write the page again
        </button>
      </div>
    );
  } else if (call) {
    body = (
      <div className="space-y-8">
        {call.flags?.crisis && <Resources />}
        <p className="font-serif text-2xl text-muted motion-safe:animate-pulse">Writing your page…</p>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <main tabIndex={-1} className="mx-auto w-full max-w-xl outline-none px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-16 sm:px-6">
        <p role="status" className="sr-only">
          {writing ? "Writing your page…" : missing ? "This page was deleted." : ""}
        </p>
        <button type="button" onClick={onBack} className={clsx(button({ tone: "ghost" }), "-ml-5 mb-6")}>
          <span aria-hidden="true">←</span> Your pages
        </button>
        {body}
      </main>
    </MotionConfig>
  );
}
