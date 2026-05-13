import { randomUUID } from "node:crypto";
import type { JobState, StageName, StageState, AgentResult, AgentLabel, ChunkState } from "./types";

const store = new Map<string, JobState>();

export function __resetJobStoreForTests(): void {
  store.clear();
}

function freshStage(): StageState {
  return { status: "pending" };
}

export function createJob(file_name: string): string {
  const job_id = randomUUID();
  const now = Date.now();
  store.set(job_id, {
    job_id,
    file_name,
    created_at: now,
    status: "queued",
    stages: {
      upload: freshStage(),
      classification: freshStage(),
      extraction: freshStage(),
      summarisation: freshStage(),
    },
    results: {},
  });
  return job_id;
}

export function getJob(job_id: string): JobState | undefined {
  return store.get(job_id);
}

export function updateStage(job_id: string, stage: StageName, patch: Partial<StageState>): void {
  const job = store.get(job_id);
  if (!job) return;
  const merged: StageState = { ...job.stages[stage], ...patch };
  if (merged.started_at != null && merged.ended_at != null) {
    merged.elapsed_ms = merged.ended_at - merged.started_at;
  }
  job.stages[stage] = merged;
}

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

export function setResult(job_id: string, label: AgentLabel, result: AgentResult): void {
  const job = store.get(job_id);
  if (!job) return;
  job.results[label] = result;
}

export function setJobStatus(
  job_id: string,
  status: JobState["status"],
  error?: JobState["error"]
): void {
  const job = store.get(job_id);
  if (!job) return;
  job.status = status;
  if (error) job.error = error;
}

export function listJobs(): JobState[] {
  return Array.from(store.values());
}
