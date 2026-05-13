# Thai Life PoC — Session Brief 2026-05-13

> Read this brief plus `docs/architecture-handoff.md` before doing any work. They are complementary: architecture-handoff describes the deployed system; this brief describes what we learned today about why it's broken on scanned PDFs, decisions made with Parshva, and where the chunking architecture design was paused.

## TL;DR

The Beryl8 demo pipeline silently fabricates underwriter briefs for any scanned image-only PDF (Scene_4, Scene_5). Today we isolated the root cause to a Lyzr-side multi-page parser bug confirmed by Parshva, plus a downstream agent-prompt fragility that amplifies it. Parshva has accepted a 10-page-per-VLM-call limit and asked us to chunk on our side. The chunking architecture design started in brainstorming mode but stopped before the design was finalized — pending one definitive multi-asset experiment.

## Session timeline

### 1. Validation rounds for the Summarisation prompt (early session)

Three rounds of 3-run validations against Scene_3.pdf:

- **Round 1 (pre Section 5 spec edit):** 2/3 PASS, Run 2 hallucinated six fabricated Thai name variants in Section 5(a). Section 5(c) and "fabricated variants" rule judged worth iterating.
- **Round 2 (post Section 5 structural edit):** 3/3 PASS with exact canned identity statements, no fabrication. 2/3 chose the wrong canned statement ("cannot be performed" instead of "consistent") but at least it stayed structured. Substance not perfect; format constraint landed.
- **Round 3 (Lever A latency trim):** REGRESSED. 2/3 PASS, Run 1 produced 5 fabricated name variants AND latency went up (not down) on all three runs. Lever A was reverted. The trimmed `INTERNAL PROCESSING` block was load-bearing in a way we did not anticipate.
- **Round 4 (Section 5(c) variance rule + introduce Scene_4):** 1x Scene_3 + 3x Scene_4. Scene_3 worked, all three Scene_4 runs returned wholesale fabricated personas (different invented names per run). This was the moment the failure mode shifted from "prompt issue" to "the pipeline is delivering empty content for some files".

### 2. File mismatch caveat

The "ground truth" file Shikhar referenced (14.4 MB, 169 pages, sha256 5f64355e…, pediatric patient at Ekachai Hospital) is actually `Scene 5_Respiratory.pdf`. The file I uploaded as "Scene_4" was `Scene 4_HTEx.pdf` (1.66 MB, 49 pages). Both fail the same way for our purposes. Going forward, use the explicit filename, not the scene number.

### 3. VLM parser diagnostic (Phase 1 → Phase 3 of systematic-debugging)

Evidence gathered at every pipeline boundary:

- File comparison (via poppler-utils):
  - Scene_3.pdf: 8 pages, 5.15 MB, iLovePDF producer, 570 bytes extractable text → text-extractable
  - Scene 4_HTEx.pdf: 49 pages, 1.66 MB, no producer, 49 bytes extractable text (page-feeds only) → scanned image-only
  - Scene 5_Respiratory.pdf: 169 pages, 14.41 MB, macOS Quartz, 169 bytes extractable text → scanned image-only
- `GET /v3/assets/{id}` returns identical schema for working and broken assets. `is_queryable: false` for both — this field is not a parse-status indicator.
- Lyzr's `/openapi.json` confirms there are only four asset endpoints (POST upload, GET list, GET one, DELETE). **There is no parse-status endpoint, no content-fetch endpoint, and no parse field in the upload response schema.** The client has no way to detect parse failure.
- Upload timing scales with file size (~620 KB/s effective bandwidth), not with page count → upload returns after byte transfer, parsing is not in the upload time.

### 4. H1 (async parse) experiment

- T+10min on existing assets vs T0/T+90s on fresh uploads.
- First agent call on a fresh asset blocks ~5 minutes — parsing is triggered lazily on first inference call, not at upload time.
- After that 5-minute parse, every subsequent agent call returns in ~20s. But `page_count: 1` is reported for both Scene_4 (49p) and Scene_5 (169p) across every timepoint.
- Same source PDF uploaded twice → two different hallucinated classifications. Different invented hospital each time.
- H1 confirmed for timing behavior, killed for the "wait and content arrives" hypothesis.

