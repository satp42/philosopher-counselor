import clsx from "clsx";

import { button } from "./button";

export interface AccessGateProps {
  loginUrl?: string;
  error?: string | null;
}

export default function AccessGate({ loginUrl = "/api/auth/login", error }: AccessGateProps) {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const authError = error ?? (params?.get("error") ? "Couldn't sign you in. Try again." : null);

  return (
    <main tabIndex={-1} className="grid min-h-dvh place-items-center px-6 outline-none">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="font-serif text-3xl tracking-tight text-balance">A conversation awaits.</h1>
          <p className="text-ui leading-relaxed text-pretty text-muted">
            Sign in with your account to keep your conversations, pages, and memory in your own space.
          </p>
        </div>
        {authError && (
          <p id="gate-error" role="alert" className="text-sm text-danger">
            {authError}
          </p>
        )}
        <a
          href={loginUrl}
          aria-describedby={authError ? "gate-error" : undefined}
          className={clsx(button({ tone: "primary", size: "lg" }), "w-full")}
        >
          Continue with OAuth
        </a>
      </div>
    </main>
  );
}
