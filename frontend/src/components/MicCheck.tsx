import { button } from "./button";

const COPY = {
  blocked: {
    title: "We can't hear you yet",
    body: "Microphone access is blocked. Allow it from the icon in your browser's address bar, then try again.",
    action: "Try again",
  },
  lost: {
    title: "Your microphone stopped",
    body: "The call is still open. Turn your microphone back on to keep talking.",
    action: "Turn mic back on",
  },
};

export default function MicCheck({
  variant,
  onRetry,
  onWrite,
}: {
  variant: keyof typeof COPY;
  onRetry: () => void;
  onWrite?: () => void;
}) {
  const copy = COPY[variant];
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-line px-6 py-5 text-center">
      <div>
        <h2 className="font-serif text-xl">{copy.title}</h2>
        <p className="mt-1 text-ui leading-relaxed text-muted">{copy.body}</p>
      </div>
      <button type="button" onClick={onRetry} className={button({ tone: "primary" })}>
        {copy.action}
      </button>
      {variant === "blocked" && onWrite && (
        <button type="button" onClick={onWrite} className={button()}>
          Write instead
        </button>
      )}
    </div>
  );
}
