import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { TextEngine } from "../text/engine";
import { callStore as defaultStore, CONVERSING, type CallState, type CallStore } from "../state/callStore";
import { button } from "./button";
import CitationCards from "./CitationCards";
import CrisisPanel from "./CrisisPanel";
import PhaseIndicator from "./PhaseIndicator";

const pick = (state: CallState) => ({
  status: state.status,
  crisis: state.crisis,
  consulting: state.consulting,
  lensPlan: state.lensPlan,
  cards: state.cards,
});

export interface TextCallScreenProps {
  engine: TextEngine;
  store?: CallStore;
  onOpenPages(): void;
}

export default function TextCallScreen({ engine, store = defaultStore, onOpenPages }: TextCallScreenProps) {
  const view = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const { status, crisis, consulting, lensPlan, cards } = useStore(store, useShallow(pick));
  const cardCount = Object.values(cards).flat().length;
  const showCards = !crisis && status !== "connecting";
  const writing = view.guide === "writing";
  const statusText = writing ? (consulting ? "Consulting the encyclopedia…" : "The guide is writing…") : "";
  const endOfLog = useRef<HTMLLIElement>(null);
  useEffect(() => {
    endOfLog.current?.scrollIntoView?.({ block: "end" });
  }, [view.lines, writing, crisis, view.guide]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <p role="status" aria-live="polite" className="sr-only">
        {statusText || (view.guide === "failed" ? "The guide couldn't reply." : "")}
      </p>
      <main tabIndex={-1} className="grid min-h-0 flex-1 outline-none lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <h1 className="sr-only">Conversation</h1>
        <section className="flex min-h-0 flex-col">
          <div className="shrink-0 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-6">
            {!crisis && <PhaseIndicator status={status} />}
          </div>
          <ol role="log" aria-label="Conversation" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-8 sm:px-6">
            {view.lines.map((line, index) => (
              <li key={`${index}-${line.role}`} className={clsx("max-w-[36rem]", line.role === "user" ? "self-end" : "self-start")}>
                <p
                  className={clsx(
                    line.role === "guide" ? "font-serif text-prose leading-relaxed text-pretty" : "rounded-3xl border border-line px-4 py-3 text-ui leading-relaxed",
                    line.pending && "opacity-60",
                  )}
                >
                  {line.pending && <span className="sr-only">Not sent yet. </span>}
                  {line.text}
                </p>
              </li>
            ))}
            <li ref={endOfLog} aria-hidden="true" />
          </ol>
          <footer className="shrink-0 space-y-3 border-t border-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            {writing && <p className="text-center text-sm text-muted">{statusText}</p>}
            {view.guide === "failed" && (
              <button type="button" onClick={engine.onRetry} className={button({ tone: "primary" })}>
                Try again
              </button>
            )}
            {view.notice && <p className="text-center text-sm leading-relaxed text-muted">{view.notice}</p>}
            {(crisis || view.guide === "withheld") && <CrisisPanel />}
            {view.canSend && <Composer onSend={engine.onSend} />}
            <div className="flex flex-wrap items-center justify-center gap-3">
              {showCards && cardCount > 0 && <ReadingsDrawer lensPlan={lensPlan} cards={cards} count={cardCount} />}
              {CONVERSING.has(status) && <EndConversation onHangUp={engine.onHangUp} />}
              {status === "generating" && (
                <button type="button" onClick={onOpenPages} className={button({ tone: "quiet", size: "lg" })}>
                  Read your page
                </button>
              )}
            </div>
          </footer>
        </section>
        {showCards && (
          <aside aria-label="Readings" className="hidden min-h-0 overflow-y-auto border-l border-line px-6 py-10 lg:block">
            <h2 className="mb-6 font-serif text-xl">Readings</h2>
            <CitationCards lensPlan={lensPlan} cards={cards} />
          </aside>
        )}
      </main>
    </div>
  );
}

function Composer({ onSend }: { onSend(text: string): void }) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handleSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-2xl items-end gap-2">
      <label className="sr-only" htmlFor="message">
        Message
      </label>
      <textarea
        id="message"
        value={draft}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write what's on your mind"
        className="min-h-14 flex-1 resize-none rounded-3xl border border-line bg-paper px-4 py-3 text-ui leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <button type="submit" className={button({ tone: "primary" })} disabled={!draft.trim()}>
        Send
      </button>
    </form>
  );
}

function EndConversation({ onHangUp }: { onHangUp(): void }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger className={button({ tone: "danger" })}>End conversation</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-30 bg-ink/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-40 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-paper p-6 shadow-2xl outline-none">
          <AlertDialog.Title className="font-serif text-xl">End this conversation?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-ui leading-relaxed text-muted">
            Your page will be written from what you typed.
          </AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Close className={button()}>Keep writing</AlertDialog.Close>
            <AlertDialog.Close onClick={onHangUp} className={button({ tone: "danger" })}>
              End conversation
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function ReadingsDrawer({
  lensPlan,
  cards,
  count,
}: {
  lensPlan: CallState["lensPlan"];
  cards: CallState["cards"];
  count: number;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className={clsx(button(), "lg:hidden")}>
        Readings <span className="text-muted tabular-nums">{count}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-30 bg-ink/25" />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85dvh] flex-col rounded-t-3xl bg-paper p-5 shadow-2xl outline-none">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="font-serif text-xl">Readings</Dialog.Title>
            <Dialog.Close className={button()}>Done</Dialog.Close>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <CitationCards lensPlan={lensPlan} cards={cards} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
