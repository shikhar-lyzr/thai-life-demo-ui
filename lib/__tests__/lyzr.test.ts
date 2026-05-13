import { describe, it, expect, vi, beforeEach } from "vitest";

const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn() }));
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, fetch: undiciFetchMock };
});

import { uploadToLyzr, callAgent } from "../lyzr";
import type { Env } from "../env";

const env: Env = {
  lyzrApiKey: "sk-test",
  lyzrBaseUrl: "https://lyzr.example",
};

beforeEach(() => {
  vi.restoreAllMocks();
  undiciFetchMock.mockReset();
});

describe("uploadToLyzr", () => {
  it("posts multipart with VLM query params and returns asset_id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ success: true, asset_id: "abc-123" }] }),
    }) as unknown as typeof fetch;
    const id = await uploadToLyzr(env, Buffer.from("%PDF"), "test.pdf");
    expect(id).toBe("abc-123");
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url.startsWith("https://lyzr.example/v3/assets/upload?")).toBe(true);
    // Parshva-confirmed VLM query-string shape — load-bearing
    expect(url).toContain("parser_provider=lyzr_parse");
    expect(url).toContain("parsing_mode=full");
    expect(url).toContain("enable_vlm=true");
    expect(url).toContain("vlm_provider=openai");
    expect(url).toContain("vlm_model=gpt-4o");
    expect(url).toContain("extract_tables=true");
    expect(url).toContain("describe_images=true");
    expect((call[1] as RequestInit).headers).toMatchObject({ "x-api-key": "sk-test" });
  });

  it("throws on non-200", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    }) as unknown as typeof fetch;
    await expect(uploadToLyzr(env, Buffer.from("x"), "test.pdf")).rejects.toThrow(/upload/);
  });

  it("throws when results array is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    }) as unknown as typeof fetch;
    await expect(uploadToLyzr(env, Buffer.from("x"), "test.pdf")).rejects.toThrow(/asset_id/);
  });
});

describe("callAgent", () => {
  it("posts inference body and returns response text", async () => {
    undiciFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ response: "report markdown" }),
    });
    const out = await callAgent(env, {
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "sess-1",
      asset_ids: ["asset-1"],
      message: "Classify",
    });
    expect(out).toBe("report markdown");
    const call = undiciFetchMock.mock.calls[0];
    expect(call[0]).toBe("https://lyzr.example/v3/inference/chat/");
    const body = JSON.parse(call[1].body);
    expect(body.assets).toEqual(["asset-1"]);
    expect(body.agent_id).toBe("agent-1");
    expect(body.user_id).toBe("user-1");
    expect(body.session_id).toBe("sess-1");
    expect(body.message).toBe("Classify");
  });

  it("throws on 402 credit exhaustion", async () => {
    undiciFetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ detail: "Credits exhausted" }),
    });
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_ids: ["x"], message: "x" })
    ).rejects.toThrow(/credits/i);
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    undiciFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve("Bad Gateway"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ response: "ok markdown" }),
      });

    const promise = callAgent(env, {
      agent_id: "agent-1", user_id: "u", session_id: "s", asset_ids: ["a"], message: "m",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await promise;
    expect(out).toBe("ok markdown");
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up after exhausting retries on persistent 5xx", async () => {
    vi.useFakeTimers();
    undiciFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("upstream"),
    });
    const promise = callAgent(env, {
      agent_id: "x", user_id: "x", session_id: "x", asset_ids: ["x"], message: "x",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(promise).rejects.toThrow(/agent/);
    // 1 initial + 2 retries = 3 attempts
    expect(undiciFetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does NOT retry on 4xx", async () => {
    undiciFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    });
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_ids: ["x"], message: "x" })
    ).rejects.toThrow(/agent.*failed/i);
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on network/timeout error", async () => {
    undiciFetchMock.mockRejectedValue(new Error("AbortError"));
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_ids: ["x"], message: "x" })
    ).rejects.toThrow();
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when response field missing", async () => {
    undiciFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ something: "else" }),
    });
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_ids: ["x"], message: "x" })
    ).rejects.toThrow(/response/);
  });
});
