# Thai Life Demo UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Next.js app + thin backend that takes a PDF upload, runs it through the existing wrapper service + three Lyzr agents in parallel, and renders the underwriter brief. Replaces the LAO workflow path entirely.

**Architecture:** Single Next.js (App Router) repo. Backend = Next.js API routes running on Render Web Service (`next start`, long-running Node process — no Vercel timeouts). Frontend polls `/api/jobs/:id` every 3s for status. State = in-memory `Map<jobId, JobState>` in the Node process. Agents fire in parallel via `Promise.allSettled`.

**Tech Stack:** Next.js 14+ App Router, TypeScript, Tailwind, shadcn/ui, react-markdown + remark-gfm, vitest for backend tests, Render for deploy.

---

## File Structure

```
thai-life-demo-ui/
├── BRIEF.md                          # Source-of-truth context
├── README.md                         # Setup + deploy
├── .env.local.example                # LYZR_API_KEY, WRAPPER_KEY
├── package.json
├── app/
│   ├── page.tsx                      # Landing / upload form
│   ├── jobs/[id]/page.tsx            # Status + results page
│   ├── api/
│   │   ├── jobs/route.ts             # POST /api/jobs (upload)
│   │   └── jobs/[id]/route.ts        # GET /api/jobs/:id (poll)
│   └── layout.tsx
├── lib/
│   ├── lyzr.ts                       # uploadToLyzr, callAgent
│   ├── wrapper.ts                    # callWrapper
│   ├── orchestrator.ts               # processPdf pipeline
│   ├── jobs.ts                       # in-memory job store
│   ├── types.ts                      # JobState, AgentResult, etc.
│   └── env.ts                        # zod-validated env loader
├── lib/__tests__/                    # vitest specs
│   ├── lyzr.test.ts
│   ├── wrapper.test.ts
│   ├── orchestrator.test.ts
│   └── jobs.test.ts
├── components/
│   ├── upload-form.tsx
│   ├── stage-stepper.tsx
│   └── result-section.tsx
└── docs/
    └── superpowers/plans/2026-05-07-thai-life-demo-ui.md
```

---

## Hard Constraints (carry from BRIEF.md)

- Do NOT modify the three agent prompts in Lyzr Studio.
- Do NOT proxy LYZR_API_KEY through the frontend.
- Do NOT add LAO workflow nodes.
- Do NOT commit secrets.
- All Lyzr API calls happen in API route handlers, never in client components.

---

## Task 1: Scaffold Next.js + dependencies

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `app/layout.tsx`, `app/page.tsx` (boilerplate)
- Create: `.env.local.example`, `.gitignore`
- Init: `git init`

- [ ] **Step 1: Run create-next-app non-interactively into the existing dir**

```bash
cd /Users/shikhar-agrawal/thai-life-demo-ui
npx create-next-app@latest . --typescript --tailwind --app --eslint --no-src-dir --import-alias "@/*" --use-npm --yes
```

Expected: Next.js scaffold lands. Some files (BRIEF.md, docs/) already there — `--force` may be needed if create-next-app refuses non-empty dir. If so, retry with `--force`.

- [ ] **Step 2: Install runtime + dev deps**

```bash
npm install zod uuid react-markdown remark-gfm
npm install -D @types/uuid vitest @vitest/ui
```

- [ ] **Step 3: Add shadcn/ui (defaults)**

```bash
npx shadcn@latest init -y
```

Pick defaults: New York style, slate color, CSS variables.

- [ ] **Step 4: Add `.env.local.example`**

```
LYZR_API_KEY=sk-default-replace-with-real-key
WRAPPER_KEY=replace-with-wrapper-secret
WRAPPER_URL=https://vlm-reparse-wrapper.onrender.com
LYZR_BASE_URL=https://agent-prod.studio.lyzr.ai
```

- [ ] **Step 5: Add vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Verify dev server boots and tests run**

