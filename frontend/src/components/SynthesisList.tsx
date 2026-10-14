import { Dialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { fetchJson } from "../api";
import { button } from "./button";

export interface CallSummary {
  id: string;
  started_at: number;
  status: string;
  title: string | null;
}

export const PENDING = new Set(["active", "ending", "generating"]);

const STATUS: Record<string, string> = {
  active: "Still open",
  ending: "Writing…",
  generating: "Writing…",
  failed: "Couldn't be written",
};

export const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

export async function retryPage(id: string): Promise<string | null> {
  try {
    return (await fetchJson(`/api/calls/${id}/retry`, {})).status;
  } catch {
    toast.error("Couldn't start writing the page again. Try again in a moment.", { duration: Infinity });
    return null;
  }
}

export default function SynthesisList({ onOpen, onBack }: { onOpen(id: string): void; onBack(): void }) {
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState<CallSummary | null>(null);

  useEffect(() => {
    fetchJson("/api/calls").then(setCalls, () => setLoadFailed(true));
  }, []);

  async function remove(call: CallSummary) {
    setConfirming(null);
    try {
      await fetchJson(`/api/calls/${call.id}`, undefined, "DELETE");
      setCalls((cs) => cs && cs.filter((c) => c.id !== call.id));
      toast("Page deleted.");
      document.querySelector<HTMLElement>("main")?.focus();
    } catch {
      toast.error("Couldn't delete that page. It's still here; try again in a moment.", { duration: Infinity });
    }
  }

  async function retry(id: string) {
    const status = await retryPage(id);
    if (status) setCalls((cs) => cs && cs.map((c) => (c.id === id ? { ...c, status } : c)));
  }

  return (
    <main tabIndex={-1} className="mx-auto w-full max-w-xl outline-none px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-16 sm:px-6">
      <button type="button" onClick={onBack} className={clsx(button({ tone: "ghost" }), "-ml-5")}>
        <span aria-hidden="true">←</span> Back to call
      </button>
      <h1 className="mt-4 mb-8 font-serif text-4xl leading-tight tracking-tight">Your pages</h1>

      <p role="status" className={loadFailed ? "text-ui text-muted" : "sr-only"}>
        {loadFailed ? "Your pages couldn't be loaded. Refresh to try again." : calls ? "" : "Loading your pages…"}
      </p>

      {calls && !calls.length && (
        <div className="flex flex-col items-start gap-6 rounded-3xl border border-line p-6">
          <div className="space-y-2">
            <h2 className="font-serif text-2xl">No pages yet</h2>
            <p className="text-ui leading-relaxed text-pretty text-muted">
              After a call, a page with what you talked through, and the perspectives you explored, appears here to
              reread.
            </p>
          </div>
          <button type="button" onClick={onBack} className={button({ tone: "primary" })}>
            Start your first call
          </button>
        </div>
      )}

      {calls && calls.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {calls.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2">
              <button
                type="button"
                disabled={c.status === "active"}
                onClick={() => onOpen(c.id)}
                className="-ms-3 min-h-14 min-w-0 flex-1 rounded-2xl px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-line/40 focus-visible:ring-2 focus-visible:ring-accent disabled:text-muted disabled:hover:bg-transparent"
              >
                <span className="line-clamp-2 font-serif text-lg leading-snug [overflow-wrap:anywhere]">{c.title || "A conversation"}</span>
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-sm text-muted">
                  <span>{formatDate(c.started_at)}</span>
                  {STATUS[c.status] && (
                    <span className={clsx(c.status === "failed" && "text-danger")}>· {STATUS[c.status]}</span>
                  )}
                </span>
              </button>
              {c.status === "failed" && (
                <button
                  type="button"
                  onClick={() => retry(c.id)}
                  aria-label={`Write the page again: ${c.title || "A conversation"} from ${formatDate(c.started_at)}`}
                  className={button()}
                >
                  Write the page again
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirming(c)}
                aria-label={`Delete page “${c.title || "A conversation"}” from ${formatDate(c.started_at)}`}
                className={clsx(button({ tone: "ghost" }), "-me-5")}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog.Root open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-30 bg-ink/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-40 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-paper p-6 shadow-2xl outline-none transition-[opacity,scale] duration-200 ease-out-soft motion-safe:data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:scale-95 data-[starting-style]:opacity-0 dark:shadow-[0_0_0_1px_oklch(1_0_0/0.08)]">
            <Dialog.Title className="font-serif text-2xl [overflow-wrap:anywhere]">Delete “{confirming?.title || "A conversation"}”?</Dialog.Title>
            <Dialog.Description className="mt-2 text-ui leading-relaxed text-muted">
              The page and the conversation it came from are removed for good.
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className={button()}>Keep it</Dialog.Close>
              <button type="button" onClick={() => confirming && remove(confirming)} className={button({ tone: "danger" })}>
                Delete
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
