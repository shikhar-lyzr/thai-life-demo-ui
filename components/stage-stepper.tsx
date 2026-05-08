import type { JobState, StageName, StageStatus } from "@/lib/types";

const STAGES: { key: StageName; label: string }[] = [
  { key: "upload", label: "Upload + VLM Parse" },
  { key: "classification", label: "Classify" },
  { key: "extraction", label: "Extract" },
  { key: "summarisation", label: "Summarise" },
];

function statusGlyph(status: StageStatus) {
  switch (status) {
    case "done":
      return <span className="text-green-600 dark:text-green-400">●</span>;
    case "running":
      return <span className="animate-pulse text-blue-600 dark:text-blue-400">●</span>;
    case "failed":
      return <span className="text-red-600 dark:text-red-400">●</span>;
    case "pending":
    default:
      return <span className="text-slate-300 dark:text-slate-700">●</span>;
  }
}

function fmtMs(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function StageStepper({ job }: { job: JobState }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <div className="grid grid-cols-4 gap-2 text-sm">
        {STAGES.map(({ key, label }) => {
          const stage = job.stages[key];
          return (
            <div key={key} className="flex flex-col items-center gap-1">
              <div className="text-xl">{statusGlyph(stage.status)}</div>
              <div className="font-medium">{label}</div>
              <div className="text-xs text-slate-400">
                {stage.status === "done" && fmtMs(stage.elapsed_ms)}
                {stage.status === "running" && "running…"}
                {stage.status === "failed" && "failed"}
                {stage.status === "pending" && "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
