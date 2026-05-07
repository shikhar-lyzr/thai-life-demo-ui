import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callWrapper } from "../wrapper";
import type { Env } from "../env";

const env: Env = {
  lyzrApiKey: "sk-test",
  wrapperKey: "wk-test",
  wrapperUrl: "https://wrapper.example",
  lyzrBaseUrl: "https://lyzr.example",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("callWrapper", () => {
  it("posts source asset_id and returns vlm asset_id payload on first try", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
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

  it("retries on 502 and succeeds on second attempt", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve("Bad Gateway"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ asset_id: "vlm-1", source_asset_id: "src-1", file_name: "x.pdf", file_size_bytes: 1, elapsed_ms: 1 }),
      });
    global.fetch = mock as unknown as typeof fetch;

    const promise = callWrapper(env, "src-1");
    await vi.advanceTimersByTimeAsync(60_000); // span all backoffs
    const result = await promise;
    expect(result.asset_id).toBe("vlm-1");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("upstream"),
    }) as unknown as typeof fetch;

    const promise = callWrapper(env, "src-1");
    // backoffs sum: 3+8+15+30 = 56s; advance well past
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(promise).rejects.toThrow(/wrapper/i);
    // 1 initial + 4 retries = 5 calls
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(5);
  });

  it("does not retry on 4xx (e.g. 401 unauthorized)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    }) as unknown as typeof fetch;

    await expect(callWrapper(env, "src-1")).rejects.toThrow(/wrapper failed: 401/);
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("throws when asset_id missing in response (no retry)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ source_asset_id: "src-1" }),
    }) as unknown as typeof fetch;
    await expect(callWrapper(env, "src-1")).rejects.toThrow(/asset_id/);
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
