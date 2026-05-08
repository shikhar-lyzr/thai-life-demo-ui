import { Agent, fetch as undiciFetch } from "undici";
import type { Env } from "./env";

const TWENTY_MIN_MS = 20 * 60 * 1000;

const longRunningAgent = new Agent({
  headersTimeout: TWENTY_MIN_MS,
  bodyTimeout: TWENTY_MIN_MS,
  connectTimeout: 30_000,
});

// Lyzr's /v3/assets/upload requires parser config as URL query-string params,
// NOT a parse_config form field (which silently no-ops). This shape is the
// canonical Parshva-confirmed combo that produces a multi-page-readable asset
// — verified end-to-end by Classification reporting is_bundle: true,
// page_count: 8 on Scene_3.pdf. Do not change without re-verifying.
const VLM_QUERY_PARAMS = new URLSearchParams({
  parser_provider: "lyzr_parse",
  parsing_mode: "full",
  enable_vlm: "true",
  vlm_provider: "openai",
  vlm_model: "gpt-4o",
  extract_tables: "true",
  describe_images: "true",
}).toString();

export async function uploadToLyzr(env: Env, pdfBytes: Buffer, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }), fileName);
  const resp = await fetch(`${env.lyzrBaseUrl}/v3/assets/upload?${VLM_QUERY_PARAMS}`, {
    method: "POST",
    headers: { "x-api-key": env.lyzrApiKey },
    body: form,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`upload failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const first = data?.results?.[0];
  if (!first?.success || !first.asset_id) {
    throw new Error(`upload returned no asset_id: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return first.asset_id as string;
}

export interface CallAgentArgs {
  agent_id: string;
  user_id: string;
  session_id: string;
  asset_id: string;
  message: string;
}

export async function callAgent(env: Env, args: CallAgentArgs): Promise<string> {
  // Use undici directly with extended timeouts. Lyzr's inference endpoint
  // can take 5-15 min per agent, well beyond Node fetch's default 300s headersTimeout.
  const resp = await undiciFetch(`${env.lyzrBaseUrl}/v3/inference/chat/`, {
    method: "POST",
    headers: { "x-api-key": env.lyzrApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: args.user_id,
      agent_id: args.agent_id,
      session_id: args.session_id,
      message: args.message,
      assets: [args.asset_id],
    }),
    dispatcher: longRunningAgent,
  });
  if (resp.status === 402) {
    const detail = await resp.json().catch(() => ({ detail: "" })) as { detail?: string };
    throw new Error(`credits exhausted: ${detail.detail ?? ""}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`agent ${args.agent_id} failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json() as { response?: string };
  if (typeof data?.response !== "string") {
    throw new Error(`agent returned no response field: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.response;
}
