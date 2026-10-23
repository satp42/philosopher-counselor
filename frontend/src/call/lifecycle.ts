import { fetchJson, HttpError } from "../api";
import type { CallStore, Modality } from "../state/callStore";
import type { Metrics } from "../live/metrics";
import type { Recorder } from "../live/recorder";

export const HEARTBEAT_MS = 5 * 60_000;

export type Request = (path: string, body?: unknown, method?: "DELETE") => Promise<any>;

export interface LifecycleDeps {
  store: CallStore;
  request: Request;
  notify(message: string): void;
}

/**
 * Makes sure an active record of `modality` backs the store, and returns its id.
 * Null when the store moved to staleCall or creation failed.
 */
export async function openCall(deps: LifecycleDeps, modality: Modality): Promise<string | null> {
  const current = deps.store.getState();
  deps.store.setState({ modality });
  if (current.callId && current.modality === modality) return current.callId;
  if (current.callId) {
    await deps.request(`/api/calls/${current.callId}`, undefined, "DELETE").catch(() => {});
    deps.store.setState({ callId: null });
  }
  try {
    const { id } = await deps.request("/api/calls", { modality });
    deps.store.setState({ callId: id });
    return id;
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      deps.store.setState({ staleCall: error.body?.detail });
      deps.store.getState().transition("staleCall");
    } else {
      deps.notify("Couldn't start a conversation. Try again.");
    }
    return null;
  }
}

/** Ends the call the stale prompt is showing. True when a new call may start. */
export async function endStaleCall(deps: LifecycleDeps): Promise<boolean> {
  const stale = deps.store.getState().staleCall;
  if (!stale) return false;
  try {
    await deps.request(`/api/calls/${stale.active_id}/end`, { interrupted: true });
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404)) {
      deps.notify("Couldn't end the open call. Try again.");
      return false;
    }
  }
  deps.store.setState({ staleCall: null });
  return true;
}

export interface Closing {
  callId: string;
  recorder: Recorder;
  interrupted: boolean;
  notice?: string;
  /** Voice turn-taking metrics. Text passes nothing, so its record never rewards the bandit. */
  metrics?: Metrics;
}

/** The one end sequence for voice and text: flag, ending, metrics, flush, end, generating. */
export async function closeCall(deps: LifecycleDeps, closing: Closing): Promise<void> {
  if (closing.interrupted) {
    closing.recorder.record({ type: "flag", flag: "interrupted" });
    if (closing.notice) deps.notify(closing.notice);
  }
  deps.store.getState().transition("ending");
  if (closing.metrics) closing.recorder.record({ type: "metrics", metrics: closing.metrics });
  await closing.recorder.end();
  await deps.request(`/api/calls/${closing.callId}/end`, { interrupted: closing.interrupted }).catch((error) =>
    console.warn("call: end failed", error),
  );
  deps.store.getState().transition("generating");
}

/** Keeps the encyclopedia warm while a call is open. Returns the stopper. */
export function keepLibraryWarm(request: Request = fetchJson): () => void {
  const timer = setInterval(() => void request("/api/warm", {}).catch(() => {}), HEARTBEAT_MS);
  return () => clearInterval(timer);
}
