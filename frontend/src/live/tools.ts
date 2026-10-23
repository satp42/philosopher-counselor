import type { CallStore, Card, GuidePhase, Lens } from "../state/callStore";
import type { RecorderEvent } from "./recorder";

// Names must match backend/guide/tools.py.
export interface ToolCall {
  id: string;
  name: string;
  args?: Record<string, any>;
}

export interface ToolResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface Passage {
  passage_id: string;
  slug: string;
  entry_title: string;
  section_path: string;
  url: string;
  text: string;
  excerpt: string;
  score: number;
}

interface LensMapResult {
  lenses: (Lens & { passages: Passage[] })[];
  challenges_grounded: boolean;
}

export interface DispatcherDeps {
  store: CallStore;
  /**
   * Hands responses to the model. Call `delivered` once the model has them: voice right after the socket send,
   * text when the request carrying them succeeds. Cards and the ack wait for it.
   */
  sendToolResponse(responses: ToolResponse[], delivered: () => void): void;
  fetchJson(path: string, body: unknown): Promise<any>;
  record(event: RecorderEvent): void;
  notify(message: string): void;
}

export const LENS_MAP_TIMEOUT_MS = 10_000;
export const RETRIEVE_TIMEOUT_MS = 3_000;
const CONSULTING_TOOLS = new Set(["consult_sep", "map_lenses"]);
const CARE_ONLY = { error: "Care-only mode: no philosophy for the rest of this call." };

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const forModel = ({ passage_id, entry_title, section_path, text }: Passage) => ({
  passage_id,
  entry_title,
  section_path,
  text,
});

const toCard = ({ passage_id, entry_title, section_path, url, excerpt }: Passage, lens_id?: string): Card => ({
  passage_id,
  entry_title,
  section_path,
  url,
  excerpt,
  lens_id,
});

export function createDispatcher({ store, sendToolResponse, fetchJson, record, notify }: DispatcherDeps) {
  let generation = 0;
  const seen = new Set<string>();
  const pending = new Map<string, string>();
  const get = store.getState;

  const context = () => {
    const { summary, leaning, lensPlan } = get();
    return { summary, leaning, lens_plan: lensPlan };
  };

  const live = (id: string, gen: number) => gen === generation && pending.has(id);

  function drop(ids: Iterable<string>) {
    for (const id of ids) pending.delete(id);
    if (get().status === "mapping" && ![...pending.values()].includes("map_lenses")) get().transition("listen");
  }

  function deliver(call: ToolCall, gen: number, response: Record<string, unknown>, cards: Card[] = []) {
    if (!live(call.id, gen)) return;
    drop([call.id]);
    sendToolResponse([{ id: call.id, name: call.name, response }], () => {
      if (!cards.length) return;
      get().addCards(cards);
      record({ type: "ack", passage_ids: cards.map((c) => c.passage_id) });
    });
  }

  const handlers: Record<string, (call: ToolCall, gen: number) => void | Promise<void>> = {
    update_situation(call, gen) {
      const { summary = "", leaning = "" } = call.args ?? {};
      store.setState({ summary, leaning });
      record({ type: "summary", summary, leaning });
      deliver(call, gen, context());
    },

    set_phase(call, gen) {
      get().setPhase(call.args?.phase as GuidePhase);
      deliver(call, gen, { phase: get().status, ...context() });
    },

    signal_crisis(call, gen) {
      record({ type: "flag", flag: "crisis" });
      get().transition("crisis");
      deliver(call, gen, { ok: true });
    },

    // Re-checked after each await: a lookup that started before the crisis must not deliver philosophy either.
    async consult_sep(call, gen) {
      if (get().crisis) return deliver(call, gen, CARE_ONLY);
      const { query, lens_id } = call.args ?? {};
      let passages: Passage[] | null = null;
      try {
        const body = { call_id: get().callId, query, lens_id };
        ({ passages } = await withTimeout(fetchJson("/api/retrieve", body), RETRIEVE_TIMEOUT_MS));
      } catch {}
      if (get().crisis) return deliver(call, gen, CARE_ONLY);
      if (!passages) return deliver(call, gen, { error: "The encyclopedia lookup failed. Continue without it." });
      deliver(call, gen, { passages: passages.map(forModel) }, passages.map((p) => toCard(p, lens_id)));
    },

    async map_lenses(call, gen) {
      if (get().crisis) return deliver(call, gen, CARE_ONLY);
      if (!get().transition("mapping")) {
        return deliver(call, gen, { error: "Lens mapping is only available while listening.", ...context() });
      }
      const body = { call_id: get().callId, lenses: call.args?.lenses ?? [] };
      const attempt = () => withTimeout<LensMapResult>(fetchJson("/api/lens-map", body), LENS_MAP_TIMEOUT_MS);
      let result: LensMapResult | null = null;
      try {
        result = await attempt().catch(attempt);
      } catch {}
      if (get().crisis) return deliver(call, gen, CARE_ONLY);
      if (!live(call.id, gen)) return;
      if (!result) {
        notify("Couldn't gather the philosophical perspectives just now. The call continues.");
        return deliver(call, gen, { error: "Lens mapping failed. Keep listening; you may try again later.", ...context() });
      }
      store.setState({ lensPlan: result.lenses.map(({ passages, ...l }) => l) });
      // Explore before delivering, so settling the pending call doesn't read as an abandoned mapping.
      get().transition("explore");
      const lenses = result.lenses.map(({ passages, ...l }) => ({ ...l, passages: passages.map(forModel) }));
      const cards = result.lenses.flatMap((l) => l.passages.map((p) => toCard(p, l.lens_id)));
      deliver(call, gen, { lenses, challenges_grounded: result.challenges_grounded, ...context() }, cards);
    },
  };

  return {
    dispatch(calls: ToolCall[]) {
      return Promise.all(
        calls.map((call) => {
          if (seen.has(call.id)) return;
          seen.add(call.id);
          pending.set(call.id, call.name);
          if (CONSULTING_TOOLS.has(call.name)) store.setState({ consulting: true });
          const handler = handlers[call.name];
          return handler ? handler(call, generation) : deliver(call, generation, { error: `Unknown tool ${call.name}` });
        }),
      );
    },

    cancel: (ids: string[]) => drop(ids),

    newSession() {
      generation++;
      seen.clear();
      drop([...pending.keys()]);
    },

    consulting: () => [...pending.values()].some((name) => CONSULTING_TOOLS.has(name)),
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
