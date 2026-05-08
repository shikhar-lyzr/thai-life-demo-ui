import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJob, getJob, __resetJobStoreForTests } from "../jobs";
import { processPdf } from "../orchestrator";
import * as lyzr from "../lyzr";
import * as wrapper from "../wrapper";
import type { Env } from "../env";

const env: Env = {
  lyzrApiKey: "k",
  wrapperKey: "w",
  wrapperUrl: "https://w",
  lyzrBaseUrl: "https://l",
};

beforeEach(() => {
  __resetJobStoreForTests();
  vi.restoreAllMocks();
  // waitForWrapper does real /health polls; stub it out for unit tests.
  vi.spyOn(wrapper, "waitForWrapper").mockResolvedValue(true);
});

describe("processPdf", () => {
  it("runs upload→wrapper→3 agents in parallel and finishes completed", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1",
      source_asset_id: "src-1",
      file_name: "x.pdf",
      file_size_bytes: 100,
      elapsed_ms: 8000,
    });
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_e, args) => `result:${args.agent_id}`);

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.stages.upload.status).toBe("done");
    expect(job?.stages.vlm_parse.status).toBe("done");
    expect(job?.stages.vlm_parse.asset_id).toBe("vlm-1");
    expect(job?.stages.classification.status).toBe("done");
    expect(job?.stages.extraction.status).toBe("done");
    expect(job?.stages.summarisation.status).toBe("done");
    expect(job?.results.classification?.raw).toContain("69f377c8");
    expect(job?.results.extraction?.raw).toContain("69f37dc6");
    expect(job?.results.summarisation?.raw).toContain("69f380b2");
  });

  it("agents are dispatched in parallel, not serial", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1",
      source_asset_id: "src-1",
      file_name: "x.pdf",
      file_size_bytes: 100,
      elapsed_ms: 8000,
    });

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
    await processPdf(env, id, Buffer.from("%PDF"));
    expect(maxInflight).toBe(3);
  });

  it("partial failure: one agent rejects, others still complete", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1",
      source_asset_id: "src-1",
      file_name: "x.pdf",
      file_size_bytes: 100,
      elapsed_ms: 8000,
    });
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_e, args) => {
      if (args.agent_id.startsWith("69f37dc6")) throw new Error("extraction boom");
      return `result:${args.agent_id}`;
    });

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.results.classification).toBeDefined();
    expect(job?.results.summarisation).toBeDefined();
    expect(job?.results.extraction).toBeUndefined();
    expect(job?.stages.extraction.status).toBe("failed");
    expect(job?.stages.classification.status).toBe("done");
    expect(job?.stages.summarisation.status).toBe("done");
  });

  it("upload failure marks job failed and short-circuits remaining stages", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockRejectedValue(new Error("network down"));
    const wrapperSpy = vi.spyOn(wrapper, "callWrapper").mockResolvedValue({
      asset_id: "vlm-1",
      source_asset_id: "src-1",
      file_name: "x.pdf",
      file_size_bytes: 100,
      elapsed_ms: 8000,
    });
    const agentSpy = vi.spyOn(lyzr, "callAgent");

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("upload");
    expect(job?.stages.upload.status).toBe("failed");
    expect(wrapperSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("wrapper failure marks job failed and short-circuits agents", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("src-1");
    vi.spyOn(wrapper, "callWrapper").mockRejectedValue(new Error("wrapper boom"));
    const agentSpy = vi.spyOn(lyzr, "callAgent");

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("vlm_parse");
    expect(job?.stages.vlm_parse.status).toBe("failed");
    expect(agentSpy).not.toHaveBeenCalled();
  });
});
