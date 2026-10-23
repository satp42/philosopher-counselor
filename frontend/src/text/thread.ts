import type { ToolCall, ToolResponse } from "../live/tools";
import type { Role } from "../live/recorder";

/** Server-produced and echoed back verbatim. The browser never parses it. */
export type Memo = string & { readonly __brand: "Memo" };

export interface UserItem {
  kind: "user";
  text: string;
}

export interface Exchange {
  call: ToolCall;
  result?: Record<string, unknown>;
}

export interface GuideItem {
  kind: "guide";
  text: string;
  exchanges: Exchange[];
  memo: Memo;
}

export type ThreadItem = UserItem | GuideItem;

export type GuideState = "idle" | "writing" | "failed" | "withheld";

export type GuideReply =
  | { kind: "reply"; text: string; calls: ToolCall[]; memo: Memo }
  | { kind: "withheld" };

/** The guide should answer a user line, or continue after tools it asked for. A finished line waits. */
export function nextStep(items: readonly ThreadItem[]): "request" | "wait" {
  const last = items.at(-1);
  if (!last) return "wait";
  if (last.kind === "user") return "request";
  if (last.exchanges.some((exchange) => exchange.result === undefined)) return "wait";
  if (last.exchanges.length > 0) return "request";
  return "wait";
}

/** Writes results onto the last guide item. An unknown id is a programming error. */
export function attach(items: readonly ThreadItem[], responses: readonly ToolResponse[]): ThreadItem[] {
  let index = -1;
  for (let cursor = items.length - 1; cursor >= 0; cursor--) {
    if (items[cursor].kind === "guide") {
      index = cursor;
      break;
    }
  }
  const guide = items[index];
  if (!guide || guide.kind !== "guide") throw new Error("no guide turn to attach to");
  const known = new Set(guide.exchanges.map((exchange) => exchange.call.id));
  for (const response of responses) {
    if (!known.has(response.id)) throw new Error(`unknown tool result ${response.id}`);
  }
  const exchanges = guide.exchanges.map((exchange) => {
    const response = responses.find((item) => item.id === exchange.call.id);
    return response ? { ...exchange, result: response.response } : exchange;
  });
  return items.map((item, itemIndex) => (itemIndex === index ? { ...guide, exchanges } : item));
}

/** Lines the person sees. Tool exchanges stay off the screen. */
export function visibleMessages(items: readonly ThreadItem[]): { role: Role; text: string }[] {
  const lines: { role: Role; text: string }[] = [];
  for (const item of items) {
    if (item.kind === "user") lines.push({ role: "user", text: item.text });
    else if (item.text) lines.push({ role: "guide", text: item.text });
  }
  return lines;
}

export function guideItem(reply: Extract<GuideReply, { kind: "reply" }>): GuideItem {
  return {
    kind: "guide",
    text: reply.text,
    memo: reply.memo,
    exchanges: reply.calls.map((call) => ({ call })),
  };
}

/** User lines carry text. Guide lines carry only the memo and results; the server re-derives the rest. */
export function toWire(items: readonly ThreadItem[]): unknown[] {
  return items.map((item) => {
    if (item.kind === "user") return { kind: "user", text: item.text };
    return {
      kind: "guide",
      memo: item.memo,
      results: item.exchanges
        .filter((exchange) => exchange.result)
        .map((exchange) => ({ id: exchange.call.id, name: exchange.call.name, response: exchange.result })),
    };
  });
}

/** Unknown shapes are withheld, so a bad payload never becomes a guide line. */
export function parseReply(json: unknown): GuideReply {
  if (!json || typeof json !== "object") return { kind: "withheld" };
  const body = json as Record<string, unknown>;
  if (body.kind === "withheld") return { kind: "withheld" };
  if (body.kind !== "reply" || typeof body.text !== "string" || typeof body.memo !== "string" || !Array.isArray(body.calls)) {
    return { kind: "withheld" };
  }
  const calls: ToolCall[] = [];
  for (const call of body.calls) {
    if (!call || typeof call !== "object") return { kind: "withheld" };
    const item = call as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return { kind: "withheld" };
    const args = item.args && typeof item.args === "object" ? (item.args as Record<string, any>) : {};
    calls.push({ id: item.id, name: item.name, args });
  }
  return { kind: "reply", text: body.text, calls, memo: body.memo as Memo };
}
