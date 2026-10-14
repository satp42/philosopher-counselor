---
title: Gemini Live extended-thinking model, observed behaviors
date: 2026-10-13
module: guide / live session
tags: [gemini-live, ephemeral-tokens, session-resumption, tools, latency]
---

# Gemini Live extended-thinking: observed behaviors

Setup: the Python SDK `google-genai==2.30.1` async Live client (`client.aio.live.connect`), run as Modal functions with the `gemini` secret. The model was `gemini-3.8-live-extended-thinking`, with `live_config()` and `TOOLS` exactly as committed. Tokens came from `backend.live_token.mint_token`. Input was text only (`send_realtime_input(text=...)` and `send_client_content`). Tool results were faked: a fake SEP passage carrying a unique marker image, "the lighthouse keeper Anselm". Each session's state was checked with a codeword ("pomegranate seven"). The harness scripts were throwaway and are not committed.

**Working setup:** model `gemini-3.8-live-extended-thinking`, `api_version` **`v1beta`** for both minting and connecting. The SDK warns that "ephemeral token support is in v1alpha only", but that is wrong: v1beta works, and a v1alpha-minted token also connects on v1beta. No v1alpha fallback was needed.

## Results

| # | Question | Answer | Evidence |
|---|---|---|---|
| a | Does a `send_client_content(turn_complete=False)` `[Context — do not respond]` turn stay silent while the model is IDLE, and is it used on the next turn? | **Yes, and yes** | Sent 1.5s after IDLE. There were **zero** server messages in the next 15s. The next question ("my name, the two cities, my cat?") got "Your name is Mirela, you are torn between Tromsø and Lisbon, and your cat is called Biscuit." First audio came 0.61s after the question. |
| a′ | Does that turn interrupt the model if it arrives while the model is speaking? | **No** | Tested 3 times. In 2 runs it was sent mid-answer, about 15s in, after 30+ words. In 1 run it landed during the opening filler phrase. There was never an `interrupted`. The transcript continued mid-sentence at the same ~1s cadence ("…into two distinct ⟨ctx⟩ categories. On one side…"), and the turn ran to completion (52–66s). The next question was answered correctly with the injected name and cat name. |
| b | With `NON_BLOCKING`, does the model use a tool response that arrives later? | **Yes, 5/5** | The marker image was always narrated, starting 2.5–3.7s after the response was sent. Delays tested: 3s, 8s, and ~10s (×3). It is spoken in a **new utterance**: the model says a short filler ("Let me check that for you"), calls the tool, then usually **goes silent** until the result arrives (silent in 4/5 runs; one run produced a second filler at 6.0–10.7s while the call was pending). A result that arrives mid-speech (one run: tool response 0.35s into an utterance) did not interrupt speech. `tool_call_cancellation` was never seen. |
| c-i | Can the same `uses:1` token resume the session? | **No** | Resuming on the same token failed with `1011 Token has been used too many times`. After the 1-minute new-session window it fails with `1011 new_session_expire_time deadline exceeded`. **Resumption consumes a use.** With a `uses:2` token, the second connect is accepted, but the client handle is **silently ignored**: a fresh session (prompt 4611 tokens) that did not recall the codeword. |
| c-ii | Can a freshly minted token (constraints `session_resumption: {}`) resume using a client-supplied handle? | **No, and it fails silently** | The connect succeeds with no error, but it is a fresh session: first-turn `prompt_token_count` was 4611, the same as the control, and the reply was "I don't have access to … any stored codewords". |
| c-iii | Does a token minted with the handle inside `live_connect_constraints` (`mint_token(client, resumption_handle=h)`) resume? | **Yes, 4/4 variants, plus after a 10-minute cutoff (3/3)** | It works whether the client config passes the handle, passes `live_config()` without a handle, or passes only `{response_modalities: [AUDIO]}`. It works across auth types: a handle from a key-auth session resumes on such a token, and a handle from a token session resumes on the API key. The prompt grew to about 4690–4710 tokens and the codeword was recalled. |
| c-iv | Is a client-supplied handle accepted when the config is locked? | **No** | Constraints win silently (see c-i and c-ii). |
| c | goAway / long sessions | **No goAway was ever received** | **Token-auth** connections were closed at **exactly 600s** with `1011 The service is currently unavailable.`, with no prior `goAway` (3/3 runs; text turns every 2 minutes). An **API-key** connection ran past 960s with no goAway and no close (1/1). In all 3 cases, resuming after the 10-minute close worked via a fresh token with the handle in constraints. |
| c | Does `expire_time` end an already-established session? | **Yes** | Token with a 120s TTL: the session closed at 119.5s with `1011 auth token has expired`. Resuming with that expired token then failed: `1011 Token has expired`. |
| c | Handle behavior | One handle per connection | Each connection gets exactly **one** `sessionResumptionUpdate`, at setup (`resumable=True`, `lastConsumedClientMessageIndex` unset). No updates arrive later, even over 10 minutes. The handle acts as a session id: resuming it restores the **latest** state, including turns sent after the handle was issued. |
| d | What is the event sequence around a tool call? | See right | `SEND` → ~0.6–1.0s filler audio → `generationComplete` + `turnComplete` + **`IN_PROGRESS`** (+usage) → 1.5–2.5s → `toolCall` → (silence) → client `toolResponse` → 2.5–3.7s → result audio → `generationComplete` + `turnComplete` + **`IDLE`**. `interactionStatus` always arrives **on the same message as `turnComplete`**. `REQUIRES_ACTION` was never seen. Sometimes a turn produces thoughts only with no audio (`turnComplete` + `IN_PROGRESS` at 0.7s), and the tool call then lands 0.35s into the next utterance. One turn produced 3 generations before `IDLE`. |
| e | Time to first audio by `thinking_level` (3 fresh sessions each, same situation prompt) | low **0.65s**, medium **0.83s**, high **0.86s** (medians) | low 1.01/0.65/0.55, medium 0.94/0.76/0.83, high 0.86/0.82/1.56. The model always opens with a quick lead-in, so the level barely affects time to first audio. Time to `IDLE`: 7–12s at every level. Simple turns used 80–134 thought tokens at every level. |
| f | VAD `silence_duration_ms` | **Manual: tune during the first real call** | Can't be tested with text input. `realtime_input_config.automatic_activity_detection.silence_duration_ms` is accepted. Start at **900ms** (current `SILENCE_MS`); if the guide cuts in during reflective pauses, raise it toward 1200ms. |

