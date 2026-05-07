# thai-life-demo-ui

Next.js front-end + thin backend orchestrator for the Thai Life Insurance PoC. Takes a PDF upload, runs it through the [vlm-reparse-wrapper](https://github.com/shikhar-lyzr/vlm-reparse-wrapper) service and three Lyzr agents (Classification, Extraction, Summarisation) in parallel, and renders the final underwriter brief.

Replaces the LAO workflow path entirely. See [BRIEF.md](./BRIEF.md) for full context and [docs/superpowers/plans/](./docs/superpowers/plans/) for the implementation plan.

## Architecture

```
[Next.js frontend]                    [Backend API routes]
  Upload PDF       →  POST /api/jobs   ─┐
  Poll status      ←  GET  /api/jobs/:id │
  Render results   ←                     │
                                         ▼
                              ┌──────────────────────────┐
                              │ 1. Upload to Lyzr (no VLM)│  ~3s
                              ├──────────────────────────┤
                              │ 2. Wrapper VLM re-parse   │  ~10s
                              ├──────────────────────────┤
                              │ 3. Three agents IN        │
                              │    PARALLEL:              │
                              │    - Classification ~4m   │
                              │    - Extraction ~11m      │
                              │    - Summarisation ~11m   │  total ~11m (parallel)
                              └──────────────────────────┘
```

State is an in-memory `Map` in the long-running Node process (single-instance demo).

## Setup

```bash
cp .env.local.example .env.local
# fill in LYZR_API_KEY and WRAPPER_KEY
npm install
npm run dev
```

Open <http://localhost:3000>.

## Env vars

| Var | Required | Default |
|---|---|---|
| `LYZR_API_KEY` | yes | — |
| `WRAPPER_KEY` | yes | — |
| `WRAPPER_URL` | no | `https://vlm-reparse-wrapper.onrender.com` |
| `LYZR_BASE_URL` | no | `https://agent-prod.studio.lyzr.ai` |

## Tests

```bash
npm test          # run vitest once
npm run test:watch
```

26 unit tests covering env loading, Lyzr API helpers, wrapper helper, in-memory job store, and orchestrator (parallel dispatch, partial-failure handling, upload/wrapper short-circuit).

## API

### `POST /api/jobs`
Multipart form with `file` field (PDF, max 25 MB). Returns `{ job_id, status: "queued" }` and starts the pipeline in the background.

### `GET /api/jobs/:id`
Returns the current `JobState` (see [`lib/types.ts`](./lib/types.ts)). Frontend polls every 3 s.

## Deploy

Render Web Service:
- Runtime: Node
- Build: `npm install && npm run build`
- Start: `npm start`
- Branch: `main`
- Env vars: `LYZR_API_KEY`, `WRAPPER_KEY` (and optional overrides)

Render keeps the Node process alive — important because the in-memory job store and the long-running orchestrator (~12 min per job) won't survive serverless cold starts. Do not deploy to Vercel.

## Hard constraints

- Don't proxy `LYZR_API_KEY` through the frontend — all `/v3/*` calls happen in API route handlers.
- Don't modify the three locked agent prompts in Lyzr Studio.
- Don't add an LAO workflow node anywhere — the whole point of this build is to bypass LAO.
- Don't switch the wrapper's VLM model from `gpt-4o`.
