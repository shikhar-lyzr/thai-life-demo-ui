import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJob, getJob, __resetJobStoreForTests } from "../jobs";
import { processPdf } from "../orchestrator";
import * as lyzr from "../lyzr";
import type { Env } from "../env";

const env: Env = {
  lyzrApiKey: "k",
  lyzrBaseUrl: "https://l",
};

beforeEach(() => {
  __resetJobStoreForTests();
  vi.restoreAllMocks();
});

describe("processPdf", () => {
  it("runs upload→3 agents in parallel and finishes completed", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("vlm-1");
    vi.spyOn(lyzr, "callAgent").mockImplementation(async (_e, args) => `result:${args.agent_id}`);

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

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
    await processPdf(env, id, Buffer.from("%PDF"));
    expect(maxInflight).toBe(3);
  });

  it("partial failure: one agent rejects, others still complete", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockResolvedValue("vlm-1");
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

  it("upload failure marks job failed and short-circuits agents", async () => {
    vi.spyOn(lyzr, "uploadToLyzr").mockRejectedValue(new Error("network down"));
    const agentSpy = vi.spyOn(lyzr, "callAgent");

    const id = createJob("x.pdf");
    await processPdf(env, id, Buffer.from("%PDF"));

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.stage).toBe("upload");
    expect(job?.stages.upload.status).toBe("failed");
    expect(agentSpy).not.toHaveBeenCalled();
  });
});
