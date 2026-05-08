import type { Env } from "./env";

export interface WrapperResult {
  asset_id: string;
  source_asset_id: string;
  file_name: string;
  file_size_bytes: number;
  elapsed_ms: number;
}

// Render free-tier cold-start can take up to ~60s. These backoffs span 3+8+15+30+60 = 116s,
// giving the wrapper a full cold-start cycle to come up before we give up.
const COLD_START_BACKOFFS_MS = [3000, 8000, 15000, 30000, 60000];

const WAKE_POLL_INTERVAL_MS = 3000;
const WAKE_TIMEOUT_MS = 90_000;

// Poll /health until it returns 200 or the deadline expires. Resolves true if
// the wrapper is verifiably awake, false if the deadline passes. Errors and
// non-200 responses count as "still waking" — we keep polling.
export async function waitForWrapper(env: Env, timeoutMs = WAKE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${env.wrapperUrl}/health`, { method: "GET" });
      if (resp.ok) return true;
    } catch {
      // network error during cold-start — keep polling
    }
    if (Date.now() + WAKE_POLL_INTERVAL_MS >= deadline) break;
    await new Promise((r) => setTimeout(r, WAKE_POLL_INTERVAL_MS));
  }
  return false;
}

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
