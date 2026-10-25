import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  callStore as defaultStore,
  CONVERSING,
  IN_CALL,
  type CallState,
  type CallStore,
  type Status,
} from "../state/callStore";
import { button } from "./button";
import CitationCards from "./CitationCards";
import CrisisPanel from "./CrisisPanel";
import MicCheck from "./MicCheck";
import PhaseIndicator from "./PhaseIndicator";
import ReconnectingBanner from "./ReconnectingBanner";
import StaleCallPrompt from "./StaleCallPrompt";
import VoiceOrb, { type Levels, type OrbMode } from "./VoiceOrb";

const CAPTION: Partial<Record<Status, string>> = {
  micBlocked: "Microphone blocked",
  staleCall: "A previous call is still open",
  connecting: "Connecting…",
  listen: "Listening",
  mapping: "Thinking through some perspectives…",
  explore: "Exploring perspectives",
  synthesize: "Drawing it together",
  crisis: "Here with you",
  ending: "Wrapping up…",
  generating: "Writing your page…",
};

const pick = (s: CallState) => ({
  status: s.status,
  reconnecting: s.connection === "reconnecting" && CONVERSING.has(s.status),
  crisis: s.crisis,
  muted: s.muted,
  micLost: s.micLost,
  consulting: s.consulting,
  lensPlan: s.lensPlan,
  cards: s.cards,
  staleCall: s.staleCall,
});

type Shown = ReturnType<typeof pick>;

function caption({ status, reconnecting, muted, micLost, consulting }: Shown) {
  const live = CONVERSING.has(status);
  if (reconnecting) return "Reconnecting — mic paused";
  if (live && micLost) return "Microphone stopped — the call is still open";
  if (live && consulting && status !== "mapping") return "Consulting the encyclopedia…";
  if (live && muted) return "Muted";
  return CAPTION[status] ?? "";
}

function orbMode({ status, reconnecting, micLost, consulting }: Shown): OrbMode {
  if (reconnecting || micLost) return "paused";
  if (status === "mapping" || status === "generating" || consulting) return "thinking";
  if (CONVERSING.has(status)) return "active";
  return "idle";
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      <path d="M4 4l16 16" className={clsx("transition-opacity duration-300 ease-[cubic-bezier(0.2,0,0,1)]", off ? "opacity-100" : "opacity-0")} />
    </svg>
  );
}

export interface CallScreenProps {
  store?: CallStore;
  getLevels?: () => Levels;
  libraryReady?: boolean;
  accountName?: string;
  onStart(): void;
  onHangUp(): void;
  onToggleMute(): void;
  onRetryMic(): void;
  onEndStaleCall(): void;
  onOpenPages(): void;
  /** Idle and mic-blocked screens. Typing never opens the microphone. */
  onStartText?(): void;
  onSignOut?(): void;
}

