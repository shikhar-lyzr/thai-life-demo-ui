# Thai Life PoC — Session Brief 2026-05-14

> Continuation of `docs/session-brief-2026-05-13.md`. This brief covers the shipped VLM chunking implementation. Read both briefs to get the full picture.

## TL;DR

The chunking architecture from yesterday's spec (`docs/superpowers/specs/2026-05-13-vlm-chunking-design.md`) has been implemented end-to-end on the `feat/vlm-chunking` branch. All 11 planned tasks plus a regression fix landed across 13 commits. End-to-end verification on Scene_3 (fast path), Scene_4 (chunked, 49p), and Scene_5 (chunked, 169p) all completed successfully. The pre-chunking pipeline's "fully fabricated underwriter brief" failure mode for scanned PDFs is resolved.

Status: branch is local-only. Not pushed to origin. Render has not redeployed.

## What shipped

Branch `feat/vlm-chunking`, 13 commits ahead of `main`:

| # | Commit | Summary |
|---|---|---|
| 1 | `4822722` | feat: add pdf-lib + countPages helper |
| 2 | `ba78e61` | feat: splitPdfWithOverlap utility |
| 3 | `010dd44` | feat: mapWithConcurrency utility |
| 4 | `c263fe8` | feat(types): add ChunkState + asset_ids/chunks on StageState |
| 5 | `64820d1` | feat(jobs): add updateChunk helper for per-chunk upload state |
| 6 | `f1d7ee6` | refactor(lyzr): callAgent takes asset_ids: string[] |
| 7 | `3eb2389` | feat(lyzr): uploadWithRetry with 5xx/network retries |
| 7a | `fcf9ea8` | chore(lyzr): document load-bearing 4xx-detection regex |
| 7b | `fa55565` | chore(lyzr): fix line reference in load-bearing comment |
| 9 | `31da8c6` | feat(orchestrator): chunked path for >10-page PDFs |
| 10 | `f0d0f2e` | feat(ui): per-chunk upload progress strip |
| 11 | `db5d8fd` | fix(orchestrator): preserve .pdf extension on chunk filenames |

`pdf-lib` is the only new runtime dependency (~200KB, MIT, Node-compatible).

## Architecture as built

`lib/orchestrator.ts::processPdf` branches on `pageCount`:

- **Fast path (≤10p):** today's behavior preserved verbatim — single `uploadToLyzr` call, single asset_id passed to all agents. `stage.upload` gets both `asset_id` (backward compat) and `asset_ids: [single]`. No `pdf-lib` round-trip.
- **Chunked path (>10p):** `splitPdfWithOverlap(pdfBytes, 10, 2)` produces ≤10-page chunks with 2-page overlap. `mapWithConcurrency(chunks, 5, uploadWithRetry)` uploads at most 5 in parallel with per-chunk retry on 5xx/network errors. Result: `asset_ids: string[]` of length N. All three agents receive the full `asset_ids` array in one `callAgent` call each. Per-chunk progress recorded via `updateChunk(jobId, idx, { ... })` and surfaced in the UI via `<ChunkStrip>`.

Constants are hardcoded at module scope: `CHUNK_SIZE=10`, `CHUNK_OVERLAP=2`, `UPLOAD_CONCURRENCY=5`.

## Verification outcomes

**Task 8 — multi-asset Classification output shape (pre-implementation gate):** Confirmed `PATH_A` via direct API call. Splitting Scene_3 into two 4-page chunks and calling Classification with `assets: [c1, c2]` returned `is_bundle: true, page_count: 8, pages: [...8 entries one per logical page...]`. Multi-page bill correctly split across pages 4 / 6 / 7 as `1/3, 2/3, 3/3`. No dedup needed; Task 9b skipped.

**Task 11 — end-to-end on the deployed shape:**

| File | Pages | Path | Status | Total wall | Markers visible |
|---|---|---|---|---|---|
| Scene_3.pdf | 8 | fast | completed | ~5.5 min | Kittipong (Scene_3 patient — expected) |
| Scene 4_HTEx.pdf | 49 | chunked, 6 chunks | completed | ~13 min | (Scene_4 content not yet ground-truthed by underwriter; "Thonburi Bamrungmuang" appears 3× — uncertain whether real or leakage) |
| Scene 5_Respiratory.pdf | 169 | chunked, 21 chunks | completed | ~28 min | Ekachai (60×), ด.ช. (38×), Korawit (2×), Samut Sakhon (1×) — real pediatric ground truth |

