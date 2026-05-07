import type { Env } from "./env";

export interface WrapperResult {
  asset_id: string;
  source_asset_id: string;
  file_name: string;
  file_size_bytes: number;
  elapsed_ms: number;
}

const COLD_START_BACKOFFS_MS = [3000, 8000, 15000, 30000];

export async function callWrapper(env: Env, sourceAssetId: string): Promise<WrapperResult> {
  // Wrapper runs on Render free tier and may cold-start (~50s). Retry on 5xx
  // with backoffs that span the typical cold-start window.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= COLD_START_BACKOFFS_MS.length; attempt++) {
    try {
      const resp = await fetch(`${env.wrapperUrl}/api/vlm-reparse`, {
        method: "POST",
        headers: { "x-wrapper-key": env.wrapperKey, "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: sourceAssetId }),
      });
      if (resp.status >= 500 && resp.status < 600) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`wrapper ${resp.status}: ${detail.slice(0, 120)}`);
      }
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`wrapper failed: ${resp.status} ${detail.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (!data?.asset_id) {
        throw new Error(`wrapper returned no asset_id: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return data as WrapperResult;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const is5xx = /^wrapper [5]\d\d:/.test(lastErr.message);
      if (!is5xx || attempt === COLD_START_BACKOFFS_MS.length) {
        throw lastErr;
      }
      await new Promise((r) => setTimeout(r, COLD_START_BACKOFFS_MS[attempt]));
    }
  }
  throw lastErr ?? new Error("wrapper: unreachable retry path");
}
