# Thai Life PoC — Demo UI Brief

> Source-of-truth for this repo. The pasted brief from the 2026-05-07 session, reproduced here so future sessions don't lose context.

## Mission

Next.js front-end + thin backend orchestrator that takes a PDF upload, runs it through the wrapper service + three Lyzr agents in parallel, and renders the final underwriter brief. Replaces the LAO workflow path entirely. Beryl8/Thai Life see a polished product; Lyzr Studio is bypassed.

## Why we're building this

LAO has no UI primitive to map an API Call's output into a downstream agent's `assets[]` array. Agents only receive PDF *content* from `assets[]`. The wrapper produces a VLM-parsed asset_id, but LAO routes that id into a metadata field (`apicall_output`) that agents read as plain text, not as a fetchable document.

H2 verified that hand-edited `assets[]` via `POST /run-dag/` works (`task_id 0734234e-464b-48e5-ba37-27eb4687fab2`, Classification reported `is_bundle: true, page_count: 8` in 111s). But that's a curl-based demo — ugly. UI paste-existing-asset (H1) is untested.

So: build our own front-end. Backend orchestrates the same steps LAO would have (wrapper hop → 3 agent calls). Architecturally identical to Thai Life's eventual production path (Mulesoft → Lyzr APIs).

## Three locked agents (do NOT modify prompts)

| Agent | agent_id | user_id |
|---|---|---|
| Classification | `69f377c87045b738bc045749` | `1af38f4d-145c-4c47-9f78-736aa203e485` |
| Extraction | `69f37dc6577450ec8542003b` | `80507ff4-6a59-436b-babf-6de0fdf93cba` |
| Summarisation | `69f380b2180bca7eef235036` | `fea3f4d7-90ef-4495-865c-be1a52628799` |

## Test file

`Scene_3.pdf`, 8 pages: Thai ID, Thai Passport, GSB Passbook, Medical Cert (Thonburi Bamrungmuang), 3-page IPD Itemised Bill, 2-page IPD Receipt. Patient Mr. Kittipong Sriwatthana, ID `3-2249-12378-26-0`, from **Nonthaburi** (NOT Chiang Mai — that's hallucination canary).

Verified VLM asset for testing: `60506b59-2e12-4eec-bf02-0239890d689a`.

## Existing wrapper service (reuse, don't rebuild)

- Repo: https://github.com/shikhar-lyzr/vlm-reparse-wrapper (public)
- Render: https://vlm-reparse-wrapper.onrender.com
- Auth: `x-wrapper-key: cae367e4723f4f6afb37d016b4bf0e7c17a993eed17038452fbe800fc3cd27b0`
- Local: `/Users/shikhar-agrawal/vlm-reparse-wrapper/`
- 23/23 tests pass on Python 3.12
- `POST /api/vlm-reparse {"asset_id": "<source>"}` returns `{asset_id, source_asset_id, file_name, file_size_bytes, elapsed_ms}` in ~10s

## Architecture

```
[Next.js frontend]                    [Backend API]
  Upload PDF       →  POST /api/jobs   ─┐
  Poll status      ←  GET  /api/jobs/:id │
  Render results   ←                     │
                                         ▼
                              ┌──────────────────────────┐
                              │ 1. Upload to Lyzr (no VLM)│  ~3s
                              │    POST /v3/assets/upload │
                              ├──────────────────────────┤
                              │ 2. Wrapper VLM re-parse   │  ~10s
                              │    POST wrapper/api/...   │
                              ├──────────────────────────┤
                              │ 3. Three agents IN        │
                              │    PARALLEL (asyncio):    │
                              │    - Classification ~4m   │
                              │    - Extraction ~11m      │
                              │    - Summarisation ~11m   │  total ~11m
                              └──────────────────────────┘
```

**Critical:** agents run in parallel via `Promise.allSettled`, not serial. LAO's intended A2A chaining is broken anyway, and each agent reads the asset independently. Parallel drops total time from ~26 min sequential to ~11 min (bound by slowest agent).

## Stack

- Next.js 14+ (App Router), TypeScript, Tailwind, shadcn/ui
- Backend: Next.js API routes (same repo, single deploy)
- **Deploy: Render (Web Service running `next start`).** Single deploy, no Vercel timeouts. State = in-memory Map in the long-running Node process.
- Markdown rendering: `react-markdown` + `remark-gfm`

## Lyzr endpoints

| Purpose | Endpoint |
|---|---|
| Upload (no VLM) | `POST https://agent-prod.studio.lyzr.ai/v3/assets/upload` |
| Agent inference | `POST https://agent-prod.studio.lyzr.ai/v3/inference/chat/` |
| Wrapper | `POST https://vlm-reparse-wrapper.onrender.com/api/vlm-reparse` |

Auth header for Lyzr: `x-api-key: <LYZR_API_KEY>`. Server-side only. NEVER ship to frontend.

## Hard constraints

- Do NOT modify the three agent prompts in Lyzr Studio.
- Do NOT proxy the Lyzr API key through the frontend.
- Do NOT use Lyzr Studio's File Attachments UI for any production path (produces non-VLM assets).
- Do NOT add `specific_pages`, `start_page`, or `end_page` to the wrapper.
- Do NOT switch the VLM model from `gpt-4o`.
- Do NOT chase the A2A "Error with a2a" Lyzr platform bug. Parallel design avoids it.
- Do NOT add an LAO workflow node. Bypassing LAO is the whole point.
- Do NOT commit secrets. `.env.local` only, gitignored.

## Definition of done

1. Repo created and public on github.com/shikhar-lyzr.
2. `npm run dev` starts a working local instance.
3. Uploading Scene_3.pdf produces a job, advances through all stages, renders all three agent outputs within ~12-15 minutes wall-clock.
4. Summarisation output references "Nonthaburi" (sanity check vs hallucination).
5. Classification output reports `is_bundle: true` and `page_count: 8`.
6. Deployed to Render with public URL.
7. README documents setup, env vars, architecture.
8. Sample run capture (Loom or screen recording) shared with Beryl8.