```bash
npm run dev    # ctrl-C after seeing "Ready in XXXms"
npm test       # expect "no test files found" — ok at this stage
```

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: scaffold Next.js + deps + vitest"
```

---

## Task 2: Env loader + types (TDD)

**Files:**
- Create: `lib/env.ts`, `lib/types.ts`
- Test: `lib/__tests__/env.test.ts`

- [ ] **Step 1: Write failing test for env loader**

`lib/__tests__/env.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv } from "../env";

describe("loadEnv", () => {
  beforeEach(() => {
    delete process.env.LYZR_API_KEY;
    delete process.env.WRAPPER_KEY;
  });

  it("returns config when all vars set", () => {
    process.env.LYZR_API_KEY = "sk-test";
    process.env.WRAPPER_KEY = "wk-test";
    process.env.WRAPPER_URL = "https://x";
    process.env.LYZR_BASE_URL = "https://y";
    const env = loadEnv();
    expect(env.lyzrApiKey).toBe("sk-test");
    expect(env.wrapperKey).toBe("wk-test");
  });

  it("throws when LYZR_API_KEY missing", () => {
    process.env.WRAPPER_KEY = "wk-test";
    expect(() => loadEnv()).toThrow(/LYZR_API_KEY/);
  });
});
```

Run: `npm test` → expect FAIL ("Cannot find module '../env'").

- [ ] **Step 2: Implement `lib/env.ts`**

```ts
import { z } from "zod";

const Schema = z.object({
  LYZR_API_KEY: z.string().min(1),
  WRAPPER_KEY: z.string().min(1),
  WRAPPER_URL: z.string().url().default("https://vlm-reparse-wrapper.onrender.com"),
  LYZR_BASE_URL: z.string().url().default("https://agent-prod.studio.lyzr.ai"),
});

export function loadEnv() {
  const parsed = Schema.parse(process.env);
  return {
    lyzrApiKey: parsed.LYZR_API_KEY,
    wrapperKey: parsed.WRAPPER_KEY,
    wrapperUrl: parsed.WRAPPER_URL,
    lyzrBaseUrl: parsed.LYZR_BASE_URL,
  };
}

export type Env = ReturnType<typeof loadEnv>;
```

Run tests → expect PASS.

- [ ] **Step 3: Add core types in `lib/types.ts`**

```ts
export type StageName = "upload" | "vlm_parse" | "classification" | "extraction" | "summarisation";
export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  asset_id?: string;
  error?: string;
}

export interface AgentResult {
  raw: string;
  agent: "classification" | "extraction" | "summarisation";
}

export interface JobState {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  file_name: string;
  created_at: number;
  stages: Record<StageName, StageState>;
  results: Partial<Record<"classification" | "extraction" | "summarisation", AgentResult>>;
  error?: { stage: StageName; message: string };
}

export interface AgentConfig {
  agent_id: string;
  user_id: string;
  message: string;
  label: "classification" | "extraction" | "summarisation";
}

export const AGENTS: AgentConfig[] = [
  { agent_id: "69f377c87045b738bc045749", user_id: "1af38f4d-145c-4c47-9f78-736aa203e485", message: "Classify the uploaded document(s).", label: "classification" },
  { agent_id: "69f37dc6577450ec8542003b", user_id: "80507ff4-6a59-436b-babf-6de0fdf93cba", message: "Extract all required fields from the bundle.", label: "extraction" },
  { agent_id: "69f380b2180bca7eef235036", user_id: "fea3f4d7-90ef-4495-865c-be1a52628799", message: "Produce a six-section underwriter brief.", label: "summarisation" },
];
```

- [ ] **Step 4: Commit**

```bash
git add lib/env.ts lib/types.ts lib/__tests__/env.test.ts vitest.config.ts package.json
git commit -m "feat: add env loader and core types"
```

---

## Task 3: Lyzr API helpers (TDD)

**Files:**
- Create: `lib/lyzr.ts`
- Test: `lib/__tests__/lyzr.test.ts`

- [ ] **Step 1: Write failing tests for `uploadToLyzr` and `callAgent`**

`lib/__tests__/lyzr.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadToLyzr, callAgent } from "../lyzr";

