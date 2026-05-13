"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { JobState } from "@/lib/types";
import { StageStepper } from "@/components/stage-stepper";
import { ChunkStrip } from "@/components/chunk-strip";
import { ResultSection } from "@/components/result-section";

const POLL_INTERVAL_MS = 3000;

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const resp = await fetch(`/api/jobs/${id}`);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const data: JobState = await resp.json();
        if (cancelled) return;
        setJob(data);
        setError(null);
        if (data.status === "completed" || data.status === "failed") {
          return; // stop polling
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error && !job) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← New job
        </Link>
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      </main>
    );
  }

  if (!job) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-sm text-slate-500">Loading job…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← New job
        </Link>
        <span className="text-xs text-slate-400">{job.job_id}</span>
      </div>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{job.file_name}</h1>
      <p className="mb-6 text-sm text-slate-500">
        Status: <span className="font-medium">{job.status}</span>
      </p>

      <div className="mb-8">
        <StageStepper job={job} />
        <ChunkStrip chunks={job.stages.upload.chunks} />
      </div>

      {job.error && (
        <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <strong>Failed at {job.error.stage}:</strong> {job.error.message}
        </div>
      )}

      <div className="space-y-6">
        <ResultSection
          title="Classification"
          result={job.results.classification}
          stage={job.stages.classification}
        />
        <ResultSection
          title="Extraction"
          result={job.results.extraction}
          stage={job.stages.extraction}
        />
        <ResultSection
          title="Underwriter Brief"
          result={job.results.summarisation}
          stage={job.stages.summarisation}
        />
      </div>
    </main>
  );
}
