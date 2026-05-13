# VLM Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side chunking layer to `processPdf` that splits PDFs >10 pages into ≤10-page chunks with 2-page overlap, uploads them in bounded parallel (5 at a time), retries transient failures, and feeds the resulting asset_ids to all three agents via `assets: [c1, c2, ...]`.

**Architecture:** Fast path for ≤10p PDFs (preserves validated Scene_3 behavior). Chunked path for >10p PDFs uses new `lib/pdf.ts` utilities for splitting and bounded concurrency. `callAgent` signature changes from `asset_id: string` to `asset_ids: string[]`. Job state gets a new `ChunkState[]` substate for per-chunk progress. UI renders a per-chunk progress strip when chunked path is used.

**Tech Stack:** Next.js 16 / TypeScript 5 / Node 20+ / Vitest / `pdf-lib` (new dep). Lyzr's `/v3/assets/upload` and `/v3/inference/chat/` endpoints unchanged.

---

## Task 0: Baseline check

**Files:** none modified — just a sanity check before the first commit.

- [ ] **Step 1: Verify test suite passes on the current code**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm test`
Expected: all existing tests pass (env.test.ts, jobs.test.ts, lyzr.test.ts, orchestrator.test.ts). If any fail, STOP and report — we don't want to confuse our changes with pre-existing breakage.

- [ ] **Step 2: Verify build passes on the current code**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run build`
Expected: build succeeds. If it fails, STOP.

No commit for this task — it's a baseline gate.

---

## Task 1: Add `pdf-lib` dep + `countPages` helper

**Files:**
- Modify: `package.json` — add pdf-lib dependency
- Create: `lib/pdf.ts`
- Create: `lib/__tests__/pdf.test.ts`

- [ ] **Step 1: Install pdf-lib**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm install pdf-lib`
Expected: pdf-lib added to dependencies in package.json. Verify with `cat package.json | grep pdf-lib`.

- [ ] **Step 2: Write failing test for `countPages`**

Create `lib/__tests__/pdf.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { countPages } from "../pdf";

const SCENE3 = resolve(__dirname, "../../Scene_3.pdf");