const env = {
  lyzrApiKey: "sk-test",
  wrapperKey: "wk-test",
  wrapperUrl: "https://wrapper.example",
  lyzrBaseUrl: "https://lyzr.example",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("uploadToLyzr", () => {
  it("posts multipart and returns asset_id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ success: true, asset_id: "abc-123" }] }),
    });
    const id = await uploadToLyzr(env, Buffer.from("%PDF"), "test.pdf");
    expect(id).toBe("abc-123");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://lyzr.example/v3/assets/upload");
    expect(call[1].headers["x-api-key"]).toBe("sk-test");
  });

  it("throws on non-200", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") });
    await expect(uploadToLyzr(env, Buffer.from("x"), "test.pdf")).rejects.toThrow(/upload/);
  });
});

describe("callAgent", () => {
  it("posts inference body and returns response text", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "report markdown" }),
    });
    const out = await callAgent(env, {
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "sess-1",
      asset_id: "asset-1",
      message: "Classify",
    });
    expect(out).toBe("report markdown");
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.assets).toEqual(["asset-1"]);
    expect(body.agent_id).toBe("agent-1");
  });

  it("throws on 402 credit exhaustion", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ detail: "Credits exhausted" }),
    });
    await expect(callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_id: "x", message: "x" })).rejects.toThrow(/credits/i);
  });
});
```

Run: `npm test` → expect FAIL (module missing).

- [ ] **Step 2: Implement `lib/lyzr.ts`**

```ts
import type { Env } from "./env";

export async function uploadToLyzr(env: Env, pdfBytes: Buffer, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([pdfBytes], { type: "application/pdf" }), fileName);
  const resp = await fetch(`${env.lyzrBaseUrl}/v3/assets/upload`, {
    method: "POST",
    headers: { "x-api-key": env.lyzrApiKey },
    body: form,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`upload failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const first = data?.results?.[0];
  if (!first?.success || !first.asset_id) {
    throw new Error(`upload returned no asset_id: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return first.asset_id as string;
}

export interface CallAgentArgs {
  agent_id: string;
  user_id: string;
  session_id: string;
  asset_id: string;
  message: string;
}

export async function callAgent(env: Env, args: CallAgentArgs): Promise<string> {
  const resp = await fetch(`${env.lyzrBaseUrl}/v3/inference/chat/`, {
    method: "POST",
    headers: { "x-api-key": env.lyzrApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: args.user_id,
      agent_id: args.agent_id,
      session_id: args.session_id,
      message: args.message,
      assets: [args.asset_id],
    }),
  });
  if (resp.status === 402) {
    const detail = await resp.json().catch(() => ({ detail: "" }));
    throw new Error(`credits exhausted: ${detail.detail ?? ""}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`agent ${args.agent_id} failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (typeof data?.response !== "string") {
    throw new Error(`agent returned no response field: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.response;
}
```

Run tests → expect PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/lyzr.ts lib/__tests__/lyzr.test.ts
git commit -m "feat: add Lyzr API helpers (uploadToLyzr, callAgent) with tests"
```

---

## Task 4: Wrapper helper (TDD)

**Files:**
- Create: `lib/wrapper.ts`
- Test: `lib/__tests__/wrapper.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callWrapper } from "../wrapper";

const env = {
  lyzrApiKey: "sk-test", wrapperKey: "wk-test",
  wrapperUrl: "https://wrapper.example", lyzrBaseUrl: "https://lyzr.example",
};

beforeEach(() => vi.restoreAllMocks());

describe("callWrapper", () => {
  it("posts source asset_id and returns vlm asset_id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ asset_id: "vlm-456", source_asset_id: "src-1", file_name: "x.pdf", file_size_bytes: 100, elapsed_ms: 9000 }),
    });
    const result = await callWrapper(env, "src-1");
    expect(result.asset_id).toBe("vlm-456");
    expect(result.elapsed_ms).toBe(9000);
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://wrapper.example/api/vlm-reparse");
    expect(call[1].headers["x-wrapper-key"]).toBe("wk-test");
  });

  it("throws on wrapper 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve("upstream") });
    await expect(callWrapper(env, "src-1")).rejects.toThrow(/wrapper/i);
  });
});
```

- [ ] **Step 2: Implement `lib/wrapper.ts`**

```ts
import type { Env } from "./env";

