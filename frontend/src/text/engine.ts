import { fetchJson, HttpError } from "../api";
import { closeCall, endStaleCall, keepLibraryWarm, openCall, type LifecycleDeps } from "../call/lifecycle";
import { createRecorder, type Recorder, type RecorderDeps } from "../live/recorder";
import { createDispatcher, withTimeout, type Dispatcher, type ToolResponse } from "../live/tools";
import { CONVERSING, type CallStore } from "../state/callStore";
import {
  attach,
  guideItem,
  nextStep,
  parseReply,
  toWire,
  visibleMessages,
  type GuideReply,
  type GuideState,
  type ThreadItem,
} from "./thread";

export const CONVERSE_TIMEOUT_MS = 60_000;
export const GOODBYE_MS = 8_000;
/** Model replies after tools, with no new line from the person, before the turn comes back. */
export const MAX_TOOL_ROUNDS = 6;

const LIMIT = "This conversation reached its length limit, so it ended. Your page is being written from what was said.";
const HOP_NOTICE = "The guide paused so you can write next. Send another message, or end the conversation.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface VisibleLine {
  role: "user" | "guide";
  text: string;
  pending: boolean;
}

/** The only view the screen reads. The thread, memos, and tool results stay inside the engine. */
export interface TextView {
  lines: readonly VisibleLine[];
  guide: GuideState;
  canSend: boolean;
  notice: string | null;
}

export interface TextEngineDeps {
  store: CallStore;
  fetchJson?: LifecycleDeps["request"];
  post?: RecorderDeps["post"];
  notify?(message: string): void;
}

export interface TextEngine {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TextView;
  onStart(): Promise<void>;
  onSend(text: string): void;
  onRetry(): void;
  onHangUp(): Promise<void>;
  onEndStaleCall(): Promise<void>;
}

type Life = "idle" | "open" | "closing" | "closed";
type Outcome = "replied" | "withheld" | "failed" | "ended";

const EMPTY: TextView = { lines: [], guide: "idle", canSend: false, notice: null };

function sameView(left: TextView, right: TextView): boolean {
  if (left.guide !== right.guide || left.canSend !== right.canSend || left.notice !== right.notice) return false;
  if (left.lines.length !== right.lines.length) return false;
  return left.lines.every((line, index) => {
    const other = right.lines[index];
    return line.role === other.role && line.text === other.text && line.pending === other.pending;
  });
}

