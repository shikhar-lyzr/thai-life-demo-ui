# VLM Chunking — Design Spec

> Status: draft, awaiting user review before transition to writing-plans.
> Author: Claude session 2026-05-13 (continuation of prior session, see `docs/session-brief-2026-05-13.md`).

## Problem statement

Lyzr's `lyzr_parse` provider with `parsing_mode=full, enable_vlm=true` silently truncates scanned image-only PDFs to page 1 of content. Multi-page coverage works only for PDFs with embedded text (Scene_3, 8 pages, works end-to-end today). For Scene_4 (49 pages, scanned) and Scene_5 (169 pages, scanned), the agents receive only page 1's content and confabulate the rest from few-shot prompt examples. Parshva (Lyzr engineer) has confirmed this is a parser-side limitation and has accepted a per-call limit of 10 pages. Multi-page coverage is the demo blocker for Beryl8.

## Goal

Add a chunking layer to `processPdf` so that PDFs >10 pages are split into ≤10-page chunks on our side, uploaded in parallel, and fed to the agents via the multi-asset `assets: [c1, c2, ...]` parameter on `/v3/inference/chat/`. The agents already concatenate multi-asset input — verified today by direct Y/N probe (see "Verification of multi-asset behavior" below).

## Non-goals (v1)

- Per-chunk failure recovery via a "resubmit just this chunk" API. If retries fail, the whole job fails and the user re-uploads.
- Global page renumbering in agent outputs (so underwriters see "page 47 of 169" instead of "chunk 5 page 2/10"). v2 only if underwriters report confusion.
- Fixing Lyzr's parser bug. This is a client-side workaround.
- Bypassing Lyzr's VLM by using AWS Textract or any other OCR. Considered as alternative; rejected for v1 because it changes the entire pipeline shape.

## Architecture

### High-level flow

```
processPdf(pdfBytes, fileName) [in lib/orchestrator.ts]
  │
  ├─ pageCount = countPages(pdfBytes)
  │
  ├─ if pageCount ≤ 10:   FAST PATH (preserves today's validated behavior)
  │     ↓
  │     asset_id = uploadToLyzr(env, pdfBytes, fileName)
  │     return callAgentsParallel(env, [asset_id], jobState)
  │
  └─ if pageCount > 10:   CHUNKED PATH
        ↓
        chunks = splitPdfWithOverlap(pdfBytes, chunkSize=10, overlap=2)
        ↓
        asset_ids = mapWithConcurrency(chunks, limit=5, uploadWithRetry)
        ↓
        callAgentsParallel(env, asset_ids, jobState)
```

The fast path preserves today's Scene_3 behavior verbatim — no regression for the validated 8-page case.

### Chunking with overlap

```
chunk_i pages = [(i-1)*8 + 1 - 2, (i-1)*8 + 10]   clipped to [1, totalPages]
```

Effective new content per chunk = 8 pages. Overlap = 2 pages. Covers any document of ≤3 pages fully within a single chunk — which is the vast majority of insurance documents (Thai National ID = 1 page, bank passbook = 1 page, hospital receipts = 1-2 pages, itemized bills = 1-3 pages, medical certificates = 1 page).

Example for 28-page PDF:

| Chunk | Pages | New content | Carryover |
|---|---|---|---|
| 1 | 1-10 | 1-10 | none |
| 2 | 9-18 | 11-18 | 9-10 |
| 3 | 17-26 | 19-26 | 17-18 |
| 4 | 25-28 | 27-28 | 25-26 |

For a 169-page Scene_5: 21 chunks.

### Concurrency

- **Uploads:** 5 in parallel (bounded). Parshva said his VLM endpoint cannot parallelize internally; 5 simultaneous uploads is a safe default that won't hammer his endpoint. Confirm with him when next pinged for a real safe-parallelism number; tune if needed.
- **Agent calls:** unchanged — three agents (Classification, Extraction, Summarisation) fire in parallel against the chunked asset list. Promise.allSettled, same as today.

### Failure semantics

Each chunk upload is wrapped in a 2-retry-with-backoff (5s, 15s) — `uploadWithRetry`. Retries are limited to transient errors (5xx, network, timeout). 4xx errors fail immediately (re-trying a malformed upload is pointless).

If a chunk upload still fails after retries → the whole job fails. The job state records which chunk failed (`stages.upload.chunks[failedIdx].error`) so the UI can show actionable detail to the user. User must re-upload the PDF to retry.

No mid-stage partial recovery for v1.

### Multi-asset agent calls

`callAgent(env, args)` today accepts `args.asset_id: string`. Change signature to `args.asset_ids: string[]`. POST body becomes:

```json
{
  "user_id": "...",
  "agent_id": "...",
  "session_id": "...",
  "message": "...",
  "assets": ["chunk1_asset_id", "chunk2_asset_id", "..."]
}
```

For single-asset jobs (fast path) the array has length 1; the JSON shape is unchanged from today.

