import clsx from "clsx";
import { m } from "motion/react";

import type { Status } from "../state/callStore";

const STEPS: { label: string; on: Status[] }[] = [
  { label: "Listen", on: ["listen"] },
  { label: "Explore", on: ["mapping", "explore"] },
  { label: "Synthesize", on: ["synthesize"] },
  { label: "Close", on: ["ending"] },
];

export default function PhaseIndicator({ status }: { status: Status }) {
  const current = STEPS.findIndex((s) => s.on.includes(status));

  return (
    <ol aria-label="Call phase" className="flex flex-wrap items-center justify-center gap-1 sm:gap-2">
      {STEPS.map((step, i) => {
        const active = i === current;
        return (
          <li key={step.label} aria-current={active ? "step" : undefined} className="flex flex-wrap items-center justify-center gap-1 sm:gap-2">
            {i > 0 && <span aria-hidden="true" className="hidden h-px w-6 bg-line sm:block" />}
            <span
              className={clsx(
                "relative px-1.5 pb-2 text-overline font-medium tracking-[0.14em] uppercase transition-colors duration-300",
                active ? "text-ink" : "text-muted",
              )}
            >
              {step.label}
              {active && (
                <m.span
                  layoutId="phase-mark"
                  transition={{ type: "spring", duration: 0.5, bounce: 0 }}
                  aria-hidden="true"
                  className={clsx(
                    "absolute bottom-0 left-1/2 -ml-0.5 size-1 rounded-full bg-accent",
                    status === "mapping" && "motion-safe:animate-pulse",
                  )}
                />
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
