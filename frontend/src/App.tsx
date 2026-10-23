import { useEffect, useState } from "react";
import { useStore } from "zustand";

import { fetchJson } from "./api";
import AccessGate from "./components/AccessGate";
import CallScreen from "./components/CallScreen";
import SynthesisList from "./components/SynthesisList";
import SynthesisPage from "./components/SynthesisPage";
import TextCallScreen from "./components/TextCallScreen";
import { useCallEngine } from "./live/useCallEngine";
import { callStore, IN_CALL } from "./state/callStore";

type AuthState = "checking" | "locked" | "unlocked";
type View = { name: "call" } | { name: "pages" } | { name: "page"; id: string };

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [view, setView] = useState<View>({ name: "call" });
  const engine = useCallEngine({
    unlocked: auth === "unlocked",
    onCallEnded: (id) => setView({ name: "page", id }),
  });
  const modality = useStore(callStore, (state) => state.modality);
  const status = useStore(callStore, (state) => state.status);

  useEffect(() => {
    fetchJson("/api/session").then(
      () => setAuth("unlocked"),
      () => setAuth("locked"),
    );
  }, []);

  useEffect(() => {
    if (auth !== "unlocked") return;
    callStore.getState().transition("idle");
    void import("@google/genai"); // warm the Live SDK chunk so Start call doesn't wait on it
  }, [auth]);

  // A view swap is a route change: retitle, scroll up, and put focus on the new main so the keyboard isn't stranded.
  useEffect(() => {
    const name = { call: "Call", pages: "Your pages", page: "Page" }[view.name];
    document.title = auth === "unlocked" ? `${name} · Philosopher` : "Philosopher";
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("main")?.focus();
  }, [view, auth]);

  if (auth === "checking") return null;
  if (auth === "locked") return <AccessGate onUnlocked={() => setAuth("unlocked")} />;

  function openPages() {
    const { status, callId } = callStore.getState();
    setView(callId && status === "generating" ? { name: "page", id: callId } : { name: "pages" });
  }

  function backToCall() {
    if (callStore.getState().status === "generating") callStore.getState().reset();
    setView({ name: "call" });
  }

  if (view.name === "pages") return <SynthesisList onOpen={(id) => setView({ name: "page", id })} onBack={backToCall} />;
  if (view.name === "page") return <SynthesisPage key={view.id} id={view.id} onBack={() => setView({ name: "pages" })} />;

  const { text, ...voice } = engine;
  if (modality === "text" && (IN_CALL.has(status) || status === "generating")) {
    return <TextCallScreen engine={text} onOpenPages={openPages} />;
  }
  return <CallScreen {...voice} onStartText={() => void text.onStart()} onOpenPages={openPages} />;
}
