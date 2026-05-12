# Thai Life PoC — Agent Architecture & Implementation

> Architecture-focused handoff brief: how the three agents work and how they're wired together in the demo. Skip the broader project context — see the separate session handoff for stakeholders/business.

## TL;DR

Three Lyzr agents process Thai insurance document bundles in parallel:

```
PDF upload
   │
   ▼ POST /v3/assets/upload?<VLM query params>     (single Lyzr call)
   │
   ▼ produces VLM-parsed asset_id (multi-page-readable)
   │
   ├─► Classification  (vision-based, per-page doc-type table)        ┐
   ├─► Extraction      (per-field with confidence + structured JSON)  │ Promise.allSettled
   └─► Summarisation   (bilingual six-section underwriter brief)      ┘
```

All three agents run **concurrently** against the same VLM asset. Each reads the document independently — no inter-agent context passing.

---

## The agents (Lyzr Studio definitions)

All three are configured identically at the platform level:

| Property | Value |
|---|---|
| Provider | `Anthropic` |
| Model | `anthropic/claude-sonnet-4-5` |
| Temperature | `0.1` |
| Top-p | `1` |
| Tools | `[]` (no function-calling, no RAG) |
| Skills | `[]` |
| Response format | `text` (markdown body + appended JSON code block) |
| Max iterations | `25` (effectively single-turn) |

### Agent IDs & user_ids

