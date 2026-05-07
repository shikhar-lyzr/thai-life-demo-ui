import { describe, it, expect, vi, beforeEach } from "vitest";
import { callWrapper } from "../wrapper";
import type { Env } from "../env";

const env: Env = {
  lyzrApiKey: "sk-test",
  wrapperKey: "wk-test",
  wrapperUrl: "https://wrapper.example",
  lyzrBaseUrl: "https://lyzr.example",
};

beforeEach(() => vi.restoreAllMocks());

describe("callWrapper", () => {
  it("posts source asset_id and returns vlm asset_id payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          asset_id: "vlm-456",
          source_asset_id: "src-1",
          file_name: "x.pdf",
          file_size_bytes: 100,
          elapsed_ms: 9000,
        }),
    }) as unknown as typeof fetch;

    const result = await callWrapper(env, "src-1");
    expect(result.asset_id).toBe("vlm-456");
    expect(result.elapsed_ms).toBe(9000);

    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://wrapper.example/api/vlm-reparse");
    expect((call[1] as RequestInit).headers).toMatchObject({ "x-wrapper-key": "wk-test" });
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ asset_id: "src-1" });
  });

  it("throws on wrapper 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("upstream"),
    }) as unknown as typeof fetch;
    await expect(callWrapper(env, "src-1")).rejects.toThrow(/wrapper/i);
  });

  it("throws when asset_id missing in response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ source_asset_id: "src-1" }),
    }) as unknown as typeof fetch;
    await expect(callWrapper(env, "src-1")).rejects.toThrow(/asset_id/);
  });
});