### Config acceptance (API key, `live_config()` with single fields removed)

- The full `live_config()` and `TOOLS` were **accepted as-is**. That includes uppercase `OBJECT/STRING/ARRAY` types, `enum`, `behavior: NON_BLOCKING`, the parameter-less `signal_crisis`, `realtime_input_config`, `context_window_compression.sliding_window`, and `session_resumption: {}`. **No fixes are needed.**
- **`thinking_config` is mandatory:** without it, the connect fails with `1007 Thinking level must be specified for this model.`
- Declarations **without `behavior`** were also accepted, and the tool call behaved the same. The plan's claim that a blocking declaration is a hard error **was not reproduced**. Keep `NON_BLOCKING` anyway.
- With a locked token, a minimal client config (`{response_modalities: [AUDIO]}`) still gets the persona, tools and voice from the constraints.

### Tokens and usage

- `usageMetadata` arrives once per generation, on the `turnComplete` message. It covers that generation only and is **not cumulative**.
- The system instruction plus 5 tools cost about **4.6k prompt tokens** (a fresh session's first turn: 4605–4636).
- The generation right after a tool response reports **10.3–10.9k** prompt tokens and **1.2–3.3k thought tokens**. Ordinary turns use 40–150 thought tokens.
- The largest single generation seen was 15.4k total tokens. The 131k context limit was not approached, so the context size was not tested directly.
- A very short reply ("tock 0") produced an `outputTranscription` with **no audio chunks** and no `response_token_count`. Don't assume every turn has audio.

## Implications for the Live Session Engine

1. **Summary re-injection.** Keep the plan: the summary and lens plan travel in tool responses. `sendClientContent(turnComplete:false)` with `[Context — do not respond]` is now proven safe **at any time**: it is silent while idle, doesn't interrupt speech, and is used on the next turn. The "only while idle" restriction can be dropped. After **every** reconnect, inject the current summary and lens plan this way before unmuting the mic. Resumption normally restores history, but a resume that didn't take effect fails *silently* (c-ii), so the injection is the safety net.
2. **Reconnect and token strategy (changes Key Technical Decisions).**
   - Change: "a reconnect reuses the same token" is **false**. **Every connection needs a newly minted token.** A reconnect calls `POST /api/token {call_id, resumption_handle}`, and the server mints with the handle inside `live_connect_constraints` (already supported by `mint_token(..., resumption_handle=)`). Never rely on a client-supplied handle.
   - Store the handle from the setup-time `sessionResumptionUpdate` of **each** connection. Resuming it restores the latest state.
   - **Don't wait for `goAway`.** Token connections are closed at **10:00** with `1011 The service is currently unavailable.` and no warning. Handle it two ways:
     - Proactively reconnect at about **9:00–9:30** of connection time, on the next `IDLE`.
     - Treat any unexpected 1011 close as "mint with handle, reconnect, inject context".
   - `expire_time` *does* end a live connection. That is harmless when every connection gets its own token and the TTL (30 min) is longer than the 10-minute connection cap. The "remint at minute 25" rule is then unnecessary.
   - Mint **immediately** before connecting. The 1-minute `new_session_expire_time` also applies to resumes.
   - Raise or reconsider `MAX_MINTS_PER_CALL = 8`. That allows about 80 minutes of connection time, minus any retries after auth errors. 12 is a safer cap for long calls.
   - Optional resume check: the first `usageMetadata.promptTokenCount` after a resume is above the ~4.6k fresh baseline.
3. **thinkingLevel.** Keep **`medium`**. Time to first audio is about 0.6–0.9s at every level because of the lead-in phrase, so latency doesn't argue for `low`. `high` costs about the same and could be tried in a real call if explanations feel shallow.
4. **Tool flow and UI.**
   - After a `toolCall` the guide usually goes **silent** until the result arrives.
   - Speech resumes 2.5–3.7s after the response, so total silence is retrieval time plus about 3s.
   - Show a "consulting the encyclopedia" state from `toolCall` until the next audio.
   - Drive listening and speaking from `interactionStatus`: `turnComplete` + `IN_PROGRESS` is common after filler turns, so close transcript turns on `IDLE` (as planned).
   - Don't send `scheduling` on function responses. It wasn't needed: results are always spoken in a new utterance.
5. **Tool schemas.** No changes. `thinking_config` must stay in the locked config.
6. **Fallback check.** Plan fallback (b) (switching to plain `gemini-3.8-live`) is **not needed**. `NON_BLOCKING` result handling is reliable.
