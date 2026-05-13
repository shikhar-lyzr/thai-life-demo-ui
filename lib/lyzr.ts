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

const DEFAULT_UPLOAD_BACKOFFS_MS = [5000, 15000];

/**
 * Uploads a PDF with retry-on-transient-error semantics.
 *
 * Retries on:
 *   - 5xx responses
 *   - thrown errors from fetch (network failures, timeouts)
 *
 * Does NOT retry on 4xx (the request is malformed; retry won't help).
 *
 * Backoffs default to [5s, 15s] — two retries after the initial attempt.
 */
export async function uploadWithRetry(
  env: Env,
  pdfBytes: Buffer,
  fileName: string,
  opts?: { backoffMs?: number[] }
): Promise<string> {
  const backoffs = opts?.backoffMs ?? DEFAULT_UPLOAD_BACKOFFS_MS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await uploadToLyzr(env, pdfBytes, fileName);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry 4xx — message format from uploadToLyzr is "upload failed: <code> ..."
      const m = /^upload failed: (\d{3})/.exec(msg);
      if (m) {
        const code = parseInt(m[1], 10);
        if (code >= 400 && code < 500) throw err;
      }
      if (attempt < backoffs.length) {
        console.log(
          `[uploadWithRetry] retry attempt=${attempt} file=${fileName} reason=${msg.slice(0, 120).replace(/\n/g, " ")}`
        );
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("uploadWithRetry: unreachable");
}

export interface CallAgentArgs {
  agent_id: string;
  user_id: string;
  session_id: string;
  asset_ids: string[];
  message: string;
}

// Retry on 5xx (Lyzr edge transient — observed mid-stream during real runs).
// Don't retry on 4xx (would just keep failing) or network/timeout errors
// (probably hung agent — fail fast rather than waste another attempt).
const AGENT_RETRY_BACKOFFS_MS = [5000, 15000];

export async function callAgent(env: Env, args: CallAgentArgs): Promise<string> {
  const body = JSON.stringify({
    user_id: args.user_id,
    agent_id: args.agent_id,
    session_id: args.session_id,
    message: args.message,
    assets: args.asset_ids,
  });

  for (let attempt = 0; attempt <= AGENT_RETRY_BACKOFFS_MS.length; attempt++) {
    const attemptStart = Date.now();
    // Network errors and AbortSignal timeouts are NOT retried — fall through to caller.
    const resp = await undiciFetch(`${env.lyzrBaseUrl}/v3/inference/chat/`, {
      method: "POST",
      headers: { "x-api-key": env.lyzrApiKey, "Content-Type": "application/json" },
      body,
      dispatcher: longRunningAgent,
    });
    const attemptElapsed = Date.now() - attemptStart;

    if (resp.status === 402) {
      const detail = (await resp.json().catch(() => ({ detail: "" }))) as { detail?: string };
      throw new Error(`credits exhausted: ${detail.detail ?? ""}`);
    }

    if (resp.status >= 500 && resp.status < 600 && attempt < AGENT_RETRY_BACKOFFS_MS.length) {
      // 5xx — retry after backoff
      const detail = await resp.text().catch(() => "");
      console.log(
        `[callAgent] retry attempt=${attempt} agent=${args.agent_id} status=${resp.status} elapsed=${attemptElapsed}ms detail=${detail.slice(0, 80).replace(/\n/g, " ")}`
      );
      await new Promise((r) => setTimeout(r, AGENT_RETRY_BACKOFFS_MS[attempt]));
      continue;
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`agent ${args.agent_id} failed: ${resp.status} ${detail.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { response?: string };
    if (typeof data?.response !== "string") {
      throw new Error(`agent returned no response field: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.response;
  }
  throw new Error("callAgent: unreachable retry path");
}
