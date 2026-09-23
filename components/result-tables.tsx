"use client";

import { Component, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentLabel } from "@/lib/types";
import type { AgentJson } from "@/lib/agent-json";

type Obj = Record<string, unknown>;

const TH =
  "border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800";
const TD = "border-b border-slate-100 px-3 py-2 align-top dark:border-slate-900";

const TOKENS: Record<string, string> = {
  id: "ID",
  hn: "HN",
  icd10: "ICD-10",
  be: "(BE)",
  ad: "(AD)",
  th: "(TH)",
  en: "(EN)",
  mrz: "MRZ",
  an: "(AN)",
  no: "No.",
};

function humanize(key: string): string {
  const s = key
    .split("_")
    .filter(Boolean)
    .map((w) => TOKENS[w.toLowerCase()] ?? w)
    .join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function text(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Confidence({ value }: { value: unknown }) {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    return <span className="text-slate-400">—</span>;
  }
  const cls =
    n >= 0.9
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
      : n >= 0.75
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
        : n > 0
          ? "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300"
          : "bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${cls}`}>{Math.round(n * 100)}%</span>;
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "muted"; children: ReactNode }) {
  const cls = {
    ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    warn: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    muted: "bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400",
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function FieldValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isObj)) return <ObjectTable rows={value} compact />;
    return <>{value.map(text).join(", ")}</>;
  }
  return <>{text(value)}</>;
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function ClassificationTable({ data }: { data: Obj }) {
  const pages = Array.isArray(data.pages) ? data.pages.filter(isObj) : [];
  const flagged = pages.filter((p) => p.flag_for_review === true).length;
  const types = Array.isArray(data.distinct_document_types) ? data.distinct_document_types.length : "—";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Pages" value={text(data.page_count)} />
        <Stat label="Document types" value={types} />
        <Stat label="Overall confidence" value={<Confidence value={data.overall_confidence} />} />
        <Stat
          label="Underwriter review"
          value={flagged > 0 ? <Badge tone="warn">{flagged} page{flagged > 1 ? "s" : ""} flagged</Badge> : <Badge tone="ok">Not required</Badge>}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Page</th>
              <th className={TH}>Document</th>
              <th className={TH}>Language</th>
              <th className={TH}>Confidence</th>
              <th className={TH}>Review</th>
              <th className={TH}>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p, i) => (
              <tr key={i}>
                <td className={`${TD} tabular-nums`}>{text(p.page_number)}</td>
                <td className={TD}>
                  <div className="font-medium">{text(p.specific_document_name)}</div>
                  <div className="text-xs text-slate-500">{text(p.document_type)}</div>
                </td>
                <td className={TD}>{text(p.language)}</td>
                <td className={TD}>
                  <Confidence value={p.confidence_score} />
                </td>
                <td className={TD}>
                  {p.flag_for_review === true ? (
                    <div className="space-y-1">
                      <Badge tone="warn">Review</Badge>
                      {typeof p.review_reason === "string" && <div className="text-xs text-slate-500">{p.review_reason}</div>}
                    </div>
                  ) : (
                    <Badge tone="ok">OK</Badge>
                  )}
                </td>
                <td className={`${TD} text-slate-600 dark:text-slate-300`}>{text(p.reasoning)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExtractionTables({ data }: { data: Obj }) {
  const docs = Array.isArray(data.documents) ? data.documents.filter(isObj) : isObj(data.fields_with_confidence) ? [data] : [];
  return (
    <div className="space-y-4">
      {docs.map((doc, i) => {
        const fields = isObj(doc.fields_with_confidence) ? Object.entries(doc.fields_with_confidence) : [];
        const missing = fields.filter(([, f]) => isObj(f) && typeof f.reason_code === "string").length;
        const low = Array.isArray(doc.low_confidence_fields) ? doc.low_confidence_fields.filter(isObj) : [];
        return (
          <details key={i} open={i === 0} className="rounded-lg border border-slate-200 dark:border-slate-800">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
              {text(doc.document_type)}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {fields.length - missing} fields extracted{missing > 0 ? `, ${missing} missing` : ""}
              </span>
            </summary>
            <div className="overflow-x-auto px-1 pb-2">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Field</th>
                    <th className={TH}>Value</th>
                    <th className={TH}>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(([key, f]) => {
                    const field = isObj(f) ? f : { value: f };
                    const reason = typeof field.reason_code === "string" ? field.reason_code : null;
                    return (
                      <tr key={key} className={reason ? "text-slate-400" : undefined}>
                        <td className={`${TD} whitespace-nowrap text-slate-600 dark:text-slate-300`}>{humanize(key)}</td>
                        <td className={TD}>{reason ? <Badge tone="muted">{humanize(reason.toLowerCase())}</Badge> : <FieldValue value={field.value} />}</td>
                        <td className={TD}>{reason ? null : <Confidence value={field.confidence} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {low.length > 0 && (
                <div className="mt-2 px-2 text-xs text-slate-500">
                  <div className="font-semibold">Low-confidence fields</div>
                  <ul className="list-disc pl-5">
                    {low.map((l, j) => (
                      <li key={j}>
                        {humanize(text(l.field))} ({Math.round(Number(l.confidence) * 100)}%): {text(l.concern)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ObjectTable({ rows, compact = false }: { rows: Obj[]; compact?: boolean }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const th = compact ? `${TH} px-2 py-1` : TH;
  const td = compact ? `${TD} px-2 py-1` : TD;
  return (
    <div className="overflow-x-auto">
      <table className={compact ? "w-full text-xs" : "w-full text-sm"}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className={th}>
                {humanize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={td}>
                  {text(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionBody({ value }: { value: unknown }) {
  if (typeof value === "string") return <Markdown>{value}</Markdown>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-slate-400">None documented.</p>;
    if (value.every(isObj)) return <ObjectTable rows={value} />;
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {value.map((v, i) => (
          <li key={i}>{text(v)}</li>
        ))}
      </ol>
    );
  }
  if (isObj(value)) {
    return (
      <table className="w-full text-sm">
        <tbody>
          {Object.entries(value).map(([k, v]) => (
            <tr key={k}>
              <td className={`${TD} w-48 font-medium text-slate-600 dark:text-slate-300`}>{humanize(k)}</td>
              <td className={TD}>{typeof v === "string" ? <Markdown>{v}</Markdown> : text(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <p className="text-sm">{text(value)}</p>;
}

const APPLICANT_FIELDS: [string, string][] = [
  ["case_id", "Case ID"],
  ["applicant_name", "Applicant"],
  ["applicant_age", "Age"],
  ["applicant_id", "National ID"],
  ["applicant_address", "Address"],
];

function BriefView({ data }: { data: Obj }) {
  const identity = typeof data.identity_check_outcome === "string" ? data.identity_check_outcome : null;
  const sections = Object.keys(data).filter((k) => /^section_\d+_/.test(k));
  return (
    <div className="space-y-6">
      <table className="w-full text-sm">
        <tbody>
          {APPLICANT_FIELDS.map(([k, label]) => (
            <tr key={k}>
              <td className={`${TD} w-48 font-medium text-slate-600 dark:text-slate-300`}>{label}</td>
              <td className={TD}>{text(data[k])}</td>
            </tr>
          ))}
          {identity && (
            <tr>
              <td className={`${TD} w-48 font-medium text-slate-600 dark:text-slate-300`}>Identity check</td>
              <td className={TD}>
                <Badge tone={identity === "consistent" ? "ok" : "warn"}>{humanize(identity)}</Badge>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {sections.map((key) => {
        const m = /^section_(\d+)_(.*)$/.exec(key);
        return (
          <div key={key}>
            <h3 className="mb-2 text-sm font-semibold">{m ? `${m[1]}. ${humanize(m[2])}` : humanize(key)}</h3>
            <SectionBody value={data[key]} />
          </div>
        );
      })}
    </div>
  );
}

/** Falls back to the raw agent output if a response has a shape the tables don't expect. */
class TableBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ResultTable({ kind, data, fallback }: { kind: AgentLabel; data: AgentJson; fallback: ReactNode }) {
  return (
    <TableBoundary fallback={fallback}>
      {kind === "classification" && <ClassificationTable data={data} />}
      {kind === "extraction" && <ExtractionTables data={data} />}
      {kind === "summarisation" && <BriefView data={data} />}
    </TableBoundary>
  );
}
