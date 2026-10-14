import { createStore } from "zustand/vanilla";

export type Status =
  | "gate"
  | "idle"
  | "micBlocked"
  | "staleCall"
  | "connecting"
  | "listen"
  | "mapping"
  | "explore"
  | "synthesize"
  | "crisis"
  | "ending"
  | "generating";

export type Connection = "connecting" | "live" | "reconnecting";

export type Stance = "aligned" | "challenges";
export type GuidePhase = "listen" | "explore" | "synthesize" | "end";

export interface Lens {
  lens_id: string;
  tradition: string;
  stance: Stance;
  grounded: boolean;
}

export interface Card {
  passage_id: string;
  entry_title: string;
  section_path: string;
  url: string;
  excerpt: string;
  lens_id?: string;
}

export const ALSO = "also";

export const CONVERSING = new Set<Status>(["listen", "mapping", "explore", "synthesize", "crisis"]);
export const IN_CALL = new Set<Status>(["connecting", ...CONVERSING, "ending"]);

const NEXT: Record<Status, Status[]> = {
  gate: ["idle"],
  idle: ["micBlocked", "staleCall", "connecting"],
  micBlocked: ["idle"],
  staleCall: ["idle"],
  connecting: ["listen", "ending"],
  listen: ["mapping", "synthesize", "ending", "crisis"],
  mapping: ["explore", "listen", "ending", "crisis"],
  explore: ["listen", "synthesize", "ending", "crisis"],
  synthesize: ["explore", "ending", "crisis"],
  crisis: ["ending"],
  ending: ["generating"],
  generating: [],
};

const initial = {
  status: "gate" as Status,
  connection: "connecting" as Connection,
  callId: null as string | null,
  summary: "",
  leaning: "",
  lensPlan: [] as Lens[],
  cards: {} as Record<string, Card[]>,
  archivedCards: [] as Card[],
  staleCall: null as { active_id: string; started_at: number } | null,
  crisis: false,
  micLost: false,
  muted: false,
  consulting: false,
};

export type CallData = typeof initial;

export interface CallState extends CallData {
  transition(to: Status): boolean;
  setPhase(phase: GuidePhase): void;
  addCards(cards: Card[]): void;
  reset(): void;
}

export function createCallStore(data: Partial<CallData> = {}) {
  return createStore<CallState>()((set, get) => ({
    ...initial,
    ...data,

    transition(to) {
      const { status: from, cards, archivedCards } = get();
      if (from === to) return true;
      if (!NEXT[from].includes(to)) {
        console.warn(`call: ignored transition ${from} -> ${to}`);
        return false;
      }
      const patch: Partial<CallData> = { status: to };
      if (to === "crisis") patch.crisis = true;
      if (from === "explore" && to === "listen") {
        const { [ALSO]: also, ...lensCards } = cards;
        patch.lensPlan = [];
        patch.cards = also ? { [ALSO]: also } : {};
        patch.archivedCards = [...archivedCards, ...Object.values(lensCards).flat()];
      }
      set(patch);
      return true;
    },

    setPhase(phase) {
      if (phase === "end" && get().status === "crisis") return;
      get().transition(phase === "end" ? "ending" : phase);
    },

    addCards(added) {
      const { lensPlan } = get();
      const cards = { ...get().cards };
      for (const card of added) {
        const key = lensPlan.some((l) => l.lens_id === card.lens_id) ? card.lens_id! : ALSO;
        const group = cards[key] ?? [];
        if (!group.some((c) => c.passage_id === card.passage_id)) cards[key] = [...group, card];
      }
      set({ cards });
    },

    reset() {
      set({ ...initial, status: "idle" });
    },
  }));
}

export type CallStore = ReturnType<typeof createCallStore>;

export const callStore = createCallStore();
