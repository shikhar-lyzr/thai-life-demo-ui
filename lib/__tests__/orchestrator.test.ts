import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJob, getJob, __resetJobStoreForTests } from "../jobs";
import { processPdf } from "../orchestrator";
import * as lyzr from "../lyzr";
import type { Env } from "../env";
import { PDFDocument } from "pdf-lib";

const env: Env = {
  lyzrApiKey: "k",
  lyzrBaseUrl: "https://l",
};

/** Build a real synthetic PDF with `n` blank pages (pdf-lib roundtrip). */
async function makePdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

beforeEach(() => {
  __resetJobStoreForTests();
  vi.restoreAllMocks();
});

describe("processPdf", () => {
  it("runs upload→3 agents in parallel and finishes completed", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("vlm-1");
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_e, args) => `result:${args.agent_id}`);

    const id = createJob("x.pdf");
    await processPdf(env, id, await makePdf(1));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.stages.upload.status).toBe("done");
    expect(job?.stages.upload.asset_id).toBe("vlm-1");
    expect(job?.stages.classification.status).toBe("done");
    expect(job?.stages.extraction.status).toBe("done");
    expect(job?.stages.summarisation.status).toBe("done");
    expect(job?.results.classification?.raw).toContain("69f377c8");
    expect(job?.results.extraction?.raw).toContain("69f37dc6");
    expect(job?.results.summarisation?.raw).toContain("69f380b2");
  });

  it("agents are dispatched in parallel, not serial", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("vlm-1");

    let inflight = 0;
    let maxInflight = 0;
    vi.spyOn(lyzr, "callAgent").mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      return "ok";
    });

    const id = createJob("x.pdf");
    await processPdf(env, id, await makePdf(1));
    expect(maxInflight).toBe(3);
  });

  it("partial failure: one agent rejects, others still complete", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("vlm-1");
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_e, args) => {
      if (args.agent_id.startsWith("69f37dc6")) throw new Error("extraction boom");
      return `result:${args.agent_id}`;
    });

    const id = createJob("x.pdf");
    await processPdf(env, id, await makePdf(1));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.results.classification).toBeDefined();
    expect(job?.results.summarisation).toBeDefined();
    expect(job?.results.extraction).toBeUndefined();
    expect(job?.stages.extraction.status).toBe("failed");
    expect(job?.stages.classification.status).toBe("done");
    expect(job?.stages.summarisation.status).toBe("done");
  });

  it("upload failure marks job failed and short-circuits agents", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockRejectedValue(new Error("network down"));
    const agentSpy = vi.spyOn(lyzr, "callAgent");

    const id = createJob("x.pdf");
    await processPdf(env, id, await makePdf(1));

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("upload");
    expect(job?.stages.upload.status).toBe("failed");
    expect(agentSpy).not.toHaveBeenCalled();
  });
});

describe("processPdf chunked path", () => {
  it("chunks a >10-page PDF, uploads each, calls agents with full asset_ids array", async () => {
    // Build a synthetic 15-page PDF (will be split into 2 chunks: pages 1-10, 9-15)
    const pdfBytes = await makePdf(15);

    // Mock uploadWithRetry (used by chunked path) to return per-chunk asset ids.
    // We spy on uploadWithRetry rather than uploadToLyzr because uploadWithRetry
    // calls uploadToLyzr from the same module scope — spying on the export binding
    // wouldn't intercept internal calls.
    const uploadCalls: string[] = [];
    vi.spyOn(lyzr, "uploadWithRetry").mockImplementation(async (_env, _buf, name) => {
      const id = `asset-${uploadCalls.length}`;
      uploadCalls.push(name);
      return id;
    });

    // Mock callAgent to capture asset_ids
    const seenAssetIds: string[][] = [];
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_env, args) => {
      seenAssetIds.push(args.asset_ids);
      return `mock-response-for-${args.agent_id}`;
    });

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
