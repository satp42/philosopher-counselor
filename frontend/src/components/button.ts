import { cva } from "class-variance-authority";

export const button = cva(
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full border border-transparent px-5 text-ui font-medium transition-[scale,background-color,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper enabled:active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  {
    variants: {
      tone: {
        primary: "bg-ink text-paper",
        quiet: "border-line text-ink hover:bg-line/40",
        danger: "bg-danger text-paper",
        inverse: "bg-paper text-ink focus-visible:ring-paper focus-visible:ring-offset-ink",
        ghost: "text-muted hover:text-ink",
      },
      size: {
        md: "",
        lg: "min-h-14 px-7 text-base",
      },
    },
    defaultVariants: { tone: "quiet", size: "md" },
  },
);