Verified today via direct Y/N probe (`/tmp/multiasset_v2.sh`):

- Single-asset baseline returns Y to markers in the single asset.
- Multi-asset `assets: [c1, c2]` returns Y to markers in **both** chunks.
- Negative control (`xyz999abc`) returns N in all cases.
- Order does not affect content delivery (both `[c1, c2]` and `[c2, c1]` deliver content from both).

### Dedup of overlap content (Path A — trust the agent)

Because pages 9-10 appear in both chunk1 and chunk2, the parsed markdown blob contains those pages' content twice. We expect the Classification agent to recognize this from its existing prompt (which classifies on document type and identity markers, not raw position) and produce one classification entry per logical page, not two. This assumption is unverified for the chunked case — see the verification step below.

**Implementation-time verification (required before merge):** run a real Classification call on a chunked Scene_5 (≥3 chunks, with deliberate overlap), inspect the JSON output, and confirm:

1. `page_count` in the output matches the original PDF's page count, not the sum-of-chunks page count.
2. Each logical page appears once in `pages: [...]`, not duplicated.
3. Documents spanning chunks (e.g., a 3-page bill on pages 9-11) are classified as one document, not two.

If any of (1)(2)(3) fail → fall back to Path B: orchestrator-side dedup.

**Path B fallback:** if duplicates appear, add a post-processing step in `orchestrator.ts` that runs after each agent call: group Classification entries by `(page_number, HN, document_id)`, keep the highest-confidence entry per group, drop the rest. ~30 lines. Add only if Path A fails.

## State model changes

### `lib/types.ts`

Today:
```ts
export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  asset_id?: string;     // ← single
  error?: string;
}
```

Add a per-chunk substate for the upload stage:
```ts
export interface ChunkState {
  idx: number;
  status: StageStatus;
  asset_id?: string;
  error?: string;
  elapsed_ms?: number;
  page_range?: [number, number];  // 1-indexed, inclusive, e.g. [9, 18]
}

export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  asset_id?: string;          // keep for fast-path single-asset case
  asset_ids?: string[];       // chunked-path
  chunks?: ChunkState[];      // per-chunk status (chunked path only)
  error?: string;
}
```

The fast path keeps `asset_id` populated for backwards compatibility with the existing UI; the chunked path populates `asset_ids` and `chunks`. UI renders whichever is present.

### `lib/orchestrator.ts`

`processPdf` branches on `pageCount`:

- Fast path: unchanged from today. Single `uploadToLyzr` call, then `callAgentsParallel(env, [asset_id], jobState)` with the array form.
- Chunked path: `splitPdfWithOverlap` → `mapWithConcurrency(chunks, 5, uploadWithRetry)` → updates per-chunk state as each completes → `callAgentsParallel(env, asset_ids, jobState)`.

`callAgentsParallel` is updated to take `asset_ids: string[]` (was `asset_id: string`). All three agents (Classification, Extraction, Summarisation) receive the full asset_ids list — no per-agent fanout differences.

### `lib/lyzr.ts`