| Agent | agent_id | user_id (load-bearing — don't change) |
|---|---|---|
| Classification | `69f377c87045b738bc045749` | `1af38f4d-145c-4c47-9f78-736aa203e485` |
| Extraction | `69f37dc6577450ec8542003b` | `80507ff4-6a59-436b-babf-6de0fdf93cba` |
| Summarisation | `69f380b2180bca7eef235036` | `fea3f4d7-90ef-4495-865c-be1a52628799` |

The `user_id`s are tied to existing sessions in Lyzr; don't substitute. `session_id` is freshly UUID-generated per call.

### What each agent does, functionally

**Classification** — Senior Document Triage Specialist. Receives the asset images and produces:
- A bundle summary (total pages, distinct doc types, overall confidence, review status)
- A per-page table classifying each page into one of 7 taxonomy categories (National ID/Passport/etc., House Reg, Medical Cert, Medical History, Lab Results, Application, Other)
- Per-page confidence scoring across 5 weighted parameters (header match 0.30, structural layout 0.25, key identifier 0.20, visual quality 0.15, language consistency 0.10)
- Reasoning citations per page
- Appended structured JSON

Has `features: [{type: "SRS", config: {modules: {reflection: true, bias: false}}}]` — the only agent with a reflection pass enabled.

**Extraction** — Senior Data Extraction Specialist. Receives same asset, produces:
- Per-document field extraction (ID No., names in Thai+English, DOB, addresses, hospital/HN, treatment dates, diagnoses, ICD-10, medications, line-item bills, etc.)
- Per-field confidence with 5-parameter scoring methodology (text legibility, field isolation, format validation, cross-validation, content certainty)
- Buddhist Era → Gregorian date conversion (subtract 543)
- MRZ parsing for passports
- Low-confidence-field callouts with concern descriptions
- Output ≈ 50-65 KB structured JSON + markdown narrative

**Summarisation** — Senior Underwriting Assistant. Receives same asset (not the other agents' outputs), produces a six-section underwriter brief:
1. Overview of applicant + documents received
2. Key diseases and diagnoses (grouped by hospital, acute vs chronic)
3. Risk profile and ongoing treatment assessment
4. Severity-sorted disease list (Critical / Significant / Routine)
5. Analytical risk commentary (identity verification, name-spelling variants, documentation gaps)
6. Suggested considerations for the underwriter (advisory only)

Bilingual Thai + English throughout. Each narrative section is written in Thai first, then `*[English: ...]*` translation follows.

Mandatory closing line (italicised, after Section 6, before JSON block):
*"These are advisory observations only. Final underwriting decisions rest with the human underwriter."*

Has `features: []` — no SRS/reflection (unlike Classification).

---

## How agents receive input — load-bearing platform constraint

**Lyzr agents read documents ONLY from the `assets: ["<id>"]` array in the request body.** The platform server-side:

1. Looks up the asset_id
2. Fetches parsed pages from Lyzr's internal store
3. Converts to image content blocks
4. Attaches them to the LLM prompt

**No other field triggers document attachment.** Fields like `apicall_output`, `a2a_output`, or anything in the user `message` are treated as plain text. The agent has no tools to fetch a PDF given an id; only the platform's `assets[]` resolver does that.

**Implication:** to give an agent a multi-page bundle, the asset_id in `assets[]` must have been VLM-parsed at upload time. Studio's File Attachments UI uploads default to *non-VLM*, which means agents only see page 1.

### How VLM-parsing actually happens

The upload endpoint accepts parser config as **URL query string params**, NOT as a `parse_config` form field (the form field shape silently no-ops despite returning 200 with an asset_id). Canonical Parshva-confirmed shape, baked into `lib/lyzr.ts`:

```typescript
const VLM_QUERY_PARAMS = new URLSearchParams({
  parser_provider: "lyzr_parse",
  parsing_mode: "full",
  enable_vlm: "true",
  vlm_provider: "openai",
  vlm_model: "gpt-4o",
  extract_tables: "true",
  describe_images: "true",
}).toString();

// usage:
fetch(`${env.lyzrBaseUrl}/v3/assets/upload?${VLM_QUERY_PARAMS}`, {
  method: "POST",
  headers: { "x-api-key": env.lyzrApiKey },
  body: multipartFormDataWithPdfFile,
});
```

**Do not change this shape.** It's the result of a 4-hour debugging session with Parshva (the assets/upload endpoint owner). Verified by Classification reporting `is_bundle: true, page_count: 8` on the test bundle.

---

## The orchestrator (`lib/orchestrator.ts`)

```typescript
export async function processPdf(env, jobId, pdfBytes): Promise<void> {
  // Stage 1: Upload to Lyzr with VLM query string baked in → single hop
  setJobStatus(jobId, "running");
  const assetId = await uploadToLyzr(env, pdfBytes, fileName);
  updateStage(jobId, "upload", { status: "done", asset_id: assetId });

  // Stage 2: Fire all three agents in parallel, NOT chained
  const agentTasks = AGENTS.map(async (agent) => {
    updateStage(jobId, agent.label, { status: "running", started_at: Date.now() });
    try {
      const raw = await callAgent(env, {
        agent_id: agent.agent_id,
        user_id: agent.user_id,
        session_id: randomUUID(),  // fresh session per call
        asset_id: assetId,         // same VLM asset to all three
        message: agent.message,
      });
      setResult(jobId, agent.label, { raw, agent: agent.label });
      updateStage(jobId, agent.label, { status: "done", ended_at: Date.now() });
    } catch (err) {
      updateStage(jobId, agent.label, { status: "failed", error: String(err) });
    }
  });

  await Promise.allSettled(agentTasks);  // partial failure tolerated
  setJobStatus(jobId, "completed");
}
```

### Why parallel, not serial

The original LAO workflow design chained agents via A2A handoffs:
`Classification → A2A → Extraction → A2A → Summarisation`

In that design, each agent would receive the previous agent's text output in its prompt, building up context. But two facts kill that design:

1. **LAO's A2A handoff has a known platform bug** (`"Error with a2a"` returned mid-chain). It doesn't actually pass agent outputs as templated text reliably.
2. **The agents don't need each other's text.** Each agent is configured to read the asset directly from `assets[]` and produce its full report from the document images. None of the three agents' prompts assume input from the others.

Parallel design:
- Drops total wall-clock from ~26 min sequential to ~6-15 min (bounded by slowest agent — Summarisation)
- Tolerates per-agent failure via `Promise.allSettled` — if Summary 5xx's, Classification and Extraction outputs still surface to the user
- Verified to produce equivalent quality on `Scene_3.pdf` (8-page bundle)

### `callAgent` retry behaviour (`lib/lyzr.ts`)

Lyzr's edge router occasionally returns 5xx mid-response on long generations (Summarisation produces ~25KB of bilingual output and is the most affected). The agent helper retries:

- **5xx response** → 2 retries with [5s, 15s] backoffs (3 attempts total)
- **4xx response** → no retry, surface error
- **402 credits exhausted** → no retry, surface error immediately
- **Network error / timeout** → no retry (probably hung, don't compound wait)

Uses `undici.Agent` directly (not Node's default fetch) with `headersTimeout: 20min` and `bodyTimeout: 20min` because Lyzr inference legitimately takes 4-15 min per call and Node's default 5-min `headersTimeout` would kill long requests otherwise.

Logs each retry to stdout:
`[callAgent] retry attempt=0 agent=69f380b2... status=502 elapsed=600s detail=...`

---

## Latency profile (real-world observed)

Per-agent on an 8-page bundle:

| Agent | Typical | Slow tail | Cause of variance |
|---|---|---|---|
| Classification | 130-240s | rare | Mostly stable |
| Extraction | 310-640s | up to 11 min | Output size (~60KB structured JSON) |
| Summarisation | 340-930s | up to 16 min | Bilingual + 6 sections + retry path |

Total wall-clock = bounded by slowest agent ≈ 6-15 min normal, 20-25 min on retry path.

Why Summary is the variance source:
- ~25KB bilingual structured output
- Sonnet 4.5 generates carefully at temp 0.1
- Anthropic API queueing under load
- Lyzr edge router occasionally times out on long streams → triggers retry, which doubles the wait

---

## What lives where in the repo

| File | Purpose |
|---|---|
| `lib/types.ts` | `AGENTS` config array — single source of truth for agent IDs, user_ids, messages |
| `lib/env.ts` | env loading (LYZR_API_KEY, LYZR_BASE_URL) — server-side only |
| `lib/lyzr.ts` | `uploadToLyzr` (with VLM_QUERY_PARAMS) + `callAgent` (with retry + undici long-timeout) |
| `lib/orchestrator.ts` | `processPdf` — the pipeline |
| `lib/jobs.ts` | in-memory job state (Map<jobId, JobState>) |
| `app/api/jobs/route.ts` | `POST /api/jobs` — receives PDF, kicks off pipeline async |
| `app/api/jobs/[id]/route.ts` | `GET /api/jobs/:id` — frontend polls every 3s |
| `app/jobs/[id]/page.tsx` | UI status page with stepper + result rendering |
| `components/stage-stepper.tsx` | 4-stage stepper (Upload+VLM Parse / Classify / Extract / Summarise) |
| `components/result-section.tsx` | markdown renderer with copy-to-clipboard |

Stack: Next.js 14 App Router on Render Web Service (long-running Node process — in-memory state survives between requests but not between deploys).

---

## Hard constraints (load-bearing — don't undo)

1. **Don't modify the three agent prompts in Lyzr Studio.** Validated and approved by stakeholders.
2. **Don't change the VLM_QUERY_PARAMS shape.** Form-field `parse_config={...}` silently no-ops; query string is the only working shape (Parshva-confirmed).
3. **Don't proxy `LYZR_API_KEY` through the frontend.** All `/v3/*` calls server-side.
4. **Don't switch from `gpt-4o` for VLM** or from `claude-sonnet-4-5` for the agents.
5. **Don't try to pass agent outputs between agents as text.** The LAO A2A bug breaks it, and each agent is configured to read the asset directly anyway.
6. **Don't add `specific_pages`, `start_page`, or `end_page`** to VLM_QUERY_PARAMS — tested, doesn't help, and `specific_pages` silently filters.
7. **Don't reintroduce the standalone wrapper service** (`vlm-reparse-wrapper.onrender.com`). It existed to do the upload-with-VLM step before the demo UI was built; now redundant. Deleted from the critical path in commit `10330b8`. Still deployed but unused.

---

## Things another Claude session might be tempted to "fix" but shouldn't

- **A2A "Error with a2a"** in LAO workflow context — pre-existing Lyzr platform bug, owned by Sahil. Not in our critical path (we don't use LAO).
- **`is_queryable: false` on a wrapper-produced VLM asset** — this field is misleading; NOT a "non-VLM" marker. Even verified-working VLM assets show `is_queryable: false`. Only test for VLM parsing by feeding the asset to Classification and checking `Total Pages: N` matches the real page count.
- **Studio File Attachments UI** uploading non-VLM assets — known; the workaround is to never use Studio UI for the production path (our orchestrator handles upload-with-VLM directly).

---

## Sample agent invocation (end-to-end curl flow)

For reproducing or testing a specific agent in isolation:

```bash
# Step 1: Upload with VLM
curl -X POST "https://agent-prod.studio.lyzr.ai/v3/assets/upload?parser_provider=lyzr_parse&parsing_mode=full&enable_vlm=true&vlm_provider=openai&vlm_model=gpt-4o&extract_tables=true&describe_images=true" \
  -H "x-api-key: $LYZR_API_KEY" \
  -F "files=@Scene_3.pdf"
# → {"results":[{"success":true,"asset_id":"<NEW_VLM_ID>",...}]}

# Step 2: Hit Classification
curl -X POST "https://agent-prod.studio.lyzr.ai/v3/inference/chat/" \
  -H "x-api-key: $LYZR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "1af38f4d-145c-4c47-9f78-736aa203e485",
    "agent_id": "69f377c87045b738bc045749",
    "session_id": "test-classification",
    "message": "Classify the uploaded document(s).",
    "assets": ["<NEW_VLM_ID>"]
  }'
# → {"response": "📋 Classification Report — Document Bundle\n\nBundle Summary\n- Total Pages: 8\n..."}
# (takes 130-240s)
```

Replace `agent_id` and `user_id` to test Extraction or Summarisation. Reuse the same `<NEW_VLM_ID>` across all three — that's the whole point.

---

**End of architecture brief.**
