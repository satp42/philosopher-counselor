import { button } from "./button";

function formatStart(seconds: number) {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function StaleCallPrompt({ startedAt, onEnd }: { startedAt: number; onEnd: () => void }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-5 text-center">
      <div>
        <h2 className="font-serif text-2xl leading-tight text-balance">
          A call from <time dateTime={new Date(startedAt * 1000).toISOString()}>{formatStart(startedAt)}</time> is still
          open
        </h2>
        <p className="mt-2 text-ui leading-relaxed text-muted">
          Ending it will write its page from what was said, then start a new call.
        </p>
      </div>
      <button type="button" onClick={onEnd} className={button({ tone: "primary", size: "lg" })}>
        End it and start a new call
      </button>
    </div>
  );
}
