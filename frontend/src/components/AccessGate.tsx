import clsx from "clsx";
import { useRef, useState, type FormEvent } from "react";

import { fetchJson, HttpError } from "../api";
import { button } from "./button";

const ERRORS: Record<number, string> = {
  401: "That passphrase didn't work. Try again.",
  429: "Too many attempts. Try again in a few minutes.",
};

export default function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await fetchJson("/api/login", { passphrase });
      onUnlocked();
    } catch (e) {
      if (e instanceof HttpError) setError(ERRORS[e.status] ?? "Couldn't check the passphrase. Try again.");
      else setError("Couldn't reach the server. Check your connection.");
      input.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <main tabIndex={-1} className="grid min-h-dvh place-items-center px-6 outline-none">
      <form onSubmit={submit} className="w-full max-w-sm space-y-6">
        <h1 className="font-serif text-3xl tracking-tight text-balance">A conversation awaits.</h1>
        <div className="space-y-2">
          <label htmlFor="passphrase" className="block text-sm text-muted">
            Passphrase
          </label>
          <input
            id="passphrase"
            ref={input}
            name="passphrase"
            type="password"
            autoComplete="current-password"
            required
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "gate-error" : undefined}
            className="h-14 w-full rounded-full border border-line-strong bg-transparent px-5 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          />
          {error && (
            <p id="gate-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <button
          type="submit"
          aria-disabled={pending || undefined}
          className={clsx(button({ tone: "primary", size: "lg" }), "w-full")}
        >
          {pending ? "Checking…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
