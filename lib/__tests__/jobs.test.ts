import { describe, it, expect, beforeEach } from "vitest";
import {
  createJob,
  getJob,
  updateStage,
  setResult,
  setJobStatus,
  __resetJobStoreForTests,
} from "../jobs";

beforeEach(() => {
  __resetJobStoreForTests();
});

describe("jobs store", () => {
  it("creates and retrieves jobs with correct initial shape", () => {
    const id = createJob("test.pdf");
    const job = getJob(id);
    expect(job?.file_name).toBe("test.pdf");
    expect(job?.status).toBe("queued");
    expect(job?.stages.upload.status).toBe("pending");
    expect(job?.stages.classification.status).toBe("pending");
    expect(job?.results).toEqual({});
  });

  it("getJob returns undefined for unknown id", () => {
    expect(getJob("does-not-exist")).toBeUndefined();
  });

  it("updateStage records elapsed_ms when both timestamps present", () => {
    const id = createJob("x.pdf");
    const t0 = 1_000_000;
    updateStage(id, "upload", { status: "running", started_at: t0 });
    updateStage(id, "upload", { status: "done", ended_at: t0 + 2500 });
    const job = getJob(id);
    expect(job?.stages.upload.status).toBe("done");
    expect(job?.stages.upload.elapsed_ms).toBe(2500);
  });

  it("updateStage merges partial patches without losing prior fields", () => {
    const id = createJob("x.pdf");
    updateStage(id, "upload", { status: "running", started_at: 5 });
    updateStage(id, "upload", { asset_id: "vlm-1" });
    const stage = getJob(id)!.stages.upload;
    expect(stage.status).toBe("running");
    expect(stage.started_at).toBe(5);
    expect(stage.asset_id).toBe("vlm-1");
  });

  it("setResult attaches agent output", () => {
    const id = createJob("x.pdf");
    setResult(id, "classification", { raw: "report", agent: "classification" });
    expect(getJob(id)?.results.classification?.raw).toBe("report");
  });

  it("setJobStatus updates terminal status and error", () => {
    const id = createJob("x.pdf");
    setJobStatus(id, "failed", { stage: "upload", message: "boom" });
    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("upload");
  });

  it("methods are no-ops on unknown job_id (no throw)", () => {
    expect(() => updateStage("nope", "upload", { status: "running" })).not.toThrow();
    expect(() => setResult("nope", "classification", { raw: "x", agent: "classification" })).not.toThrow();
    expect(() => setJobStatus("nope", "completed")).not.toThrow();
  });
});
