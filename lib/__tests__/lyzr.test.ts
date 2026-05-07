import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadToLyzr, callAgent } from "../lyzr";
import type { Env } from "../env";

const env: Env = {
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
    }) as unknown as typeof fetch;
    const id = await uploadToLyzr(env, Buffer.from("%PDF"), "test.pdf");
    expect(id).toBe("abc-123");
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://lyzr.example/v3/assets/upload");
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
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "report markdown" }),
    }) as unknown as typeof fetch;
    const out = await callAgent(env, {
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "sess-1",
      asset_id: "asset-1",
      message: "Classify",
    });
    expect(out).toBe("report markdown");
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.assets).toEqual(["asset-1"]);
    expect(body.agent_id).toBe("agent-1");
    expect(body.user_id).toBe("user-1");
    expect(body.session_id).toBe("sess-1");
    expect(body.message).toBe("Classify");
  });

  it("throws on 402 credit exhaustion", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ detail: "Credits exhausted" }),
    }) as unknown as typeof fetch;
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_id: "x", message: "x" })
    ).rejects.toThrow(/credits/i);
  });

  it("throws on non-200", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    }) as unknown as typeof fetch;
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_id: "x", message: "x" })
    ).rejects.toThrow(/agent/);
  });

  it("throws when response field missing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ something: "else" }),
    }) as unknown as typeof fetch;
    await expect(
      callAgent(env, { agent_id: "x", user_id: "x", session_id: "x", asset_id: "x", message: "x" })
    ).rejects.toThrow(/response/);
  });
});