Scene_3 fast-path regression preserved. Scene_5 — the prior demo blocker — now produces underwriter briefs that reference the real patient (pediatric child Korawit Sansongsak at Ekachai Hospital, Samut Sakhon), not the fabricated personas from yesterday's pre-chunking diagnosis.

## Known limitations (carried forward)

1. **Lyzr's per-page OCR still appears to deliver only page 1 of each chunk.** Scene_5 (169p split into 21 chunks) reports `page_count: 21` in Classification, not 169 — strongly suggests the parser is still doing one OCR page per asset. This means our chunking workaround delivers ~21× more content than the unchunked baseline (which was 1 page), but still only ~12% of the actual document. Each chunk's "page 1" is the most important page (patient ID, hospital ID, document header), so the agents have enough to produce coherent briefs, but rich per-page detail mid-document is still being lost. Worth a follow-up Parshva conversation: can his parser OCR all pages within a chunk, not just the first?
2. **`page_count` in Classification output is misleading for chunked jobs.** It reports chunk-count, not actual page count. Underwriters reading the JSON will see "page_count: 21" for a 169-page bundle. Document this in the UI or a tooltip.
3. **Top-level upload-stage error doesn't include the failing chunk index.** When a chunk's `uploadWithRetry` exhausts retries, the top-level `stage.upload.error` is the raw 5xx message. Per-chunk error IS recorded at `stage.upload.chunks[idx].error`, but a quick scan of the top-level field is misleading. ~3-line fix (wrap the per-chunk catch's re-throw with `new Error(\`chunk ${idx+1} (pages ...): ${msg}\`)`). Code reviewer flagged this on Task 9 as Important; deferred to followup per scope.
4. **Wall time on Scene_5 was ~28 min, vs. estimated ~12-15 min in the design.** Lyzr's per-chunk lazy parse seems to scale slightly with chunk count; or the 5-parallel cap is too low. Worth confirming with Parshva that we can safely raise concurrency.
5. **`pdf-lib` re-serializes the source PDF on every chunk.** This produces visually-identical chunks but different bytes than the source. So far no parser-quality regression observed, but worth flagging if anything unexpected appears.

## Decisions deferred to v2

- Global page renumbering in agent outputs (so underwriters see "page 47 of 169" instead of chunk-local numbering).
- Smart chunk-boundary detection (currently fixed 8-new + 2-overlap; doesn't align with document boundaries within the bundle).
- Per-chunk retry from the UI (today: whole job retries via PDF re-upload).
- Structured `UploadError` class to replace the load-bearing regex in `uploadWithRetry` (code reviewer flagged this; minimum mitigation — a load-bearing comment — was applied in commits `fcf9ea8` / `fa55565`).

## Test artifacts

- `/tmp/path_decision.txt` — Task 8 verdict (PATH_A)
- `/tmp/task8_class.txt` — full Classification output for split-Scene_3 multi-asset test
- `/tmp/t11_s*_full.json`, `/tmp/t11r_s*_full.json` — Task 11 end-to-end captures (Scene_3, Scene_4, Scene_5)

## Immediate next actions

1. **Decide on push-to-main and Render redeploy.** Branch is local-only. Render will auto-deploy on push to `main`. Likely flow: rebase / squash-merge `feat/vlm-chunking` → push → watch Render build → re-verify against the production URL.
2. **Update Parshva.** Two concrete asks:
   - Does his parser OCR all pages within a chunk, or only page 1? (Today's evidence: only page 1 per chunk.) If the former, we may be able to raise `CHUNK_SIZE` toward 10 without loss; if the latter, the chunking workaround is the limit.
   - What's the safe `UPLOAD_CONCURRENCY` against his endpoint? We picked 5 conservatively; can it absorb more without rate-limiting?
3. **Re-run Scene_4 verification with underwriter eyes.** I don't have ground truth for Scene_4's real patient. Worth a manual look at the chunked output (`/tmp/t11r_s4_full.json`) to confirm the "Thonburi Bamrungmuang" hits are real document content, not few-shot leakage.

## Reference materials

Same as `docs/session-brief-2026-05-13.md` Reference section. New additions:

- `docs/superpowers/specs/2026-05-13-vlm-chunking-design.md` — design spec
- `docs/superpowers/plans/2026-05-13-vlm-chunking.md` — implementation plan
- `lib/pdf.ts` — new module with `countPages`, `splitPdfWithOverlap`, `mapWithConcurrency`
- `components/chunk-strip.tsx` — per-chunk UI

50 unit/integration tests pass. Build clean. One pre-existing unhandled-rejection warning in the lyzr retry test carries over from main (was present before this work started).