### 5. Direct-probe experiments (the smoking gun)

Asked the Classification agent to answer literally without using its template. Two probes:

- **"How many pages do you receive?"** → Both Scene_4 and Scene_5 returned "I only see 1 page" verbatim. Scene_3 also returned this, but with the clarification: "extracted and presented to me as a single consolidated text output... one unified markdown text block containing all the extracted content."
- **"Describe page 1, 50, 100, 169"** → For Scene_5 the agent described "page 1" with confabulated Thai National ID content (Scene_3-leaked) and answered "not in input" for pages 50, 100, 169. For Scene_3 the agent correctly described pages 1, 4, 6, 8 with real document content.
- **Y/N probe for specific ground-truth strings** → For Scene_5, the agent answered Y to Ekachai, Sansongsak, ด.ช., Samut Sakhon (real page-1 content). Answered N for Kittipong/Thonburi (Scene_3-only strings). For Scene_3, all 6 ground-truth answers matched reality.

### 6. Final refined diagnosis

The parser delivers a single markdown text blob to the agents regardless of source. What's *in* the blob is the bug:

| File | Type | Blob contains |
|---|---|---|
| Scene_3 | text-extractable | Real content from all 8 pages |
| Scene_4 | scanned image-only | Page 1 content only |
| Scene_5 | scanned image-only | Page 1 content only |

VLM OCR on **page 1** of scanned PDFs is working (Y/N probe confirmed real strings reach the agent). Pages 2+ are NOT making it through — either VLM isn't being called for them, or it's being called and the output is dropped before blob assembly.

There are also two downstream agent behaviors that amplify the visible damage:

- **Cause B (agent fault, secondary):** Few-shot examples in the agent prompts include Scene_3's actual patient data (Kittipong / Thonburi / HN 20-00015214 / ID 3-2249-12378-26-0). When the agent receives sparse input (one page of OCR text), it falls back to those examples instead of saying "input is insufficient". This is why we keep seeing Scene_3's patient leaking into Scene_4 and Scene_5 outputs.
- **Cause C (5-min lazy-parse):** First agent call on a fresh asset blocks for ~5 minutes while parsing runs in the background. Subsequent calls are fast.

## Decisions made with Parshva

- Parshva confirmed his parser's VLM endpoint cannot process 48 pages without parallel workers, which he is not adding.
- Parshva confirmed a 10-page-per-VLM-call limit is acceptable to him (Scene_3 with 8 pages works fine today).
- Decision: **we chunk the PDF on our side into ≤10-page slices**, parse each chunk through Lyzr's VLM upload, and then feed all chunks together into the agents (ideally via `assets: [c1, c2, ...]` on `/v3/inference/chat/`).

## Where the chunking design stopped

I invoked `superpowers:brainstorming` to design the chunking architecture. I asked one clarifying question and the user paused to switch sessions. The pending question:

> Before designing, should we run a 5-minute test that splits Scene_3 into two real chunks (pages 1-4 and 5-8), uploads each, and calls Classification with `assets: [chunk1_id, chunk2_id]` — to definitively answer whether multi-asset concatenates on Lyzr's side?

An attempt was made earlier using existing assets (Scene_3 + Scene_5) and was **inconclusive** — Scene_5 baseline alone returned N to every ground-truth string (its parsed content seems to have evaporated since the earlier session probe), so we couldn't tell whether multi-asset would have shown the second asset's content. The "both" test did rule out "first-asset-only" behavior (reversed asset order returned identical answers), but concatenation is not yet proven.

**The architecture design depends on this answer:**

- If multi-asset cleanly concatenates → simple "split, upload N chunks in parallel, pass all asset_ids to agents" architecture.
- If multi-asset does NOT cleanly concatenate → need to fetch parsed text per chunk and merge ourselves (more complex; no public API exposes the parsed text directly).

**Recommended next action for the next session:** run the split-Scene_3 multi-asset test first (cheap, definitive), then resume brainstorming.

## Critical constraints (do not violate)

These are durable across sessions:

- **Do NOT modify `lib/lyzr.ts::VLM_QUERY_PARAMS` shape.** The query-string form is the only working shape — `parse_config` as a form-field silently no-ops. Verified by Parshva.
- **Do NOT add `specific_pages`, `start_page`, or `end_page` to the upload params** unless explicitly authorized (Parshva tested these — they don't make multi-page work; they just constrain to a fixed slice).
- **Do NOT proxy `LYZR_API_KEY` through the frontend.** All `/v3/*` calls happen server-side in Next.js route handlers.
- **Do NOT commit secrets or customer PDFs.** `.env.local` and `*.pdf` are gitignored; keep them that way.
- **Do NOT reintroduce the standalone wrapper service.** We removed it in commit 10330b8. The Next.js app calls Lyzr directly.
- **Do NOT switch the configured models** (`gpt-4o` for VLM, `claude-sonnet-4-5` for agents) without explicit authorization. We have validation runs anchored to these.
- **Do NOT touch agent prompts** unless Shikhar has unlocked that round of editing. Memory `[[project_constraints]]` says prompts are not logged so we can reconfigure them — but each edit invalidates prior validation rounds, so coordinate before changing.

## Reference materials

### Codebase

- `lib/lyzr.ts` — `uploadToLyzr` (POST `/v3/assets/upload?<VLM_QUERY_PARAMS>`) and `callAgent` (POST `/v3/inference/chat/`, with retry-on-5xx and undici 20-min timeout)
- `lib/orchestrator.ts` — `processPdf`: single upload → 3 parallel agent calls via `Promise.allSettled`
- `lib/types.ts` — `AGENTS` constant: agent_id, user_id, message per agent
- `lib/env.ts` — zod env schema (`LYZR_API_KEY`, `LYZR_BASE_URL`)
- `app/api/jobs/route.ts` and `app/api/jobs/[id]/route.ts` — REST surface
- `app/jobs/[id]/page.tsx` — job detail UI

### Agent IDs (locked)

| Agent | agent_id | user_id |
|---|---|---|
| Classification | `69f377c87045b738bc045749` | `1af38f4d-145c-4c47-9f78-736aa203e485` |
| Extraction | `69f37dc6577450ec8542003b` | `80507ff4-6a59-436b-babf-6de0fdf93cba` |
| Summarisation | `69f380b2180bca7eef235036` | `fea3f4d7-90ef-4495-865c-be1a52628799` |

### Lyzr API

- Base URL: `https://agent-prod.studio.lyzr.ai`
- Auth: `x-api-key: <LYZR_API_KEY>` header
- Endpoints used: `POST /v3/assets/upload`, `GET /v3/assets/{id}`, `POST /v3/inference/chat/`
- OpenAPI spec available at `/openapi.json` and ReDoc at `/redoc`
- VLM query string (canonical):
  ```
  parser_provider=lyzr_parse
  parsing_mode=full
  enable_vlm=true
  vlm_provider=openai
  vlm_model=gpt-4o
  extract_tables=true
  describe_images=true
  ```

### Test PDFs

| File | Path | Pages | Type | sha256 |
|---|---|---|---|---|
| Scene_3.pdf | `/Users/shikhar-agrawal/thai-life-demo-ui/Scene_3.pdf` | 8 | text-extractable, works fully | (8p iLovePDF) |
| Scene 4_HTEx.pdf | `~/Downloads/Thai Life - PoC File/Scene 4_HTEx.pdf` | 49 | scanned image-only | b05875b0093a4ac2797a4f94ed9208e79042b441ed5e91db056b947cc6398dea |
| Scene 5_Respiratory.pdf | `~/Downloads/Thai Life - PoC File/Scene 5_Respiratory.pdf` | 169 | scanned image-only | 5f64355e9773163c2b366b8b9e0537e21519e94e5045bee8f0becc84e786cc7e |

Scene_5 is a minor's medical record (pediatric patient ด.ช. กรวิชญ์ สานส่งศักดิ์ at Ekachai Hospital, Samut Sakhon). Treat as PHI: do not commit, do not paste outputs unredacted into Slack threads, do not upload to third-party renderers/pastebins.

### Test artifacts on disk (volatile, /tmp/)

- `/tmp/round1/`, `/tmp/round2/`, `/tmp/round3/` — three rounds of Summarisation validations
- `/tmp/h1v2_*.txt` — H1 async-parse experiment (T+10min vs T0 vs T+90s)
- `/tmp/probe_s*.txt`, `/tmp/probe2_*.txt`, `/tmp/probe_s3_*.txt` — direct agent probes (page count, page description, raw quote refusals)
- `/tmp/yn_s3.txt`, `/tmp/yn_s5.txt` — Y/N ground-truth string probes
- `/tmp/multi_*.txt`, `/tmp/multi_*_body.json` — multi-asset experiment (inconclusive)
- `/tmp/lyzr_openapi.json` — full Lyzr API spec dump

### Saved scripts (reusable)

- `/tmp/validate.sh` — 3 sequential runs of Scene_3 against the deployed UI
- `/tmp/validate4.sh` — 3x Scene_4 + 1x Scene_3 parallel
- `/tmp/poll4.sh`, `/tmp/resub.sh` — recovery polling for in-flight jobs
- `/tmp/h1v2.sh` — H1 async-parse experiment
- `/tmp/probe_yesno.sh`, `/tmp/probe_quote.sh`, `/tmp/multiasset_test.sh` — diagnostic probes

These scripts use bash 3.2 (macOS BSD) — no `declare -A`, no `date +%s%3N`.

### Deployment

- Service: Next.js app deployed at `https://thai-life-demo-ui.onrender.com` (Render Web Service, free tier)
- In-memory job state survives between requests within a deploy; wiped on deploy or Render restart. Beware Render cold starts (~30s wake time on idle).
- Render-to-Render calls do not trigger wake — direct HTTPS calls do.

### Memory

User auto-memory lives at `/Users/shikhar-agrawal/.claude/projects/-Users-shikhar-agrawal-vlm-reparse-wrapper/memory/`. `MEMORY.md` is the index — always loaded into context. Relevant entries:

- `user_profile.md` — Shikhar, APM at Lyzr BFSI
- `project_thai_life_poc.md` — PoC overview
- `project_constraints.md` — durable constraints
- `project_lao_studio.md` — Lyzr LAO Studio quirks (BODY_ prefix, no API-Call → agent assets[] mapping)
- `reference_lyzr_endpoints.md` — Lyzr API endpoints + key
- `feedback_systematic_debugging.md` — Shikhar expects superpowers:systematic-debugging when stuck
- `feedback_terse_communication.md` — terse, no narration, human-sounding Slack drafts

## Immediate next actions

1. Read this brief and `docs/architecture-handoff.md`.
2. Check the user-memory `MEMORY.md` and any entries it links.
3. Invoke `superpowers:systematic-debugging` if continuing diagnosis, or `superpowers:brainstorming` if continuing the chunking architecture design.
4. **First test before design:** run the split-Scene_3 multi-asset experiment (split Scene_3 into two 4-page PDFs, upload each as separate asset, call Classification with `assets: [c1, c2]`, check whether both chunks' content reaches the agent). The script template lives in `/tmp/multiasset_test.sh` — copy and modify rather than re-deriving.
5. Resume brainstorming once that result is in.

## Open architectural questions for the design

- Does `assets: [c1, c2, c3]` cleanly concatenate, or do we need to merge text ourselves?
- Page renumbering across chunks (so underwriters see global page numbers, not chunk-local).
- Chunk boundary handling for documents that straddle chunks (e.g., a bill spanning pages 10-11 across chunks 1 and 2). v1 can probably accept this as a known imperfection.
- Failure recovery: per-chunk retry without re-uploading siblings.
- Concurrency limit on uploads (Parshva said his endpoint can't parallelize internally — confirm the safe upload-side concurrency).
- Where to handle PDF splitting: `pdf-lib` in the Next.js route handler is the obvious place. ~200KB dep.
- Should the existing single-page-PDF fast path stay separate, or should we always-chunk (chunks of 1 are a degenerate case)? Probably always-chunk for simplicity.
- Summarisation merge: if multi-asset concatenates, one Summarisation call with all chunks is fine. If not, we run Summarisation on the merged Extraction outputs — that's a different shape from today's "agent reads asset" pattern.
