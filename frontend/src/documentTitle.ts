export type AppAuth = "checking" | "locked" | "unlocked";
export type AppViewName = "call" | "pages" | "page";

const VIEW_LABEL: Record<AppViewName, string> = {
  call: "Call",
  pages: "Your pages",
  page: "Page",
};

/** Plain title until the access gate unlocks — avoids leaking view names on the lock screen. */
export const documentTitle = (view: AppViewName, auth: AppAuth): string => {
  if (auth !== "unlocked") return "Philosopher";
  return `${VIEW_LABEL[view]} · Philosopher`;
};
