import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchJson } from "../api";
import { callStore, type CallStore } from "../state/callStore";
import { createTextEngine } from "../text/engine";
import { createAudio } from "./audio";
import { createCallEngine } from "./session";

export const WARM_POLL_MS = 5_000;

interface Options {
  unlocked: boolean;
  onCallEnded?(callId: string): void;
  store?: CallStore;
}

export function useCallEngine({ unlocked, onCallEnded, store = callStore }: Options) {
  const ended = useRef(onCallEnded);
  useEffect(() => {
    ended.current = onCallEnded;
  });
  const [engine] = useState(() => {
    const notify = (message: string) => toast(message);
    const voice = createCallEngine({
      store,
      audio: createAudio(),
      notify,
      onCallEnded: (id) => ended.current?.(id),
    });
    const text = createTextEngine({ store, notify });
    return { voice, text };
  });
  const [libraryReady, setLibraryReady] = useState<boolean>();

  useEffect(() => {
    if (!unlocked) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    fetchJson("/api/warm", {}).catch(() => {});
    const poll = async () => {
      const ready = await fetchJson("/api/warm/status").then((r) => !!r?.ready, () => false);
      if (stopped) return;
      setLibraryReady(ready);
      if (!ready) timer = setTimeout(poll, WARM_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [unlocked]);

  return {
    ...engine.voice,
    onEndStaleCall: () => (store.getState().modality === "text" ? engine.text : engine.voice).onEndStaleCall(),
    text: engine.text,
    libraryReady,
  };
}
