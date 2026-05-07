import { randomUUID } from "node:crypto";
import { uploadToLyzr, callAgent } from "./lyzr";
import { callWrapper } from "./wrapper";
import { setJobStatus, setResult, updateStage, getJob } from "./jobs";
import type { Env } from "./env";
import { AGENTS } from "./types";

export async function processPdf(env: Env, jobId: string, pdfBytes: Buffer): Promise<void> {
  setJobStatus(jobId, "running");
  const job = getJob(jobId);
  const fileName = job?.file_name ?? "upload.pdf";

  // Stage 1: Upload (no VLM — wrapper handles VLM)
  let sourceAssetId: string;
  try {
    updateStage(jobId, "upload", { status: "running", started_at: Date.now() });
    sourceAssetId = await uploadToLyzr(env, pdfBytes, fileName);
    updateStage(jobId, "upload", { status: "done", ended_at: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateStage(jobId, "upload", { status: "failed", ended_at: Date.now(), error: message });
    setJobStatus(jobId, "failed", { stage: "upload", message });
    return;
  }

  // Stage 2: Wrapper VLM re-parse
  let vlmAssetId: string;
  try {
    updateStage(jobId, "vlm_parse", { status: "running", started_at: Date.now() });
    const result = await callWrapper(env, sourceAssetId);
    vlmAssetId = result.asset_id;
    updateStage(jobId, "vlm_parse", {
      status: "done",
      ended_at: Date.now(),
      asset_id: vlmAssetId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateStage(jobId, "vlm_parse", { status: "failed", ended_at: Date.now(), error: message });
    setJobStatus(jobId, "failed", { stage: "vlm_parse", message });
    return;
  }

  // Stage 3: Three agents IN PARALLEL via Promise.allSettled
  const agentTasks = AGENTS.map(async (agent) => {
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
