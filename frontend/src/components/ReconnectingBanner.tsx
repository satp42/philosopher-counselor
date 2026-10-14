import { m } from "motion/react";

export default function ReconnectingBanner() {
  return (
    <m.div
      initial={{ opacity: 0, y: "-100%" }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: "-100%", transition: { duration: 0.15, ease: "easeOut" } }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
      className="flex shrink-0 justify-center px-4 pt-[max(0.75rem,env(safe-area-inset-top))]"
    >
      <p className="flex items-center gap-2.5 rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg shadow-black/10">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
        Reconnecting… your mic is paused
      </p>
    </m.div>
  );
}
