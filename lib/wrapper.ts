import type { Env } from "./env";

export interface WrapperResult {
  asset_id: string;
  source_asset_id: string;
  file_name: string;
  file_size_bytes: number;
  elapsed_ms: number;
}

export async function callWrapper(env: Env, sourceAssetId: string): Promise<WrapperResult> {
  const resp = await fetch(`${env.wrapperUrl}/api/vlm-reparse`, {
    method: "POST",
    headers: { "x-wrapper-key": env.wrapperKey, "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id: sourceAssetId }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`wrapper failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data?.asset_id) {
    throw new Error(`wrapper returned no asset_id: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as WrapperResult;
}
