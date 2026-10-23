# Philosopher Counselor

A real-time philosophical counselor that listens to life dilemmas, or takes them in writing, and examines them through world philosophical traditions grounded in the Stanford Encyclopedia of Philosophy.

Built with **Gemini Live Bidirectional Audio** (`gemini-3.8-live-extended-thinking`), a **hybrid lexical-neural retrieval engine** indexing 1,870+ peer-reviewed SEP entries, a **WebAudio pipeline** with custom worklets, and a **self-optimizing contextual bandit** for natural conversational pacing.

Entirely serverless on [Modal](https://modal.com) — zero dedicated servers, scale-to-zero compute, and end-to-end privacy.

---

## Architecture Overview

```
                                      +-------------------------------------------------+
                                      |                   Browser UI                    |
                                      |  (React 19 + TypeScript + Tailwind CSS v4)      |
                                      +-----------------------+-------------------------+
                                                              |
                                           WebAudio Worklet   |  Bidirectional Audio
                                           (PCM16 16kHz stream|  & Live WebSocket
                                                              v
+-------------------------------+     Ephemeral Token     +-------------------------------------+
|         Modal Backend         | <---------------------+ |          Google Gemini Live         |
|  FastAPI + Pydantic + Auth    |                         |  gemini-3.8-live-extended-thinking  |
+---------------+---------------+                         +------------------+------------------+
                |                                                            |
                | Tool Dispatch (Non-blocking)                               | Function Call
                | `consult_sep`, `map_lenses`                                v (JSON RPC)
                +------------------------------------------------------------+
                |
                v
+-----------------------------------------------------------------------------------------------+
|                               SEP Hybrid Retrieval Engine                                     |
|  - BM25s Lexical Index (Okapi BM25 + Porter Stemmer)                                          |
|  - Semantic Candidate Retrieval & Tradition/Philosopher Aliases Expansion                     |
|  - GPU-accelerated Cross-Encoder Reranker (Score Floor: 0.15, Latency: p95 586ms)              |
|  - Corpus: 1,870 Stanford Encyclopedia of Philosophy entries (117,490 section passages)      |
+-----------------------------------------------------------------------------------------------+
                |
                v
+-----------------------------------------------------------------------------------------------+
|                                    Session State Machine                                      |
|  - Call Phase Progression: Listen -> Lens Mapping -> Exploration -> Synthesis                |
|  - Interactive Citation Cards & Direct Entry Anchors                                          |
|  - Real-time Crisis Detection & Safe Grounding Circuit Breaker                                |
|  - Post-Call Longform Philosophical Synthesis Engine (Modal Volume Persistence)               |
+-----------------------------------------------------------------------------------------------+
```

---

## Core Capabilities

### 1. Gemini Live Bidirectional Voice
- Powered by `gemini-3.8-live-extended-thinking` running over WebSockets with `v1beta` Live API constraints.
- Employs dedicated `AudioWorklet` nodes:
  - `capture.worklet.js`: Converts microphone input to clean 16 kHz mono PCM16 buffers off the main thread.
  - `playback.worklet.js`: Streams 24 kHz incoming audio packets with low-latency jitter buffering and interruption handling.
- Visual voice orb dynamically renders real-time audio energy and state transitions (Listening, Thinking, Speaking, Consulting SEP).

### 2. Stanford Encyclopedia of Philosophy (SEP) Grounding
- **Corpus Crawler & Parser**: Automated, polite scraper honoring `robots.txt` with backoff and rate-limiting. Strips preamble, bibliography, and navigation chrome, preserving hierarchical section breadcrumbs and academic footnotes.
- **Hybrid Retrieval System**:
  - BM25 candidate generation across 117,490 passage chunks.
  - Historical and phonetic thinker alias expansion (e.g. mapping colloquial forms to Kierkegaard, Epictetus, Spinoza, Beauvoir).
  - Neural cross-encoder reranker with an empirical score floor of `0.15` that eliminates false groundings while maximizing contextual relevance.
  - Lens mapping mode generating multifaceted philosophical frameworks (including intentional challenger traditions to avoid echo chambers).

### 3. Contextual Multi-Armed Bandit
- Conversational turns adapt dynamically via **Thompson Sampling** (`backend/bandit.py`).
- Explores voice activity detection (VAD) silence windows (900ms to 1500ms) and response verbosity targets.
- Evaluates per-call reward metrics: user takeover frequency, turn-end latency, guide/user word ratio, and silence gaps during encyclopedia lookups.

### 4. Philosophical Synthesis & Longform Reflection
- After each call hangs up, a background worker on Modal analyzes the full session transcript and cited philosophical passages.
- Produces a structured, beautiful synthesis essay linking the caller's lived dilemma to the underlying philosophical principles, with permanent citation links to the original SEP texts.

### 5. Written conversations
- The start screen offers **Write instead** beside **Start call**. Writing does not open the microphone.
- A typed session walks the same four phases, encyclopedia lookups, crisis support, and closing page as a voice call. The browser still owns the phase machine and the tool policy. The server answers each turn from a locked persona and writes nothing itself.
- Text calls are not bandit arms. A voice call that is still learning from spoken pacing is left alone.

### 6. Ethical & Crisis Guardrails
- Rigorous safety boundaries: `signal_crisis` tool monitors conversational valence.
- Immediate interruption circuit breaker: halts philosophical speculation and surfaces verified crisis counseling hotlines (e.g., 988 Lifeline).
- Private-by-design: all transcripts and synthesis pages live on an encrypted, isolated Modal volume accessible only by the authenticated owner.

---

## Repository Structure

```
.
├── backend/
│   ├── app.py                   # Modal app definition, container images & web endpoints
│   ├── modal_app.py             # Infrastructure declaration and dependency layers
│   ├── auth.py                  # Cryptographic session cookie authentication (HMAC-SHA256)
│   ├── live_token.py            # Server-locked Gemini Live ephemeral token minting
│   ├── calls.py                 # Call records, transcript storage & state management
│   ├── converse.py              # Typed-session replies; the persona and tools stay server-side
│   ├── bandit.py                # Thompson sampling multi-armed bandit for Live VAD tuning
│   ├── synthesis.py             # Post-call philosophical synthesis engine
│   ├── synthesis_job.py         # Modal background task definition for async synthesis
│   ├── ci.py                    # Serverless CI test runner on Modal
│   ├── corpus/
│   │   ├── crawl.py             # Polite SEP crawler with exponential retry backoff
│   │   └── parse.py             # HTML parser extracting structured sections and footnotes
│   ├── retrieval/
│   │   ├── build_index.py       # Corpus chunker, BM25 index builder, and artifact bundler
│   │   ├── search.py            # Hybrid retrieval, candidate merging, and reranking
│   │   ├── retriever.py         # Warm L4 GPU model runner with Modal memory snapshotting
│   │   ├── aliases.py           # Canonical thinker and tradition alias dictionaries
│   │   └── routes.py            # Internal retrieval API routes
│   ├── guide/
│   │   ├── system_instruction.md# Counselor persona, ethical boundaries, and tool guidance
│   │   ├── config.py            # Server-locked Live configuration and bandit arms
│   │   └── tools.py             # Non-blocking JSON-RPC tool declarations for Gemini Live
│   ├── eval/
│   │   ├── run_eval.py          # Benchmark harness measuring nDCG@10, recall, and latency
│   │   └── situations.jsonl     # Curated benchmark dataset of complex human dilemmas
│   └── tests/                   # Pytest test suite (120+ unit and integration tests)
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Main application root and route switcher
│   │   ├── api.ts               # Client HTTP client and session state handling
│   │   ├── components/
│   │   │   ├── CallScreen.tsx   # Active voice counseling view and controls
│   │   │   ├── VoiceOrb.tsx     # Canvas-based procedural audio visualizer orb
│   │   │   ├── CitationCards.tsx# Real-time philosophical citations & entry anchors
│   │   │   ├── CrisisPanel.tsx  # Safety circuit breaker and crisis resource modal
│   │   │   ├── SynthesisPage.tsx# Post-call reflection essay and reading list
│   │   │   ├── SynthesisList.tsx# Call history and archive of past consultations
│   │   │   └── AccessGate.tsx   # Password authentication barrier
│   │   ├── live/
│   │   │   ├── session.ts       # Gemini Live WebSocket protocol and turn manager
│   │   │   ├── audio.ts         # AudioContext coordinator and AudioWorklet loader
│   │   │   ├── recorder.ts      # Client telemetry and transcript recorder
│   │   │   ├── metrics.ts       # Latency, takeover, and conversational balance metrics
│   │   │   └── tools.ts         # Client tool execution and error handling
│   │   └── state/
│   │       └── callStore.ts     # Zustand global call state machine
│   ├── public/worklets/         # AudioWorklet processors (capture & playback)
│   ├── vite.config.ts           # Vite bundler configuration
│   └── package.json             # Frontend dependencies (React 19, Tailwind v4, Zustand)
└── docs/
    ├── gemini-live-behaviors.md # Empirically verified Gemini Live characteristics & timings
    └── retrieval-eval.md        # Comprehensive retrieval benchmark ablations and sweeps
```

---

## Setup & Deployment

### Prerequisites
- Python 3.13+
- Node.js 22+
- [Modal](https://modal.com) account and CLI

### 1. Install Dependencies & Modal CLI
```bash
# Install Modal CLI
uv tool install modal

# Authenticate with Modal
modal setup
```

### 2. Configure Secrets
Create the required environment secrets inside Modal:
```bash
# 1. Google Gemini API Key
modal secret create gemini GEMINI_API_KEY='your-gemini-api-key'

# 2. Authentication Passphrase & Cryptographic Signing Key
PASS=$(openssl rand -base64 24)
echo "Your app passphrase is: $PASS"   # Store securely in your password manager

modal secret create app-auth \
  APP_PASSPHRASE="$PASS" \
  APP_SIGNING_KEY="$(openssl rand -hex 32)"
```

### 3. Deploy App & Build Knowledge Base
Deploy the backend to Modal, then crawl and index the Stanford Encyclopedia of Philosophy. The tasks run as detached Modal functions that persist independently of your local terminal:
```bash
# Deploy the web service and API
modal deploy -m backend.app

# Crawl the SEP corpus (polite, resumable, ~3.5 hours for full corpus)
python -c "import modal; modal.Function.from_name('sep-counselor', 'crawl').spawn(0)"

# Parse raw HTML into structured passages
python -c "import modal; modal.Function.from_name('sep-counselor', 'build_entries').remote()"

# Build BM25 index and neural embeddings on an L4 GPU (~45 minutes)
python -c "import modal; print(modal.Function.from_name('sep-counselor', 'build_index').remote())"

# Re-deploy to refresh memory snapshots with the new index
modal deploy -m backend.app
```

### 4. Continuous Deployment
`.github/workflows/modal-deploy.yml` runs `modal deploy -m backend.app` on every push to `main` (and on manual dispatch from the Actions tab). It needs two repository secrets holding a Modal token:
```bash
gh secret set MODAL_TOKEN_ID
gh secret set MODAL_TOKEN_SECRET
```

---

## Development & Testing

### Running Tests

#### Backend Test Suite (Pytest on Modal)
Execute the complete backend test suite inside the containerized Modal environment:
```bash
modal run backend/ci.py --args "-q"
```

To run a specific test module:
```bash
modal run backend/ci.py --args "-q backend/tests/test_search.py"
```

#### Frontend Test Suite (Vitest)
Run the React 19 test suite locally:
```bash
npm --prefix frontend test -- --run
```

### Retrieval Evaluation Benchmark
Run the evaluation suite over the benchmark situation dataset:
```bash
python -c "import modal; print(modal.Function.from_name('sep-counselor', 'evaluate').remote())"
```
Detailed ablation results and tuning history are documented in [`docs/retrieval-eval.md`](docs/retrieval-eval.md).

---

## API Reference

All `/api` endpoints require an authenticated session cookie obtained via `/api/login`. State-modifying requests (`POST`, `DELETE`) require a matching `Origin` header.

### Authentication
```bash
APP="https://<your-workspace>--sep-counselor-web.modal.run"

# Log in and save session cookie
curl -s -c cookies.txt -H "Origin: $APP" -H "Content-Type: application/json" \
  -d "{\"passphrase\": \"$APP_PASSPHRASE\"}" "$APP/api/login"
```

### Managing Calls & Transcripts
```bash
# List all calls (ordered newest to oldest)
curl -s -b cookies.txt "$APP/api/calls"

# Retrieve full record for a specific call (including transcript and synthesis page)
curl -s -b cookies.txt "$APP/api/calls/<CALL_ID>"

# Regenerate a failed synthesis essay
curl -s -b cookies.txt -H "Origin: $APP" -X POST "$APP/api/calls/<CALL_ID>/retry"

# Permanently delete a call, transcript, and associated synthesis page
curl -s -b cookies.txt -H "Origin: $APP" -X DELETE "$APP/api/calls/<CALL_ID>"
```

---

## Technical Specifications & Latency Targets

| Metric | Target | Production Measurement | Notes |
|---|---|---|---|
| **Audio Round-Trip Latency** | < 1,000 ms | **~650 - 850 ms** | Lead-in audio stream from Gemini Live |
| **Hybrid Search (Internal)** | < 500 ms | **~445 ms (p95 451 ms)** | Warm L4 GPU cross-encoder rerank |
| **Search Round-Trip (Modal)**| < 750 ms | **541 ms (p95 586 ms)** | Container-to-container RPC overhead included |
| **Lens Map (5 Lenses × 15)**| < 3,000 ms | **1,988 ms (p95 2,066 ms)** | Multi-tradition grounding |
| **Live Session Duration** | 10 min cap | **Auto-reconnecting** | Ephemeral tokens seamlessly reminted prior to deadline |

---

## Privacy & Terms of Use

- **Personal Data**: All session audio is processed ephemerally in volatile memory. Transcripts, metrics, and generated synthesis pages reside strictly on the user's private Modal volume.
- **Corpus Attribution**: Content from the Stanford Encyclopedia of Philosophy (SEP) is retrieved for personal, non-commercial philosophical counseling under fair-use principles. The crawler strictly honors `robots.txt`, enforces request throttling, and all generated outputs prominently link back to the canonical SEP entries.