export default function CallScreen({ store = defaultStore, getLevels, libraryReady, accountName, ...on }: CallScreenProps) {
  function handleWrite() {
    if (!on.onStartText) return;
    if (store.getState().status === "micBlocked") store.getState().transition("idle");
    on.onStartText();
  }
  const state = useStore(store, useShallow(pick));
  const { status, reconnecting, crisis, muted, micLost, lensPlan, cards, staleCall } = state;
  const text = caption(state);
  const cardCount = Object.values(cards).flat().length;
  const showCards = !crisis && status !== "connecting";

  let body;
  if (IN_CALL.has(status)) {
    body = (
      <>
        <AnimatePresence>{reconnecting && <ReconnectingBanner />}</AnimatePresence>
        <main tabIndex={-1} className="grid min-h-0 flex-1 outline-none grid-rows-1 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
          <h1 className="sr-only">Call</h1>
          <section className="flex min-h-0 flex-col items-center gap-8 overflow-y-auto px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-8 sm:px-6">
            {crisis ? <CrisisPanel /> : <PhaseIndicator status={status} />}
            <div className="flex flex-1 flex-col items-center justify-center gap-6">
              <VoiceOrb mode={orbMode(state)} label={text} getLevels={getLevels} />
              {micLost && status !== "ending" && <MicCheck variant="lost" onRetry={on.onRetryMic} />}
            </div>
          </section>
          {showCards && (
            <aside aria-label="Readings" className="hidden min-h-0 overflow-y-auto border-l border-line px-6 py-10 lg:block">
              <h2 className="mb-6 font-serif text-xl">Readings</h2>
              <CitationCards lensPlan={lensPlan} cards={cards} />
            </aside>
          )}
        </main>
        {status !== "ending" && (
          <footer className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-t border-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {showCards && cardCount > 0 && (
              <Dialog.Root>
                <Dialog.Trigger className={clsx(button(), "lg:hidden")}>
                  Readings <span className="text-muted tabular-nums">{cardCount}</span>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Backdrop className="fixed inset-0 z-30 bg-ink/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
                  <Dialog.Popup className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85dvh] flex-col rounded-t-3xl bg-paper pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] shadow-2xl outline-none transition-[translate,opacity] duration-[400ms] ease-drawer data-[ending-style]:duration-[250ms] motion-safe:data-[ending-style]:translate-y-full motion-safe:data-[starting-style]:translate-y-full motion-reduce:data-[ending-style]:opacity-0 motion-reduce:data-[starting-style]:opacity-0 dark:shadow-[0_0_0_1px_oklch(1_0_0/0.08)]">
                    <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
                    <div className="mb-5 flex items-center justify-between">
                      <Dialog.Title className="font-serif text-xl">Readings</Dialog.Title>
                      <Dialog.Close className={button()}>Done</Dialog.Close>
                    </div>
                    <div className="-mx-5 min-h-0 overflow-y-auto overscroll-contain px-5">
                      <CitationCards lensPlan={lensPlan} cards={cards} />
                    </div>
                  </Dialog.Popup>
                </Dialog.Portal>
              </Dialog.Root>
            )}
            <button
              type="button"
              aria-pressed={muted}
              aria-disabled={status === "connecting" || reconnecting || undefined}
              onClick={() => status !== "connecting" && !reconnecting && on.onToggleMute()}
              className={button({ tone: muted ? "primary" : "quiet" })}
            >
              <MicIcon off={muted} />
              Mute
            </button>
            <AlertDialog.Root>
              <AlertDialog.Trigger className={button({ tone: "danger" })}>End call</AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Backdrop className="fixed inset-0 z-30 bg-ink/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
                <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-40 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-paper p-6 shadow-2xl outline-none transition-[opacity,scale] duration-200 ease-out-soft motion-safe:data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:scale-95 data-[starting-style]:opacity-0 dark:shadow-[0_0_0_1px_oklch(1_0_0/0.08)]">
                  <AlertDialog.Title className="font-serif text-xl">End this call?</AlertDialog.Title>
                  <AlertDialog.Description className="mt-2 text-ui leading-relaxed text-muted">
                    Your page will be written from what was said.
                  </AlertDialog.Description>
                  <div className="mt-6 flex flex-wrap justify-end gap-3">
                    <AlertDialog.Close className={button()}>Keep talking</AlertDialog.Close>
                    <AlertDialog.Close onClick={on.onHangUp} className={button({ tone: "danger" })}>
                      End call
                    </AlertDialog.Close>
                  </div>
                </AlertDialog.Popup>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          </footer>
        )}
      </>
    );
  } else if (status === "generating") {
    body = (
      <main tabIndex={-1} className="flex flex-1 flex-col items-center justify-center-safe gap-8 overflow-y-auto px-4 py-10 outline-none">
        {crisis && <CrisisPanel />}
        <VoiceOrb mode={orbMode(state)} label={text} getLevels={getLevels} />
        <h1 className="sr-only">{text}</h1>
        <button type="button" onClick={on.onOpenPages} className={button({ tone: "quiet", size: "lg" })}>
          Your pages
        </button>
      </main>
    );
  } else {
    body = (
      <main tabIndex={-1} className="flex flex-1 flex-col items-center justify-center-safe overflow-y-auto px-6 py-12 outline-none">
        {status === "staleCall" && staleCall ? (
          <StaleCallPrompt startedAt={staleCall.started_at} onEnd={on.onEndStaleCall} />
        ) : status === "micBlocked" ? (
          <MicCheck variant="blocked" onRetry={on.onRetryMic} onWrite={on.onStartText ? handleWrite : undefined} />
        ) : (
          <div className="flex max-w-md flex-col items-center gap-8 text-center">
            <div className="space-y-3">
              <h1 className="font-serif text-4xl leading-tight tracking-tight text-balance">What's on your mind?</h1>
              <p className="text-ui leading-relaxed text-pretty text-muted">
                Talk it through, or write it out. When it helps, we'll look at it through a few philosophical perspectives,
                drawn from the Stanford Encyclopedia of Philosophy.
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <button type="button" onClick={on.onStart} className={button({ tone: "primary", size: "lg" })}>
                Start call
              </button>
              {on.onStartText && (
                <button type="button" onClick={on.onStartText} className={button({ tone: "quiet", size: "lg" })}>
                  Write instead
                </button>
              )}
              <button type="button" onClick={on.onOpenPages} className={button({ tone: "ghost" })}>
                Your pages
              </button>
              {on.onSignOut && (
                <button type="button" onClick={on.onSignOut} className={button({ tone: "ghost" })}>
                  {accountName ? `Sign out (${accountName})` : "Sign out"}
                </button>
              )}
            </div>
            {libraryReady !== undefined && (
              <p className="flex items-center gap-2 text-xs text-muted">
                <span aria-hidden="true" className={clsx("size-1.5 shrink-0 rounded-full", libraryReady ? "bg-accent" : "bg-line")} />
                {libraryReady ? "The encyclopedia is ready." : "The encyclopedia is waking up. You can begin; it'll be ready when we need it."}
              </p>
            )}
          </div>
        )}
      </main>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-dvh flex-col overflow-hidden">
        <p role="status" aria-live="polite" className="sr-only">
          {text}
        </p>
        {body}
      </div>
    </MotionConfig>
  );
}
