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

      // Strip .pdf extension before suffixing chunk index, then re-add — Lyzr's
      // upload validates file type by extension and rejects `foo.pdf-chunk1`.
      const fileBase = fileName.replace(/\.pdf$/i, "");
      assetIds = await mapWithConcurrency(chunks, UPLOAD_CONCURRENCY, async (chunk, idx) => {
        updateChunk(jobId, idx, { status: "running" });
        const chunkStart = Date.now();
        try {
          const aid = await uploadWithRetry(env, chunk.buffer, `${fileBase}-chunk${idx + 1}.pdf`);
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
