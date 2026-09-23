"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { AgentLabel, JobState, StageStatus } from "@/lib/types";
import { StageStepper } from "@/components/stage-stepper";
import { ChunkStrip } from "@/components/chunk-strip";
import { ResultSection } from "@/components/result-section";

const POLL_INTERVAL_MS = 3000;

const TABS: { kind: AgentLabel; title: string }[] = [
  { kind: "classification", title: "Classification" },
  { kind: "extraction", title: "Extraction" },
  { kind: "summarisation", title: "Underwriter Brief" },
];

// Same colours as the stage stepper glyphs.
const TAB_DOT: Record<StageStatus, string> = {
  done: "bg-green-600 dark:bg-green-400",
  running: "animate-pulse bg-blue-600 dark:bg-blue-400",
  failed: "bg-red-600 dark:bg-red-400",
  pending: "bg-slate-300 dark:bg-slate-700",
};

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentLabel>("classification");

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
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
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

      <div>
        <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {TABS.map(({ kind, title }) => (
            <button
              key={kind}
              role="tab"
              aria-selected={tab === kind}
              onClick={() => setTab(kind)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium ${
                tab === kind
                  ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${TAB_DOT[job.stages[kind].status]}`} />
              {title}
            </button>
          ))}
        </div>
        {TABS.map(({ kind, title }) => (
          <div key={kind} role="tabpanel" hidden={tab !== kind}>
            <ResultSection title={title} kind={kind} result={job.results[kind]} stage={job.stages[kind]} />
          </div>
        ))}
      </div>
    </main>
  );
}
