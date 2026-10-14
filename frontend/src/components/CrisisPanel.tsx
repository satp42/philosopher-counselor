import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { CRISIS_RESOURCES } from "../config";
import { button } from "./button";

export const COLLAPSE_AFTER_MS = 60_000;

const external = (href: string) => (href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {});

export function ResourceList({ className }: { className: string }) {
  return (
    <ul className={className}>
      {CRISIS_RESOURCES.map((r) => (
        <li key={r.name} className="border-t border-paper/15 pt-4 first:border-t-0 first:pt-0">
          <p className="font-medium">{r.name}</p>
          <p className="text-sm text-paper/70">{r.detail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {r.actions.map((a) => (
              <a key={a.href} href={a.href} {...external(a.href)} className={button({ tone: "inverse" })}>
                {a.label}
                {a.href.startsWith("https://") && <span className="sr-only"> (opens in a new tab)</span>}
              </a>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function CrisisPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    ref.current?.focus();
    const timer = setTimeout(() => {
      const hadFocus = ref.current?.contains(document.activeElement);
      setCollapsed(true);
      if (hadFocus) ref.current?.focus();
    }, COLLAPSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const [primary] = CRISIS_RESOURCES;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby="crisis-title"
      className={clsx(
        "w-full max-w-md bg-ink text-paper outline-none transition-opacity duration-300 ease-out-soft focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper starting:opacity-0",
        collapsed ? "rounded-[28px]" : "rounded-3xl",
      )}
    >
      {collapsed ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pr-1.5 pl-5">
          <p id="crisis-title" className="text-sm font-medium">
            Support is here, any time.
          </p>
          <div className="ms-auto flex flex-wrap justify-end gap-2">
            {primary.actions.map((a) => (
              <a key={a.href} href={a.href} className={button({ tone: "inverse" })}>
                {a.label}
              </a>
            ))}
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-expanded={false}
              className="min-h-11 rounded-full px-3 text-sm text-paper/80 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-paper"
            >
              All resources
            </button>
          </div>
        </div>
      ) : (
        <div className="p-6">
          <h2 id="crisis-title" className="font-serif text-2xl leading-tight text-balance">
            You don't have to carry this alone.
          </h2>
          <p className="mt-2 text-ui leading-relaxed text-paper/80">
            If you might hurt yourself, or you're thinking about ending your life, please reach out now. Someone trained
            is ready to listen, day or night.
          </p>
          <ResourceList className="mt-5 space-y-4" />
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            className="mt-4 min-h-11 rounded-full px-3 text-sm text-paper/80 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-paper"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  );
}
