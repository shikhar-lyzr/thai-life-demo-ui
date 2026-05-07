import type { Env } from "./env";

export async function uploadToLyzr(env: Env, pdfBytes: Buffer, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }), fileName);
  const resp = await fetch(`${env.lyzrBaseUrl}/v3/assets/upload`, {
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
  const resp = await fetch(`${env.lyzrBaseUrl}/v3/inference/chat/`, {
    method: "POST",
    headers: { "x-api-key": env.lyzrApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: args.user_id,
      agent_id: args.agent_id,
      session_id: args.session_id,
      message: args.message,
      assets: [args.asset_id],
    }),
  });
  if (resp.status === 402) {
    const detail = await resp.json().catch(() => ({ detail: "" }));
    throw new Error(`credits exhausted: ${detail.detail ?? ""}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`agent ${args.agent_id} failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (typeof data?.response !== "string") {
    throw new Error(`agent returned no response field: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.response;
}