export function createTextEngine(deps: TextEngineDeps): TextEngine {
  const request = deps.fetchJson ?? fetchJson;
  const notify = deps.notify ?? (() => {});
  const lifecycle: LifecycleDeps = { store: deps.store, request, notify };

  let life: Life = "idle";
  let starting = false;
  let notice: string | null = null;
  let callId = "";
  let recorder: Recorder | null = null;
  let dispatcher: Dispatcher | null = null;
  let pumping = false;
  let asking = false;
  let dispatching: Promise<unknown> = Promise.resolve();
  let undelivered: Array<() => void> = [];
  let unsubscribe = () => {};
  let stopWarm = () => {};
  let items: ThreadItem[] = [];
  let queued: string[] = [];
  let guide: GuideState = "idle";

  const listeners = new Set<() => void>();
  let snapshot: TextView = EMPTY;

  function project(): TextView {
    const status = deps.store.getState().status;
    return {
      lines: [
        ...visibleMessages(items).map((line) => ({ ...line, pending: false })),
        ...queued.map((text) => ({ role: "user" as const, text, pending: true })),
      ],
      guide,
      canSend: life === "open" && CONVERSING.has(status),
      notice,
    };
  }

  function publish() {
    const next = project();
    if (sameView(snapshot, next)) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function setGuide(next: GuideState) {
    guide = next;
    publish();
  }

  function commit(texts: string[]) {
    if (!recorder) return;
    for (const text of texts) {
      items = [...items, { kind: "user", text }];
      recorder.turn("user", text);
    }
    if (texts.length) void recorder.flush();
    publish();
  }

  function sendToolResponse(responses: ToolResponse[], delivered: () => void) {
    if (life === "closed") return;
    items = attach(items, responses);
    undelivered.push(delivered);
    publish();
  }

  async function postConverse(timeout: number): Promise<GuideReply> {
    const once = () =>
      withTimeout(request("/api/converse", { call_id: callId, history: toWire(items) }), timeout).then(parseReply);
    try {
      return await once();
    } catch (error) {
      if (error instanceof HttpError && (error.status === 409 || error.status === 429 || error.status < 500)) throw error;
      await sleep(1000);
      return once();
    }
  }

  async function ask(timeout: number, dispatchCalls = true): Promise<Outcome> {
    const acks = undelivered.splice(0);
    asking = true;
    setGuide("writing");
    let reply: GuideReply;
    try {
      reply = await postConverse(timeout);
    } catch (error) {
      undelivered.unshift(...acks);
      asking = false;
      if (error instanceof HttpError && error.status === 409) {
        void finish(false);
        return "ended";
      }
      if (error instanceof HttpError && error.status === 429) {
        void finish(true, LIMIT);
        return "ended";
      }
      setGuide("failed");
      return "failed";
    }
    asking = false;
    if (life === "closed" || (life === "closing" && dispatchCalls)) return "ended";
    acks.forEach((ack) => ack());
    const pending = queued.splice(0);
    if (reply.kind === "withheld") {
      commit(pending);
      setGuide("withheld");
      return "withheld";
    }
    const guideTurn = guideItem(reply);
    const stored = dispatchCalls ? guideTurn : { ...guideTurn, exchanges: [] };
    items = [...items, stored];
    recorder?.turn("guide", guideTurn.text);
    deps.store.setState({ consulting: false });
    commit(pending);
    setGuide(stored.exchanges.length ? "writing" : "idle");
    if (dispatchCalls && stored.exchanges.length && dispatcher) {
      // Assigned before the batch. set_phase(end) runs finish inside dispatch, and finish must await this batch.
      dispatching = Promise.resolve().then(() => dispatcher!.dispatch(stored.exchanges.map((exchange) => exchange.call)));
      await dispatching;
      if (!dispatcher.consulting()) deps.store.setState({ consulting: false });
      publish();
    }
    return "replied";
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    let hops = 0;
    try {
      while (life === "open" && nextStep(items) === "request") {
        const fromPerson = items.at(-1)?.kind === "user";
        if (!fromPerson && hops >= MAX_TOOL_ROUNDS) {
          notice = HOP_NOTICE;
          setGuide("idle");
          return;
        }
        const before = items.length;
        const outcome = await ask(CONVERSE_TIMEOUT_MS);
        // A withheld reply adds nothing. Continue only when a message typed during that request was committed.
        if (outcome === "withheld") {
          if (items.length > before) continue;
          return;
        }
        if (outcome !== "replied") return;
        if (fromPerson) {
          hops = 0;
          notice = null;
        } else hops += 1;
      }
    } finally {
      pumping = false;
      publish();
    }
  }

  async function finish(interrupted: boolean, noticeText?: string, goodbye = false) {
    if (life !== "open" || !recorder) return;
    life = "closing";
    unsubscribe();
    stopWarm();
    publish();
    if (goodbye) {
      await withTimeout(dispatching, GOODBYE_MS).catch(() => {});
      const last = [...items].reverse().find((item) => item.kind === "guide");
      if (life === "closing" && last?.kind === "guide" && !last.text && nextStep(items) === "request") {
        await ask(GOODBYE_MS, false);
      }
    }
    if (life !== "closing") return;
    life = "closed";
    commit(queued.splice(0));
    setGuide("idle");
    await closeCall(lifecycle, { callId, recorder, interrupted, notice: noticeText });
  }

  async function onStart() {
    if (starting || life === "open" || life === "closing" || deps.store.getState().status !== "idle") return;
    starting = true;
    try {
      const id = await openCall(lifecycle, "text");
      if (!id) return;
      callId = id;
      items = [];
      queued = [];
      guide = "idle";
      notice = null;
      undelivered = [];
      life = "open";
      recorder = createRecorder({
        callId,
        store: deps.store,
        post: deps.post,
        onCallEnded: () => void finish(false),
      });
      dispatcher = createDispatcher({
        store: deps.store,
        sendToolResponse,
        fetchJson: request,
        record: (event) => recorder?.record(event),
        notify,
      });
      unsubscribe = deps.store.subscribe((state, prev) => {
        if (state.status === "ending" && prev.status !== "ending") void finish(false, undefined, true);
        publish();
      });
      stopWarm = keepLibraryWarm(request);
      deps.store.getState().transition("connecting");
      deps.store.getState().transition("listen");
      publish();
    } finally {
      starting = false;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    onStart,
    onSend(text) {
      const trimmed = text.trim();
      if (!trimmed || life !== "open") return;
      if (asking) {
        queued = [...queued, trimmed];
        publish();
        return;
      }
      commit([trimmed]);
      void pump();
    },
    onRetry() {
      if (life !== "open" || asking) return;
      notice = null;
      void pump();
    },
    onHangUp: () => finish(false),
    async onEndStaleCall() {
      if (!(await endStaleCall(lifecycle))) return;
      deps.store.getState().transition("idle");
      await onStart();
    },
  };
}