export interface WrapperResult {
  asset_id: string;
  source_asset_id: string;
  file_name: string;
  file_size_bytes: number;
  elapsed_ms: number;
}

export async function callWrapper(env: Env, sourceAssetId: string): Promise<WrapperResult> {
  const resp = await fetch(`${env.wrapperUrl}/api/vlm-reparse`, {
    method: "POST",
    headers: { "x-wrapper-key": env.wrapperKey, "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id: sourceAssetId }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`wrapper failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data?.asset_id) {
    throw new Error(`wrapper returned no asset_id: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as WrapperResult;
}
```

- [ ] **Step 3: Run tests + commit**

```bash
npm test
git add lib/wrapper.ts lib/__tests__/wrapper.test.ts
git commit -m "feat: add wrapper helper with tests"
```

---

## Task 5: Job store (TDD)

**Files:**
- Create: `lib/jobs.ts`
- Test: `lib/__tests__/jobs.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createJob, getJob, updateStage, setResult, setJobStatus } from "../jobs";

beforeEach(() => {
  // jobs module exports a reset for tests
  (global as any).__jobsReset?.();
});

describe("jobs store", () => {
  it("creates and retrieves jobs", () => {
    const id = createJob("test.pdf");
    const job = getJob(id);
    expect(job?.file_name).toBe("test.pdf");
    expect(job?.status).toBe("queued");
    expect(job?.stages.upload.status).toBe("pending");
  });

  it("updateStage transitions running->done with elapsed_ms", () => {
    const id = createJob("x.pdf");
    updateStage(id, "upload", { status: "running", started_at: Date.now() });
    updateStage(id, "upload", { status: "done", ended_at: Date.now() + 1000 });
    const job = getJob(id);
    expect(job?.stages.upload.status).toBe("done");
    expect(job?.stages.upload.elapsed_ms).toBeGreaterThanOrEqual(1000);
  });

  it("setResult attaches agent output", () => {
    const id = createJob("x.pdf");
    setResult(id, "classification", { raw: "report", agent: "classification" });
    expect(getJob(id)?.results.classification?.raw).toBe("report");
  });
});
```

- [ ] **Step 2: Implement `lib/jobs.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { JobState, StageName, StageState, AgentResult } from "./types";

const store = new Map<string, JobState>();

(globalThis as any).__jobsReset = () => store.clear();

export function createJob(file_name: string): string {
  const job_id = randomUUID();
  const now = Date.now();
  const initial: StageState = { status: "pending" };
  store.set(job_id, {
    job_id,
    file_name,
    created_at: now,
    status: "queued",
    stages: {
      upload: { ...initial },
      vlm_parse: { ...initial },
      classification: { ...initial },
      extraction: { ...initial },
      summarisation: { ...initial },
    },
    results: {},
  });
  return job_id;
}

export function getJob(job_id: string): JobState | undefined {
  return store.get(job_id);
}

export function updateStage(job_id: string, stage: StageName, patch: Partial<StageState>) {
  const job = store.get(job_id);
  if (!job) return;
  const current = job.stages[stage];
  const merged = { ...current, ...patch };
  if (merged.started_at && merged.ended_at) {
    merged.elapsed_ms = merged.ended_at - merged.started_at;
  }
  job.stages[stage] = merged;
}

export function setResult(job_id: string, label: AgentResult["agent"], result: AgentResult) {
  const job = store.get(job_id);
  if (!job) return;
  job.results[label] = result;
}

export function setJobStatus(job_id: string, status: JobState["status"], error?: JobState["error"]) {
  const job = store.get(job_id);
  if (!job) return;
  job.status = status;
  if (error) job.error = error;
}

export function listJobs(): JobState[] {
  return Array.from(store.values());
}
```

- [ ] **Step 3: Run tests + commit**

```bash
npm test
git add lib/jobs.ts lib/__tests__/jobs.test.ts
git commit -m "feat: add in-memory job store with tests"
```

---

## Task 6: Orchestrator (TDD)

**Files:**
- Create: `lib/orchestrator.ts`
- Test: `lib/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Failing test (mocks at the helper boundary)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJob, getJob } from "../jobs";
import { processPdf } from "../orchestrator";
import * as lyzr from "../lyzr";
import * as wrapper from "../wrapper";

beforeEach(() => {
  (global as any).__jobsReset?.();
  vi.restoreAllMocks();
});

describe("processPdf", () => {
  it("runs upload→wrapper→3 agents in parallel and finishes completed", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1", source_asset_id: "src-1", file_name: "x.pdf", file_size_bytes: 100, elapsed_ms: 8000,
    });
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_, args) => `result:${args.agent_id}`);

    const env = { lyzrApiKey: "k", wrapperKey: "w", wrapperUrl: "https://w", lyzrBaseUrl: "https://l" };
    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.stages.vlm_parse.asset_id).toBe("vlm-1");
    expect(job?.results.classification?.raw).toContain("69f377c8");
    expect(job?.results.extraction?.raw).toContain("69f37dc6");
    expect(job?.results.summarisation?.raw).toContain("69f380b2");
  });

  it("partial failure: one agent rejects, others still complete", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1", source_asset_id: "src-1", file_name: "x.pdf", file_size_bytes: 100, elapsed_ms: 8000,
    });
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_, args) => {
      if (args.agent_id.startsWith("69f37dc6")) throw new Error("extraction boom");
      return `result:${args.agent_id}`;
    });

    const env = { lyzrApiKey: "k", wrapperKey: "w", wrapperUrl: "https://w", lyzrBaseUrl: "https://l" };
    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.results.classification).toBeDefined();
    expect(job?.results.summarisation).toBeDefined();
    expect(job?.results.extraction).toBeUndefined();
    expect(job?.stages.extraction.status).toBe("failed");
  });

  it("upload failure marks job failed", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockRejectedValue(new Error("network down"));

    const env = { lyzrApiKey: "k", wrapperKey: "w", wrapperUrl: "https://w", lyzrBaseUrl: "https://l" };
    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("upload");
  });
});
```

- [ ] **Step 2: Implement `lib/orchestrator.ts`**

```ts
import { randomUUID } from "node:crypto";
import { uploadToLyzr, callAgent } from "./lyzr";
import { callWrapper } from "./wrapper";
import { setJobStatus, setResult, updateStage } from "./jobs";
import type { Env } from "./env";
import { AGENTS } from "./types";

export async function processPdf(env: Env, jobId: string, pdfBytes: Buffer): Promise<void> {
  // Stage 1: Upload
  setJobStatus(jobId, "running");
  let sourceAssetId: string;
  try {
    updateStage(jobId, "upload", { status: "running", started_at: Date.now() });
    sourceAssetId = await uploadToLyzr(env, pdfBytes, "upload.pdf");
    updateStage(jobId, "upload", { status: "done", ended_at: Date.now() });
  } catch (err) {
    updateStage(jobId, "upload", { status: "failed", ended_at: Date.now(), error: String(err) });
    setJobStatus(jobId, "failed", { stage: "upload", message: String(err) });
    return;
  }

  // Stage 2: Wrapper
  let vlmAssetId: string;
  try {
    updateStage(jobId, "vlm_parse", { status: "running", started_at: Date.now() });
    const result = await callWrapper(env, sourceAssetId);
    vlmAssetId = result.asset_id;
    updateStage(jobId, "vlm_parse", { status: "done", ended_at: Date.now(), asset_id: vlmAssetId });
  } catch (err) {
    updateStage(jobId, "vlm_parse", { status: "failed", ended_at: Date.now(), error: String(err) });
    setJobStatus(jobId, "failed", { stage: "vlm_parse", message: String(err) });
    return;
  }

  // Stage 3: Three agents in parallel
  const tasks = AGENTS.map(async (agent) => {
    updateStage(jobId, agent.label, { status: "running", started_at: Date.now() });
    try {
      const raw = await callAgent(env, {
        agent_id: agent.agent_id,
        user_id: agent.user_id,
        session_id: randomUUID(),
        asset_id: vlmAssetId,
        message: agent.message,
      });
      setResult(jobId, agent.label, { raw, agent: agent.label });
      updateStage(jobId, agent.label, { status: "done", ended_at: Date.now() });
    } catch (err) {
      updateStage(jobId, agent.label, { status: "failed", ended_at: Date.now(), error: String(err) });
    }
  });

  await Promise.allSettled(tasks);
  setJobStatus(jobId, "completed");
}
```

- [ ] **Step 3: Run tests + commit**

```bash
npm test
git add lib/orchestrator.ts lib/__tests__/orchestrator.test.ts
git commit -m "feat: add parallel-agent orchestrator with partial-failure handling"
```

---

## Task 7: API routes

**Files:**
- Create: `app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`

- [ ] **Step 1: Implement `POST /api/jobs`** (`app/api/jobs/route.ts`)

```ts
import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { createJob } from "@/lib/jobs";
import { processPdf } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const maxDuration = 900; // not enforced on Render, hint only

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  const fileName = (file as any).name ?? "upload.pdf";
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large (max 25MB)" }, { status: 413 });
  }
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "must be a PDF" }, { status: 400 });
  }

  const env = loadEnv();
  const job_id = createJob(fileName);

  // Fire-and-forget — orchestrator updates state in-place
  processPdf(env, job_id, buffer).catch((err) => {
    console.error(`[job ${job_id}] uncaught:`, err);
  });

  return NextResponse.json({ job_id, status: "queued" });
}
```

- [ ] **Step 2: Implement `GET /api/jobs/:id`** (`app/api/jobs/[id]/route.ts`)

```ts
import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(job);
}
```

- [ ] **Step 3: Manual smoke test against running dev server**

```bash
npm run dev &
sleep 3
curl -X POST http://localhost:3000/api/jobs -F "file=@/path/to/Scene_3.pdf"
# capture job_id, then:
curl http://localhost:3000/api/jobs/<job_id> | jq
```

Expected: 200 + JSON job state. Stages advance over ~12 min.

- [ ] **Step 4: Commit**

```bash
git add app/api
git commit -m "feat: POST /api/jobs and GET /api/jobs/:id"
```

---

## Task 8: Frontend — upload page

**Files:**
- Modify: `app/page.tsx`
- Create: `components/upload-form.tsx`

- [ ] **Step 1: Implement `components/upload-form.tsx`** — drag-drop or file picker, POSTs to `/api/jobs`, redirects to `/jobs/[id]`. Use shadcn Button + Card.

(Code intentionally outlined here, not pinned — UI iteration is faster without strict pseudocode. Acceptance: file picker, "Process Document" button, on success router.push to job page.)

- [ ] **Step 2: Wire `app/page.tsx`** with headline + subheadline + UploadForm component.

- [ ] **Step 3: Visual smoke** — `npm run dev`, upload a small PDF, confirm redirect.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx components/upload-form.tsx
git commit -m "feat: landing page + upload form"
```

---

## Task 9: Frontend — status page

**Files:**
- Create: `app/jobs/[id]/page.tsx`, `components/stage-stepper.tsx`, `components/result-section.tsx`

- [ ] **Step 1: Stepper component** — 5 stages (Upload, Parse, Classify, Extract, Summarise) with status indicator + elapsed.

- [ ] **Step 2: Result section** — react-markdown rendering with remark-gfm for tables. "Copy to clipboard" button. Loading spinner while pending.

- [ ] **Step 3: Status page** — client component with `useEffect` polling `/api/jobs/:id` every 3s. Render stepper + each result section as it lands.

- [ ] **Step 4: Visual smoke** with Scene_3.pdf end-to-end. Confirm:
  - Upload + VLM parse complete in ~15s
  - All three agent stages appear running
  - Classification lands first (~4 min), shown immediately
  - Extraction + Summarisation land in 11-15 min
  - Summarisation references Nonthaburi (hallucination canary)

- [ ] **Step 5: Commit**

```bash
git add app/jobs components/stage-stepper.tsx components/result-section.tsx
git commit -m "feat: job status page with polling and result rendering"
```

---

## Task 10: Polish + README

- [ ] **Step 1: Error UX** — failed job shows stage + message + retry hint. Failed agent (partial) renders the others.
- [ ] **Step 2: Sample button** — "Try with sample" pre-stages Scene_3.pdf (committed under `public/samples/Scene_3.pdf`). Optional.
- [ ] **Step 3: Confidence color-coding** in classification output. Optional.
- [ ] **Step 4: Update `README.md`** with: setup, env vars, architecture, local run, deploy steps.
- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: polish + README"
```

---

## Task 11: Deploy to Render

- [ ] **Step 1: Push to GitHub** as `shikhar-lyzr/thai-life-demo-ui`. Confirm public.
- [ ] **Step 2: Render dashboard** → New → Web Service → connect repo. Settings:
  - Runtime: **Node**
  - Build: `npm install && npm run build`
  - Start: `npm start`
  - Branch: `main`
- [ ] **Step 3: Env vars on Render**: `LYZR_API_KEY`, `WRAPPER_KEY` (and optionally override `WRAPPER_URL`, `LYZR_BASE_URL`). NODE_ENV=production.
- [ ] **Step 4: Deploy** — watch logs, hit `/health` (Next.js root) to confirm boot.
- [ ] **Step 5: End-to-end test on deployed URL** with Scene_3.pdf.

---

## Task 12: Capture + Beryl8 update (Shikhar's hands)

- [ ] Record Loom or QuickTime walkthrough: upload → result.
- [ ] Send draft message to beryl-8-deal-room (after Shikhar's review):

> Quick update on the Thai Life PoC. Spinning up a thin demo UI on top of the three agents — clean upload-to-result flow, processes 8-page bundles end-to-end. Avoids some platform quirks we hit wiring this through Lyzr's workflow tool, and the architecture mirrors how Mulesoft would integrate the agents in production. Will share the deployed URL + a walk-through capture once it's polished.

---

## Out of Scope

- WebSockets for live updates (polling is fine for demo).
- Auth / multi-user.
- Persistent storage (in-memory fine for v0).
- Mobile responsiveness (desktop demo).
- LAO workflow integration (explicitly bypassed).

## Self-Review Checklist (run before declaring done)

- [ ] All Lyzr API calls happen server-side (grep for `LYZR_API_KEY` in client components — should be zero).
- [ ] Tests pass (`npm test`).
- [ ] Build succeeds (`npm run build`).
- [ ] Scene_3.pdf end-to-end produces multi-page output (Classification reports `is_bundle: true, page_count: 8`).
- [ ] Summarisation references Nonthaburi (no Chiang Mai hallucination).
- [ ] No secrets in git history.
- [ ] README covers setup + deploy.