describe("countPages", () => {
  it("returns 8 for Scene_3.pdf", () => {
    const buf = readFileSync(SCENE3);
    expect(countPages(buf)).resolves.toBe(8);
  });

  it("returns 1 for a single-page PDF buffer", async () => {
    // Use pdf-lib to construct a single-page PDF inline so the test doesn't depend on a fixture
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const buf = Buffer.from(await doc.save());
    expect(await countPages(buf)).toBe(1);
  });

  it("returns 5 for a five-page synthetic PDF", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
    const buf = Buffer.from(await doc.save());
    expect(await countPages(buf)).toBe(5);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: FAIL — `Cannot find module '../pdf'` (pdf.ts doesn't exist yet).

- [ ] **Step 4: Implement `countPages`**

Create `lib/pdf.ts`:

```typescript
import { PDFDocument } from "pdf-lib";

/**
 * Returns the number of pages in a PDF buffer.
 * Loads the PDF into memory once via pdf-lib's parser.
 */
export async function countPages(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add package.json package-lock.json lib/pdf.ts lib/__tests__/pdf.test.ts && git commit -m "$(cat <<'EOF'
feat: add pdf-lib + countPages helper

First building block for VLM chunking — count pages on the orchestrator
side before deciding fast-path vs chunked-path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement `splitPdfWithOverlap`

**Files:**
- Modify: `lib/pdf.ts` — add `splitPdfWithOverlap`
- Modify: `lib/__tests__/pdf.test.ts` — add splitting tests

- [ ] **Step 1: Write failing tests for `splitPdfWithOverlap`**

Append to `lib/__tests__/pdf.test.ts`:

```typescript
import { countPages, splitPdfWithOverlap } from "../pdf";

async function makePdf(n: number): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe("splitPdfWithOverlap", () => {
  it("returns one chunk for an 8-page PDF when chunkSize=10", async () => {
    const buf = await makePdf(8);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(1);
    expect(await countPages(chunks[0].buffer)).toBe(8);
    expect(chunks[0].pageRange).toEqual([1, 8]);
  });

  it("returns one chunk for a 10-page PDF when chunkSize=10", async () => {
    const buf = await makePdf(10);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(1);
    expect(await countPages(chunks[0].buffer)).toBe(10);
    expect(chunks[0].pageRange).toEqual([1, 10]);
  });

  it("returns two chunks for an 11-page PDF, second chunk overlaps last 2 pages of first", async () => {
    const buf = await makePdf(11);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 11]);
    expect(await countPages(chunks[0].buffer)).toBe(10);
    expect(await countPages(chunks[1].buffer)).toBe(3);
  });

  it("returns two chunks for an 18-page PDF (clean boundary)", async () => {
    const buf = await makePdf(18);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 18]);
  });

  it("returns three chunks for a 19-page PDF", async () => {
    const buf = await makePdf(19);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 18]);
    expect(chunks[2].pageRange).toEqual([17, 19]);
  });

  it("returns 21 chunks for a 169-page PDF (Scene_5 size)", async () => {
    const buf = await makePdf(169);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(21);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[20].pageRange).toEqual([161, 169]);
  });

  it("does not emit a chunk that would be entirely overlap with the previous", async () => {
    // 17 pages with chunkSize=10, overlap=2 should NOT produce a 3rd chunk of only [17, 17]
    const buf = await makePdf(17);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].pageRange).toEqual([9, 17]);
  });

  it("throws if chunkSize <= overlap", async () => {
    const buf = await makePdf(20);
    await expect(splitPdfWithOverlap(buf, 2, 2)).rejects.toThrow(/chunkSize must be greater than overlap/i);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: 8 new tests FAIL — `splitPdfWithOverlap is not exported from "../pdf"`.

- [ ] **Step 3: Implement `splitPdfWithOverlap` in `lib/pdf.ts`**

Append to `lib/pdf.ts`:

```typescript
export interface PdfChunk {
  /** 1-indexed inclusive page range in the source PDF. */
  pageRange: [number, number];
  /** Bytes of a freshly-built PDF containing only those pages. */
  buffer: Buffer;
}

/**
 * Splits a PDF into overlapping chunks. Each chunk has up to chunkSize pages.
 * Chunk i (i>=2) starts `overlap` pages before chunk i-1 ends — meaning
 * chunk i-1's last `overlap` pages are repeated at the start of chunk i.
 *
 * Effective new pages per chunk = chunkSize - overlap.
 *
 * If totalPages <= chunkSize, returns a single chunk covering the whole PDF
 * (a verbatim re-serialization, NOT the original bytes).
 *
 * Chunks that would consist entirely of overlap (no new pages vs the
 * previous chunk) are not emitted.
 */
export async function splitPdfWithOverlap(
  buffer: Buffer,
  chunkSize: number,
  overlap: number
): Promise<PdfChunk[]> {
  if (chunkSize <= overlap) {
    throw new Error(`chunkSize must be greater than overlap (got chunkSize=${chunkSize}, overlap=${overlap})`);
  }

  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = src.getPageCount();
  if (totalPages === 0) return [];

  const stride = chunkSize - overlap;
  const chunks: PdfChunk[] = [];

  for (let i = 0; ; i++) {
    const start = i * stride + 1;             // 1-indexed
    const end = Math.min(start + chunkSize - 1, totalPages);
    if (start > totalPages) break;

    // Skip chunks that would be entirely overlap with the previous chunk.
    // Chunk i>=1 has new pages starting at `start + overlap`. If that's
    // already past totalPages, every page in this chunk is repeated content
    // from the previous chunk — don't emit it.
    if (i >= 1 && start + overlap > totalPages) break;

    const dst = await PDFDocument.create();
    const indices: number[] = [];
    for (let p = start; p <= end; p++) indices.push(p - 1); // pdf-lib uses 0-indexed
    const copied = await dst.copyPages(src, indices);
    for (const page of copied) dst.addPage(page);

    chunks.push({
      pageRange: [start, end],
      buffer: Buffer.from(await dst.save()),
    });
  }

  return chunks;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: 11/11 PASS (3 countPages + 8 splitPdfWithOverlap).

- [ ] **Step 5: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/pdf.ts lib/__tests__/pdf.test.ts && git commit -m "$(cat <<'EOF'
feat: splitPdfWithOverlap utility

Splits PDFs into ≤chunkSize-page chunks with `overlap` pages of carryover
between adjacent chunks. Skips chunks that would consist entirely of
overlap (no new content vs the previous chunk).

For chunkSize=10 overlap=2, a 169-page PDF yields 21 chunks; a 10-page
PDF yields 1 chunk (round-trip through pdf-lib).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Implement `mapWithConcurrency`

**Files:**
- Modify: `lib/pdf.ts` — add `mapWithConcurrency`
- Modify: `lib/__tests__/pdf.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/__tests__/pdf.test.ts`:

```typescript
import { mapWithConcurrency } from "../pdf";

describe("mapWithConcurrency", () => {
  it("returns results in input order even when fn completes out of order", async () => {
    const items = [100, 50, 200, 10, 150];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([200, 100, 400, 20, 300]);
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it("propagates the first rejection without awaiting in-flight tasks past their next checkpoint", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("kaboom");
        await new Promise((r) => setTimeout(r, 5));
        return n;
      })
    ).rejects.toThrow("kaboom");
  });

  it("handles empty input", async () => {
    const results = await mapWithConcurrency<number, number>([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  it("passes item index to fn", async () => {
    const items = ["a", "b", "c"];
    const results = await mapWithConcurrency(items, 2, async (item, idx) => `${item}-${idx}`);
    expect(results).toEqual(["a-0", "b-1", "c-2"]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: 5 new tests FAIL — `mapWithConcurrency is not exported`.

- [ ] **Step 3: Implement `mapWithConcurrency`**

Append to `lib/pdf.ts`:

```typescript
/**
 * Runs `fn(item, idx)` for each item with at most `limit` in flight at any time.
 * Returns results in the input order. Rejects on the first error.
 *
 * Note: when fn throws, in-flight tasks continue to run to their natural
 * completion (their results are discarded); we just don't await any further
 * unstarted items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (limit < 1) throw new Error(`limit must be >= 1 (got ${limit})`);
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  let aborted = false;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      if (aborted) return;
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/pdf.test.ts`
Expected: 16/16 PASS (3 + 8 + 5).

- [ ] **Step 5: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/pdf.ts lib/__tests__/pdf.test.ts && git commit -m "$(cat <<'EOF'
feat: mapWithConcurrency utility

Bounded-parallel mapper used to upload N chunks at most M-at-a-time
during the chunked path. Preserves input order in results; aborts on
first error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `lib/types.ts` with `ChunkState` and `asset_ids`

**Files:**
- Modify: `lib/types.ts`

No tests for type-only changes — verification is `npm run build`.

- [ ] **Step 1: Modify `lib/types.ts`**

Open `lib/types.ts`. Find the `StageState` interface (around line 5):

```typescript
export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  asset_id?: string;
  error?: string;
}
```

Replace with:

```typescript
export interface ChunkState {
  /** 0-indexed position in the chunks array. */
  idx: number;
  status: StageStatus;
  /** 1-indexed inclusive [start, end] page range in the source PDF. */
  page_range: [number, number];
  /** Set once the chunk finishes uploading. */
  asset_id?: string;
  /** Wall-clock for the upload of this chunk (after retries). */
  elapsed_ms?: number;
  /** Populated if the chunk's upload failed after all retries. */
  error?: string;
}

export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  /** Fast path (≤CHUNK_SIZE-page PDF): single asset_id. */
  asset_id?: string;
  /** Chunked path (>CHUNK_SIZE-page PDF): one asset_id per chunk, in chunk order. */
  asset_ids?: string[];
  /** Chunked path: per-chunk progress for UI rendering. */
  chunks?: ChunkState[];
  error?: string;
}
```

- [ ] **Step 2: Verify build still passes**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run build`
Expected: build succeeds. Existing references to `stage.asset_id` continue to work (still optional, still on StageState).

- [ ] **Step 3: Verify all tests still pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm test`
Expected: all tests pass — no behavior change yet, just type widening.

- [ ] **Step 4: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/types.ts && git commit -m "$(cat <<'EOF'
feat(types): add ChunkState + asset_ids/chunks on StageState

Type-only change. Fast-path stays on stage.asset_id; chunked-path will
populate stage.asset_ids and stage.chunks. No runtime change yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `updateChunk` helper to `lib/jobs.ts`

**Files:**
- Modify: `lib/jobs.ts`
- Modify: `lib/__tests__/jobs.test.ts`

- [ ] **Step 1: Write failing test**

Append to `lib/__tests__/jobs.test.ts`:

```typescript
import { createJob, updateStage, updateChunk, getJob } from "../jobs";

describe("updateChunk", () => {
  it("initializes the upload stage's chunks array and updates per-chunk state", () => {
    const id = createJob("big.pdf");
    updateStage(id, "upload", { status: "running", started_at: Date.now() });
    updateChunk(id, 0, { idx: 0, status: "running", page_range: [1, 10] });
    updateChunk(id, 1, { idx: 1, status: "running", page_range: [9, 18] });
    const job = getJob(id);
    expect(job?.stages.upload.chunks).toHaveLength(2);
    expect(job?.stages.upload.chunks?.[0].page_range).toEqual([1, 10]);
    expect(job?.stages.upload.chunks?.[1].page_range).toEqual([9, 18]);
  });

  it("merges patches into existing chunk state", () => {
    const id = createJob("big.pdf");
    updateChunk(id, 0, { idx: 0, status: "running", page_range: [1, 10] });
    updateChunk(id, 0, { status: "done", asset_id: "asset-abc", elapsed_ms: 3000 });
    const chunk = getJob(id)?.stages.upload.chunks?.[0];
    expect(chunk?.status).toBe("done");
    expect(chunk?.asset_id).toBe("asset-abc");
    expect(chunk?.elapsed_ms).toBe(3000);
    expect(chunk?.page_range).toEqual([1, 10]); // preserved
  });

  it("is a no-op for an unknown job_id", () => {
    expect(() => updateChunk("missing", 0, { idx: 0, status: "running", page_range: [1, 10] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/jobs.test.ts`
Expected: 3 new tests FAIL — `updateChunk is not exported`.

- [ ] **Step 3: Implement `updateChunk` in `lib/jobs.ts`**

Append to `lib/jobs.ts` (after the existing `updateStage` definition):

```typescript
export function updateChunk(job_id: string, chunkIdx: number, patch: Partial<ChunkState>): void {
  const job = store.get(job_id);
  if (!job) return;
  const stage = job.stages.upload;
  const existing = stage.chunks ?? [];
  const current = existing[chunkIdx] ?? ({ idx: chunkIdx } as ChunkState);
  const merged: ChunkState = { ...current, ...patch, idx: chunkIdx };
  const next = existing.slice();
  next[chunkIdx] = merged;
  job.stages.upload = { ...stage, chunks: next };
}
```

Also add `ChunkState` to the imports at the top of `lib/jobs.ts`:

```typescript
import type { JobState, StageName, StageState, AgentResult, AgentLabel, ChunkState } from "./types";
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/jobs.test.ts`
Expected: all existing jobs tests still pass + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/jobs.ts lib/__tests__/jobs.test.ts && git commit -m "$(cat <<'EOF'
feat(jobs): add updateChunk helper for per-chunk upload state

Mirrors updateStage but writes to stage.upload.chunks[idx] with a
shallow merge. Used by the orchestrator to record per-chunk progress
during chunked uploads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Change `callAgent` signature to `asset_ids: string[]`

**Files:**
- Modify: `lib/lyzr.ts` — `CallAgentArgs.asset_id` → `asset_ids`
- Modify: `lib/orchestrator.ts` — update single call site
- Modify: `lib/__tests__/lyzr.test.ts` — update test args

- [ ] **Step 1: Update the test in `lib/__tests__/lyzr.test.ts` to use `asset_ids`**

Find every test invocation of `callAgent(env, { ... })` in `lib/__tests__/lyzr.test.ts` and change `asset_id: "..."` to `asset_ids: ["..."]`. The POST body assertion that checks `assets: ["..."]` should not change (the wire format is identical).

For example, if a test reads:

```typescript
const out = await callAgent(env, {
  agent_id: "a1",
  user_id: "u1",
  session_id: "s1",
  asset_id: "asset-xyz",
  message: "go",
});
```

Change to:

```typescript
const out = await callAgent(env, {
  agent_id: "a1",
  user_id: "u1",
  session_id: "s1",
  asset_ids: ["asset-xyz"],
  message: "go",
});
```

- [ ] **Step 2: Run lyzr.test.ts, verify it fails on type mismatch**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/lyzr.test.ts`
Expected: FAIL — TypeScript error: `'asset_ids' does not exist in type 'CallAgentArgs'`.

- [ ] **Step 3: Update `lib/lyzr.ts`**

Find the `CallAgentArgs` interface (around line 47):

```typescript
export interface CallAgentArgs {
  agent_id: string;
  user_id: string;
  session_id: string;
  asset_id: string;
  message: string;
}
```

Replace `asset_id: string` with `asset_ids: string[]`:

```typescript
export interface CallAgentArgs {
  agent_id: string;
  user_id: string;
  session_id: string;
  asset_ids: string[];
  message: string;
}
```

Then in the `callAgent` body construction (around line 61), change `assets: [args.asset_id]` to `assets: args.asset_ids`:

```typescript
const body = JSON.stringify({
  user_id: args.user_id,
  agent_id: args.agent_id,
  session_id: args.session_id,
  message: args.message,
  assets: args.asset_ids,
});
```

- [ ] **Step 4: Update the single call site in `lib/orchestrator.ts`**

Find the line in `lib/orchestrator.ts` (in the `agentTasks` block, around line 32):

```typescript
const raw = await callAgent(env, {
  agent_id: agent.agent_id,
  user_id: agent.user_id,
  session_id: randomUUID(),
  asset_id: assetId,
  message: agent.message,
});
```

Replace `asset_id: assetId` with `asset_ids: [assetId]` (the fast path keeps a single-asset array — this is the SAME wire format as today):

```typescript
const raw = await callAgent(env, {
  agent_id: agent.agent_id,
  user_id: agent.user_id,
  session_id: randomUUID(),
  asset_ids: [assetId],
  message: agent.message,
});
```

- [ ] **Step 5: Run all tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm test`
Expected: all tests pass, including the updated lyzr.test.ts and orchestrator.test.ts (assuming orchestrator.test.ts mocks callAgent and was passing before).

- [ ] **Step 6: Verify build passes**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/lyzr.ts lib/orchestrator.ts lib/__tests__/lyzr.test.ts && git commit -m "$(cat <<'EOF'
refactor(lyzr): callAgent takes asset_ids: string[] instead of asset_id

Wire format unchanged — today's body already sends assets: [asset_id].
This change makes the API explicit about supporting multi-asset calls,
which the chunked path will use. Fast path passes a single-element array.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `uploadWithRetry` to `lib/lyzr.ts`

**Files:**
- Modify: `lib/lyzr.ts`
- Modify: `lib/__tests__/lyzr.test.ts`

- [ ] **Step 1: Write failing tests for `uploadWithRetry`**

Append to `lib/__tests__/lyzr.test.ts`. The existing test file already mocks `undici.fetch` via `undiciFetchMock`. For `uploadWithRetry`, however, the underlying `uploadToLyzr` uses the global `fetch`, not undici. We need to mock the global `fetch` too. The cleanest approach: stub `globalThis.fetch` per-test via `vi.spyOn`.

```typescript
import { uploadWithRetry } from "../lyzr";

describe("uploadWithRetry", () => {
  const env = { lyzrApiKey: "sk-test", lyzrBaseUrl: "https://lyzr.example" };
  const buf = Buffer.from("fake-pdf-bytes");

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the asset_id on first-try success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ success: true, asset_id: "asset-1" }] }), { status: 200 })
    );
    const out = await uploadWithRetry(env, buf, "f.pdf");
    expect(out).toBe("asset-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ success: true, asset_id: "asset-2" }] }), { status: 200 }));
    const out = await uploadWithRetry(env, buf, "f.pdf", { backoffMs: [10, 20] });
    expect(out).toBe("asset-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(uploadWithRetry(env, buf, "f.pdf", { backoffMs: [10, 20] })).rejects.toThrow(/upload failed: 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails after exhausting retries on persistent 5xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream gone", { status: 503 }));
    await expect(uploadWithRetry(env, buf, "f.pdf", { backoffMs: [10, 20] })).rejects.toThrow(/upload failed: 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries on network errors (e.g. socket reset)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed: socket reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ success: true, asset_id: "asset-3" }] }), { status: 200 }));
    const out = await uploadWithRetry(env, buf, "f.pdf", { backoffMs: [10, 20] });
    expect(out).toBe("asset-3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/lyzr.test.ts`
Expected: 5 new tests FAIL — `uploadWithRetry is not exported`.

- [ ] **Step 3: Implement `uploadWithRetry`**

Append to `lib/lyzr.ts`:

```typescript
const DEFAULT_UPLOAD_BACKOFFS_MS = [5000, 15000];

/**
 * Uploads a PDF with retry-on-transient-error semantics.
 *
 * Retries on:
 *   - 5xx responses
 *   - thrown errors from fetch (network failures, timeouts)
 *
 * Does NOT retry on 4xx (the request is malformed; retry won't help).
 *
 * Backoffs default to [5s, 15s] — two retries after the initial attempt.
 */
export async function uploadWithRetry(
  env: Env,
  pdfBytes: Buffer,
  fileName: string,
  opts?: { backoffMs?: number[] }
): Promise<string> {
  const backoffs = opts?.backoffMs ?? DEFAULT_UPLOAD_BACKOFFS_MS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await uploadToLyzr(env, pdfBytes, fileName);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry 4xx — message format from uploadToLyzr is "upload failed: <code> ..."
      const m = /^upload failed: (\d{3})/.exec(msg);
      if (m) {
        const code = parseInt(m[1], 10);
        if (code >= 400 && code < 500) throw err;
      }
      if (attempt < backoffs.length) {
        console.log(
          `[uploadWithRetry] retry attempt=${attempt} file=${fileName} reason=${msg.slice(0, 120).replace(/\n/g, " ")}`
        );
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("uploadWithRetry: unreachable");
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/lyzr.test.ts`
Expected: all lyzr tests pass (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/lyzr.ts lib/__tests__/lyzr.test.ts && git commit -m "$(cat <<'EOF'
feat(lyzr): uploadWithRetry with 5xx/network retries, no 4xx retry

Two retries after the initial attempt by default (backoffs [5s, 15s]).
Used by the chunked-path orchestrator to recover from transient
Lyzr-edge errors without failing the whole job for one bad chunk.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Verification gate — multi-asset Classification output shape

**Files:** none modified yet. This is a manual-but-required gate. Result determines whether Task 9 implements Path A (trust the agent) or Path B (orchestrator-side dedup).

- [ ] **Step 1: Adapt `/tmp/multiasset_v2.sh` to dump the full Classification output (not just Y/N)**

Copy the script and change the `MSG` to invoke the agent's normal classification template:

```bash
cp /tmp/multiasset_v2.sh /tmp/verify_output_shape.sh
```

Edit `/tmp/verify_output_shape.sh` to set:

```bash
MSG="Classify the uploaded document(s)."
```

(The agent's normal Classification prompt — same as production.)

- [ ] **Step 2: Re-use existing assets if still parsed, otherwise re-upload**

Two existing chunk assets from the prior session live at `/tmp/ma2_p1_asset.txt` and `/tmp/ma2_p2_asset.txt` (the 4-page Scene_3 splits). Verify they're still alive:

```bash
KEY="sk-default-tLD7T1vnpUVrADnSExaTeZ3FZT8sd1G4"
for f in /tmp/ma2_p1_asset.txt /tmp/ma2_p2_asset.txt; do
  AID=$(cat $f)
  echo "asset $AID: $(curl -s -H "x-api-key: $KEY" "https://agent-prod.studio.lyzr.ai/v3/assets/$AID" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if 'asset_id' in d else 'lost')")"
done
```

If either is "lost," re-run `bash /tmp/multiasset_v2.sh` to recreate them.

- [ ] **Step 3: Call Classification with multi-asset payload, capture full output**

Run the modified script: `bash /tmp/verify_output_shape.sh`
The "both_fwd" output (`/tmp/ma2_both_fwd.txt`) will contain the full Classification report for `assets: [chunk1, chunk2]`.

- [ ] **Step 4: Inspect the output JSON in `/tmp/ma2_both_fwd.txt`**

Look for the trailing ```json fenced block. Check three things:

1. **`page_count` field:** does it equal 8 (original Scene_3 total) or 4+4 = 8 from concatenation, vs incorrect (like 4 or 12)? PASS if 8.
2. **`pages[]` array:** does each logical page (1, 2, 3, 4, 5, 6, 7, 8) appear exactly once? PASS if yes, FAIL if any page is duplicated (e.g., pages 1-4 listed twice because they appeared in both chunks via overlap — but with chunk_part1 = 1-4 and chunk_part2 = 5-8 there's no overlap in this specific test, so duplicates would indicate something else).
3. **`distinct_document_types` and per-page `document_type`:** do they match the canonical Scene_3 classification (Thai National ID p1, GSB Passbook p2, IPD Receipt p3, Itemised Bill p4, Medical Certificate p5, Itemised Bill pp6-7, IPD Receipt p8)? Substantive PASS.

- [ ] **Step 5: Make the Path A/B decision**

**If checks 1, 2, 3 all PASS → Path A** (trust the agent — no dedup code needed in Task 9). Note the verdict and move on.

**If any check FAILS → Path B** (orchestrator-side dedup required in Task 9). Document which check failed in `/tmp/path_decision.txt`. Add a follow-up task immediately after Task 9 that implements dedup logic.

- [ ] **Step 6: Record the decision**

Write `/tmp/path_decision.txt` with one line: `PATH_A` or `PATH_B` plus a one-line reason. The next task reads this.

No commit for this task — it's a verification gate.

---

## Task 9: Wire chunked path into `lib/orchestrator.ts`

**Files:**
- Modify: `lib/orchestrator.ts`
- Modify: `lib/__tests__/orchestrator.test.ts`

This task assumes Path A from Task 8. If Path B is needed, follow Task 9b after this.

- [ ] **Step 1: Write a failing integration test for the chunked path**

The existing `orchestrator.test.ts` mocks `uploadToLyzr` and `callAgent`. Add a similar mock for `splitPdfWithOverlap` / `countPages` / `mapWithConcurrency` (or use real implementations with synthetic small PDFs — the latter is cleaner).

Append to `lib/__tests__/orchestrator.test.ts`:

```typescript
import { processPdf } from "../orchestrator";
import { createJob, getJob, __resetJobStoreForTests } from "../jobs";

describe("processPdf chunked path", () => {
  beforeEach(() => {
    __resetJobStoreForTests();
    vi.restoreAllMocks();
  });

  it("chunks a >10-page PDF, uploads each, calls agents with full asset_ids array", async () => {
    // Build a synthetic 15-page PDF (will be split into 2 chunks: pages 1-10, 9-15)
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < 15; i++) doc.addPage([612, 792]);
    const pdfBytes = Buffer.from(await doc.save());

    // Mock upload to return per-chunk asset ids
    const uploadCalls: string[] = [];
    const { uploadToLyzr } = await import("../lyzr");
    vi.spyOn(await import("../lyzr"), "uploadToLyzr").mockImplementation(async (_env, buf, name) => {
      const id = `asset-${uploadCalls.length}`;
      uploadCalls.push(name);
      return id;
    });

    // Mock callAgent to capture asset_ids
    const seenAssetIds: string[][] = [];
    vi.spyOn(await import("../lyzr"), "callAgent").mockImplementation(async (_env, args) => {
      seenAssetIds.push(args.asset_ids);
      return `mock-response-for-${args.agent_id}`;
    });

    const env = { lyzrApiKey: "sk", lyzrBaseUrl: "https://lyzr.example" };
    const id = createJob("big.pdf");

    await processPdf(env, id, pdfBytes);

    const job = getJob(id)!;
    expect(job.status).toBe("completed");
    expect(job.stages.upload.status).toBe("done");
    expect(job.stages.upload.asset_ids).toEqual(["asset-0", "asset-1"]);
    expect(job.stages.upload.chunks).toHaveLength(2);
    expect(job.stages.upload.chunks?.[0].page_range).toEqual([1, 10]);
    expect(job.stages.upload.chunks?.[1].page_range).toEqual([9, 15]);
    // Each of 3 agents got both asset_ids
    expect(seenAssetIds).toHaveLength(3);
    seenAssetIds.forEach((ids) => expect(ids).toEqual(["asset-0", "asset-1"]));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npx vitest run lib/__tests__/orchestrator.test.ts -t "chunked path"`
Expected: FAIL — current `processPdf` does single upload, returns single asset_id.

- [ ] **Step 3: Update `lib/orchestrator.ts` to add the chunked path**

Replace the entire `processPdf` function in `lib/orchestrator.ts` with:

```typescript
import { randomUUID } from "node:crypto";
import { uploadToLyzr, uploadWithRetry, callAgent } from "./lyzr";
import { setJobStatus, setResult, updateStage, updateChunk, getJob } from "./jobs";
import type { Env } from "./env";
import { AGENTS } from "./types";
import { countPages, splitPdfWithOverlap, mapWithConcurrency } from "./pdf";

const CHUNK_SIZE = 10;
const CHUNK_OVERLAP = 2;
const UPLOAD_CONCURRENCY = 5;

export async function processPdf(env: Env, jobId: string, pdfBytes: Buffer): Promise<void> {
  setJobStatus(jobId, "running");
  const job = getJob(jobId);
  const fileName = job?.file_name ?? "upload.pdf";

  // Stage 1: Upload — fast path or chunked path.
  let assetIds: string[];
  try {
    updateStage(jobId, "upload", { status: "running", started_at: Date.now() });

    const pageCount = await countPages(pdfBytes);

    if (pageCount <= CHUNK_SIZE) {
      // FAST PATH (≤10p) — preserves today's validated behavior, no pdf-lib round-trip.
      const assetId = await uploadToLyzr(env, pdfBytes, fileName);
      assetIds = [assetId];
      updateStage(jobId, "upload", {
        status: "done",
        ended_at: Date.now(),
        asset_id: assetId,
        asset_ids: [assetId],
      });
    } else {
      // CHUNKED PATH (>10p)
      const chunks = await splitPdfWithOverlap(pdfBytes, CHUNK_SIZE, CHUNK_OVERLAP);
      // Initialize per-chunk state up-front so the UI can show all chunks as "pending"
      chunks.forEach((chunk, idx) =>
        updateChunk(jobId, idx, { idx, status: "pending", page_range: chunk.pageRange })
      );

      assetIds = await mapWithConcurrency(chunks, UPLOAD_CONCURRENCY, async (chunk, idx) => {
        updateChunk(jobId, idx, { status: "running" });
        const chunkStart = Date.now();
        try {
          const aid = await uploadWithRetry(env, chunk.buffer, `${fileName}-chunk${idx + 1}`);
          updateChunk(jobId, idx, { status: "done", asset_id: aid, elapsed_ms: Date.now() - chunkStart });
          return aid;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateChunk(jobId, idx, { status: "failed", error: message, elapsed_ms: Date.now() - chunkStart });
          throw err;
        }
      });

      updateStage(jobId, "upload", {
        status: "done",
        ended_at: Date.now(),
        asset_ids: assetIds,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateStage(jobId, "upload", { status: "failed", ended_at: Date.now(), error: message });
    setJobStatus(jobId, "failed", { stage: "upload", message });
    return;
  }

  // Stage 2: Three agents IN PARALLEL via Promise.allSettled, all reading the same asset_ids array
  const agentTasks = AGENTS.map(async (agent) => {
    updateStage(jobId, agent.label, { status: "running", started_at: Date.now() });
    try {
      const raw = await callAgent(env, {
        agent_id: agent.agent_id,
        user_id: agent.user_id,
        session_id: randomUUID(),
        asset_ids: assetIds,
        message: agent.message,
      });
      setResult(jobId, agent.label, { raw, agent: agent.label });
      updateStage(jobId, agent.label, { status: "done", ended_at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateStage(jobId, agent.label, {
        status: "failed",
        ended_at: Date.now(),
        error: message,
      });
    }
  });

  await Promise.allSettled(agentTasks);
  setJobStatus(jobId, "completed");
}
```

- [ ] **Step 4: Run all tests, verify they pass**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm test`
Expected: all tests pass — existing tests (which use small PDFs / mocked single-asset behavior) plus the new chunked-path test.

- [ ] **Step 5: Verify build passes**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add lib/orchestrator.ts lib/__tests__/orchestrator.test.ts && git commit -m "$(cat <<'EOF'
feat(orchestrator): chunked path for >10-page PDFs

PDFs >10 pages are split with 2-page overlap into ≤10-page chunks,
uploaded 5-at-a-time via uploadWithRetry, and fed to all 3 agents as
assets: [c1, c2, ...]. Per-chunk progress recorded via updateChunk.
Fast path for ≤10p PDFs preserves today's validated behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9b: ONLY IF Task 8 returned `PATH_B` — orchestrator-side dedup

**Skip this task if `/tmp/path_decision.txt` says `PATH_A`.**

**Files:**
- Modify: `lib/orchestrator.ts`
- Create: `lib/__tests__/orchestrator-dedup.test.ts`

If you got here, the agent emitted duplicate page entries when given overlapping chunks. The dedup logic groups Classification entries by `(page_number, document_id, HN)` and keeps the highest-confidence one. Implementation details depend on which exact failure mode was observed — write the dedup against the actual duplicate-entry shape from `/tmp/ma2_both_fwd.txt`.

This task is intentionally light on prescriptive code because the exact JSON shape of duplicates is unknown. Add tests using captured fixtures (`/tmp/ma2_both_fwd.txt`) as input, target: dedup returns one entry per logical page.

Commit when complete.

---

## Task 10: UI — per-chunk progress strip

**Files:**
- Modify: `app/jobs/[id]/page.tsx`
- Create: `components/chunk-strip.tsx`

- [ ] **Step 1: Create `components/chunk-strip.tsx`**

```tsx
import type { ChunkState } from "@/lib/types";

interface Props {
  chunks: ChunkState[] | undefined;
}

export function ChunkStrip({ chunks }: Props) {
  if (!chunks || chunks.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="text-xs text-gray-500 mb-1">
        Upload progress ({chunks.filter((c) => c.status === "done").length}/{chunks.length} chunks)
      </div>
      <div className="flex gap-1 flex-wrap">
        {chunks.map((c) => (
          <div
            key={c.idx}
            title={`pages ${c.page_range[0]}-${c.page_range[1]} · ${c.status}${c.error ? ` · ${c.error}` : ""}`}
            className={`px-2 py-1 text-xs rounded border ${
              c.status === "done"
                ? "bg-green-50 border-green-300 text-green-800"
                : c.status === "failed"
                ? "bg-red-50 border-red-300 text-red-800"
                : c.status === "running"
                ? "bg-amber-50 border-amber-300 text-amber-800"
                : "bg-gray-50 border-gray-300 text-gray-600"
            }`}
          >
            {c.page_range[0]}–{c.page_range[1]}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render `<ChunkStrip />` in the job-detail page below the stage stepper**

Find `app/jobs/[id]/page.tsx` and locate where `<StageStepper job={job} />` is rendered. Add the chunk strip immediately below it, scoped to when `job.stages.upload.chunks` exists:

```tsx
import { ChunkStrip } from "@/components/chunk-strip";

// ... in the JSX where the upload stage is rendered:
<StageStepper job={job} />
<ChunkStrip chunks={job.stages.upload.chunks} />
```

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run build`
Expected: success.

- [ ] **Step 4: Smoke-test the dev server**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run dev`
Open `http://localhost:3000`. Upload a small PDF (Scene_3, ≤10p) → no chunk strip should render. Upload Scene_4 (49p, scanned) → 6 chunks should appear and progress green as uploads complete.

Stop the dev server (Ctrl-C) when done.

- [ ] **Step 5: Commit**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git add app/jobs/\[id\]/page.tsx components/chunk-strip.tsx && git commit -m "$(cat <<'EOF'
feat(ui): per-chunk upload progress strip

Renders only when stage.upload.chunks is populated (chunked path).
Color-coded states (pending/running/done/failed) with page-range labels
and hover-title showing error detail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: End-to-end verification — Scene_3, Scene_4, Scene_5

**Files:** none modified. This is the final verification gate before deployment.

- [ ] **Step 1: Regression check on Scene_3 (fast path)**

Run: `cd /Users/shikhar-agrawal/thai-life-demo-ui && npm run dev`
In a browser, upload `/Users/shikhar-agrawal/thai-life-demo-ui/Scene_3.pdf`. Wait for job to complete.

Verify:
- Stage stepper shows upload → classification → extraction → summarisation, all green.
- No chunk strip visible (Scene_3 ≤10p uses fast path).
- Classification output reports `is_bundle: true, page_count: 8` and identifies all 8 documents.
- Summarisation output references Mr. Kittipong Sriwatthana with correct ID 3-2249-12378-26-0.

If anything differs from prior validated Scene_3 behavior, STOP and investigate.

- [ ] **Step 2: Multi-page coverage on Scene_4 (chunked path)**

Upload `~/Downloads/Thai Life - PoC File/Scene 4_HTEx.pdf` (49 pages, scanned).

Verify:
- Chunk strip appears with 6 chunks: [1-10], [9-18], [17-26], [25-34], [33-42], [41-49].
- All chunks progress to green eventually.
- Wall time for upload + agent runs should be roughly 5-10 minutes.
- Classification output reports multi-page coverage (multiple pages with real document types), not `page_count: 1`.
- Summarisation does not contain hallucinated Scene_3 content (no "Kittipong" or "Thonburi Bamrungmuang" if Scene_4 isn't actually about them).

If Scene_4 still produces fabricated personas with page_count: 1, the parser bug isn't fixed by chunking — STOP and reassess.

- [ ] **Step 3: Multi-page coverage on Scene_5 (chunked path, large)**

Upload `~/Downloads/Thai Life - PoC File/Scene 5_Respiratory.pdf` (169 pages, scanned).

Verify:
- Chunk strip appears with 21 chunks.
- All chunks complete eventually.
- Wall time roughly 12-15 minutes.
- Classification output identifies the pediatric patient (Korawit Sansongsak / Ekachai Hospital / ด.ช.) somewhere in the bundle — confirming page-1 content reaches the agent AND additional pages from chunks 2-21 are now visible.

- [ ] **Step 4: Failure-mode smoke test (optional but recommended)**

Temporarily edit `lib/lyzr.ts::uploadToLyzr` to throw a fake 503 on every 3rd call (`if (Math.random() < 0.33) throw new Error("upload failed: 503 simulated")`). Re-run Scene_4. Verify the chunk strip shows retries and the job completes. Restore the original code afterwards.

(Don't commit this experimental code — it's only for the smoke test.)

- [ ] **Step 5: Push to origin**

If all three verifications pass and you're happy with the result:

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui && git push origin main
```

Render will auto-deploy from main if configured to do so. Watch the build logs and re-test against the production URL once it's live.

- [ ] **Step 6: Update the session brief**

Append to `docs/session-brief-2026-05-13.md` (or write a new `docs/session-brief-YYYY-MM-DD.md` for the next session) a short summary of what was shipped, the verification outcomes, and any new known limitations discovered.

Commit the doc update.

---

## Self-review

After writing all tasks above, this plan was reviewed against the spec:

- ✅ Spec coverage: every section of the spec maps to a task. Multi-asset behavior was the spec's biggest open item — Task 8 is a hard gate that verifies the assumption before Task 9 commits to a design.
- ✅ Placeholder scan: no "TBD" / "TODO" / "implement later" markers. Path B (Task 9b) is intentionally lighter on code because its exact shape depends on Task 8's outcome — and that's documented.
- ✅ Type consistency: `ChunkState` defined in Task 4, used the same way in Tasks 5, 9, 10. `asset_ids` field naming consistent. `CallAgentArgs.asset_ids: string[]` consistent across Task 6, 9.
- ✅ Bite-sized: each task is one feature with TDD steps (write test → verify fail → implement → verify pass → commit).
- ✅ DRY/YAGNI: no premature abstractions. `pdf.ts` collects PDF + concurrency utilities together because they're used together in the chunked path. UI component is its own file.

Open caveats:
- Task 8's Path A/B decision determines whether Task 9b is run. The plan executor should check `/tmp/path_decision.txt` before deciding.
- Task 11 step 4 (failure-mode smoke test) is optional. It's the cheapest way to verify retry semantics end-to-end against the real Lyzr endpoint, but can be skipped if time is tight.
- Concurrency for uploads (`UPLOAD_CONCURRENCY = 5`) is hardcoded per the design. Confirmable later if Parshva gives a real safe number.
