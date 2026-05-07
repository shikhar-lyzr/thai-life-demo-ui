"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentResult, StageState } from "@/lib/types";

interface Props {
  title: string;
  result: AgentResult | undefined;
  stage: StageState;
}

export function ResultSection({ title, result, stage }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {stage.status === "running" && <span>Running…</span>}
          {stage.status === "failed" && (
            <span className="text-red-600 dark:text-red-400">Failed</span>
          )}
          {stage.status === "done" && result && (
            <button
              onClick={copy}
              className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </header>
      <div className="px-4 py-4">
        {stage.status === "pending" && (
          <p className="text-sm text-slate-400">Waiting on upstream stages…</p>
        )}
        {stage.status === "running" && !result && (
          <p className="text-sm text-slate-500">Agent is processing the bundle…</p>
        )}
        {stage.status === "failed" && (
          <pre className="whitespace-pre-wrap text-sm text-red-700 dark:text-red-300">
            {stage.error ?? "Unknown error"}
          </pre>
        )}
        {result && (
          <article className="prose prose-sm max-w-none break-words dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.raw}</ReactMarkdown>
          </article>
        )}
      </div>
    </section>
  );
}