- New helper: `uploadWithRetry(env, pdfBytes, fileName, { retries: 2, backoffMs: [5000, 15000] })`. Wraps `uploadToLyzr`. Retries on 5xx, network errors, and timeouts. Does not retry on 4xx.
- `callAgent(env, args)` signature: `args.asset_id: string` → `args.asset_ids: string[]`. POST body uses `assets: args.asset_ids` (today's code already wraps a single asset_id in an array for the assets[] field, so the runtime shape is unchanged for fast-path callers).

### New module: `lib/pdf.ts` (or similar)

- `countPages(buffer: Buffer): number` — uses `pdf-lib`'s `PDFDocument.load(buffer)` then `.getPageCount()`.
- `splitPdfWithOverlap(buffer: Buffer, chunkSize: number, overlap: number): Buffer[]` — uses `pdf-lib`'s `PDFDocument.copyPages(srcDoc, indices)` per chunk.
- `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]>` — bounded-parallel mapper. ~15 lines, no external deps.

### `package.json`

- Add `pdf-lib` (~200KB, MIT). Node-compatible, runs in Next.js route handlers.

### `app/jobs/[id]/page.tsx`

- If `state.stages.upload.chunks` exists, render a per-chunk progress strip showing status of each chunk (queued, uploading, parsed, failed) with page ranges. If absent (fast path), unchanged from today.

## Verification plan (required before shipping)

1. **Multi-asset Classification output shape.** Upload Scene_5 split into ≥3 chunks. Run Classification with `assets: [c1, c2, c3, ...]`. Inspect JSON output:
   - `page_count` matches original PDF page count
   - Each logical page appears once in `pages[]`
   - Multi-page documents (e.g., the bill across pages 9-11) get one classification entry, not split
   - If any fail → implement Path B dedup before further testing

2. **End-to-end on Scene_3 (regression check).** Fast path must produce identical output to today's validated behavior. Same Classification + Extraction + Summarisation outputs, same wall time within variance.

3. **End-to-end on Scene_4 (49p).** Chunked path produces multi-page coverage. Identity-extraction agent reports correct patient (from page 1) and at least one document from pages 2+. No confabulated content from Scene_3 few-shot examples.

4. **End-to-end on Scene_5 (169p).** Chunked path produces multi-page coverage. Identity extraction reports the pediatric patient (Korawit Sansongsak / Ekachai Hospital / ด.ช.) from page 1, plus at least one document from each chunk.

5. **Failure recovery.** Inject a 502 on chunk 3 of 5 via test harness. Verify the retry mechanism fires twice with the documented backoffs and either succeeds or fails the job cleanly with the failed chunk's idx exposed in `error`.

## Wall-time estimate

For a 169-page Scene_5:

| Phase | Duration |
|---|---|
| `splitPdfWithOverlap` (CPU-bound, in-memory) | < 2s |
| 21 chunk uploads at 5-parallel concurrency | 21/5 × ~5s/upload ≈ 25s |
| First agent call per chunk (lazy parse) at 5-parallel | 21/5 × ~2 min ≈ 8-9 min |
| Real agent calls (Classification + Extraction + Summarisation in parallel) | ~3-5 min |
| **Total** | **~12-15 min** |

For Scene_3 (8 pages, fast path): unchanged from today, ~5-8 min.

Worth confirming with Parshva that 5 parallel uploads doesn't trigger his rate limit. If it does, lower the concurrency limit.

## Open questions for implementation phase

- **Warmup calls.** Should we proactively trigger lazy parse on each chunk with a throwaway inference call right after upload (parallel within the 5-limit)? This guarantees the real agent calls don't all serialize on cold-parse. Default: yes, add a "warmup" step in `mapWithConcurrency` that fires a no-op inference call per chunk and waits for parse to finish. Cost: 21 extra ~minute-long warmup calls; saves the same time on the real agent path. Net wall time roughly unchanged but more predictable.
- **Configurability.** Should `CHUNK_SIZE`, `OVERLAP`, and `UPLOAD_CONCURRENCY` be hardcoded or env-var-driven? Default: hardcode in v1 for clarity. Move to env vars only if production tuning is needed.
- **Logging.** Per-chunk timing should be logged via existing structured stdout logger (see `lib/lyzr.ts` retry-on-5xx logging pattern). Same fields per chunk: idx, asset_id, page_range, elapsed_ms, error.

## Out of scope confirmed

- Re-uploading just one chunk from the UI (today: whole job retries).
- Chunk boundary handling for documents > 4 pages (rare in insurance; today's 2-page overlap covers ≤3-page docs which are the vast majority).
- Global page renumbering in agent outputs.
- Bypassing Lyzr's VLM entirely (AWS Textract was considered; rejected because it changes pipeline shape, blocks none of the existing validation, and adds a second external dependency).

## What changes vs today

| File | Change |
|---|---|
| `lib/orchestrator.ts` | Branch on pageCount; add chunked path |
| `lib/lyzr.ts` | Add `uploadWithRetry`; change `callAgent` signature to `asset_ids: string[]` |
| `lib/types.ts` | Add `ChunkState`, extend `StageState` |
| `lib/pdf.ts` (new) | `countPages`, `splitPdfWithOverlap`, `mapWithConcurrency` |
| `app/jobs/[id]/page.tsx` | Per-chunk progress strip when chunked path is used |
| `package.json` | Add `pdf-lib` dependency |

Tests:
- Unit tests for `splitPdfWithOverlap` (page range math, overlap correctness, last-chunk handling)
- Unit test for `mapWithConcurrency` (boundedness, ordering, error propagation)
- Integration test (mocked Lyzr) for chunked-path `processPdf` end-to-end
- Hand-run verification tests 1-5 above against real Lyzr endpoint with Scene_3 / Scene_4 / Scene_5

## Verification-of-multi-asset-behavior reference

This design is grounded in the today's test result (script at `/tmp/multiasset_v2.sh`, outputs at `/tmp/ma2_*`). Scene_3 was split into two 4-page chunks; Y/N probe with chunk-unique markers confirmed:

- `assets: [chunk1_only]` → Y to chunk1-unique markers, N to chunk2-unique markers
- `assets: [chunk2_only]` → Y to chunk2-unique markers, N to chunk1-unique markers
- `assets: [chunk1, chunk2]` → Y to BOTH chunks' unique markers, N to negative control
- `assets: [chunk2, chunk1]` → same as above (order does not affect content delivery)

The agent receives a single concatenated markdown blob containing the parsed text from all assets. Order of assets in the array affects layout slightly but content from all assets is delivered.

## Next steps after spec approval

1. User reviews this spec.
2. On approval, transition to `superpowers:writing-plans` to produce a step-by-step implementation plan in `docs/superpowers/plans/`.
3. On plan approval, transition to `superpowers:test-driven-development` for implementation.
