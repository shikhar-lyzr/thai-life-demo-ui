import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { createJob } from "@/lib/jobs";
import { processPdf } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const maxDuration = 900;

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
  }

  const fileName = (file as File).name ?? "upload.pdf";
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "must be a PDF" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (max ${MAX_BYTES / 1024 / 1024}MB)` },
      { status: 413 }
    );
  }

  let env;
  try {
    env = loadEnv();
  } catch (err) {
    return NextResponse.json(
      { error: `server misconfigured: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  const job_id = createJob(fileName);
  // Fire-and-forget — orchestrator updates state in-place
  processPdf(env, job_id, buffer).catch((err) => {
    console.error(`[job ${job_id}] uncaught:`, err);
  });

  return NextResponse.json({ job_id, status: "queued" });
}
