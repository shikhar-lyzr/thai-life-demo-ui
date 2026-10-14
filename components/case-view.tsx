"use client";

import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentLabel, JobState, StageState } from "@/lib/types";
import { extractAgentJson, type AgentJson } from "@/lib/agent-json";

type Obj = Record<string, unknown>;
type Lang = "en" | "th";
type Tab = "summary" | "documents" | "details" | "risk";

const TABS: { id: Tab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "documents", label: "Documents" },
  { id: "details", label: "Applicant details" },
  { id: "risk", label: "Medical & risk" },
];

const THAI = /[฀-๿]/;

const TOKENS: Record<string, string> = {
  id: "ID", hn: "HN", an: "AN", icd10: "ICD-10", be: "(BE)", ad: "(AD)", th: "(Thai)", en: "(English)", mrz: "MRZ", no: "No.",
};

function humanize(key: string): string {
  const s = key.split("_").filter(Boolean).map((w) => TOKENS[w.toLowerCase()] ?? w).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The brief is bilingual: Thai first, then "[English: ...]". List items use "Thai / English". */
function bilingual(text: string): { th: string; en: string } {
  const i = text.indexOf("[English:");
  if (i >= 0) {
    const th = text.slice(0, i).trim();
    let en = text.slice(i + "[English:".length).trim();
    if (en.endsWith("]")) en = en.slice(0, -1).trim();
    return { th: th || en, en: en || th };
  }
  const parts = text.split(" / ");
  if (parts.length === 2 && THAI.test(parts[0]) !== THAI.test(parts[1])) {
    const [a, b] = parts.map((p) => p.trim());
    return THAI.test(a) ? { th: a, en: b } : { th: b, en: a };
  }
  return { th: text, en: text };
}

function pick(v: unknown, lang: Lang): string {
  const s = str(v);
  return s ? bilingual(s)[lang] : "";
}

function pct(v: unknown): string {
  const n = num(v);
  return n === null ? "–" : `${Math.round(n * 100)}%`;
}

function confTone(v: unknown): "good" | "fair" | "low" | "none" {
  const n = num(v);
  if (n === null || n <= 0) return "none";
  return n >= 0.9 ? "good" : n >= 0.75 ? "fair" : "low";
}

const TONE_TEXT = {
  good: "text-emerald-700 dark:text-emerald-300",
  fair: "text-amber-700 dark:text-amber-300",
  low: "text-red-700 dark:text-red-300",
  none: "text-slate-400",
};
const TONE_BAR = {
  good: "bg-emerald-500",
  fair: "bg-amber-500",
  low: "bg-red-500",
  none: "bg-slate-300 dark:bg-slate-700",
};
const TONE_DOT = TONE_BAR;

function Pill({ tone, children }: { tone: "good" | "warn" | "bad" | "muted"; children: ReactNode }) {
  const cls = {
    good: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900",
    warn: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900",
    bad: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900",
    muted: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-800",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>{children}</span>;
}

function severityTone(s: string): "good" | "warn" | "bad" | "muted" {
  const v = s.toLowerCase();
  if (/(severe|critical|high|major)/.test(v)) return "bad";
  if (/(significant|moderate|medium)/.test(v)) return "warn";
  if (/(mild|low|minor)/.test(v)) return "good";
  return "muted";
}

function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950 ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

function Prose({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="prose prose-sm max-w-none break-words prose-p:my-2 prose-ul:my-2 dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function Waiting({ stage, what }: { stage: StageState; what: string }) {
  if (stage.status === "failed") {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        This step did not finish. {stage.error ?? ""}
      </p>
    );
  }
  if (stage.status === "done") {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
        This step finished, but its output could not be shown here. It is in the raw data at the bottom of the page.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
      <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
      {stage.status === "running" ? `${what}…` : `Waiting to start: ${what.toLowerCase()}`}
    </p>
  );
}

/** The classifier's review reasons cite its taxonomy. Say what it means for the reviewer instead. */
function plainReason(r: string): string {
  return /other\s*\/\s*unclassified/i.test(r) ? "Not one of the standard document categories, so a person should confirm it" : r;
}

/** Pages of one document share a name like "IPD Itemised Bill (page 2/3)". */
function documentName(page: Obj): string {
  return str(page.specific_document_name).replace(/\s*\((?:page\s*)?\d+\s*(?:\/|of)\s*\d+\)\s*$/i, "").trim() || str(page.document_type);
}

interface DocGroup {
  name: string;
  type: string;
  pages: number[];
  confidence: number | null;
  flagged: boolean;
  reasons: string[];
  reasoning: string;
}

function groupPages(pages: Obj[]): DocGroup[] {
  const groups = new Map<string, DocGroup>();
  for (const p of pages) {
    const name = documentName(p);
    const g = groups.get(name) ?? { name, type: str(p.document_type), pages: [], confidence: null, flagged: false, reasons: [], reasoning: str(p.reasoning) };
    const n = num(p.page_number);
    if (n !== null) g.pages.push(n);
    const c = num(p.confidence_score);
    if (c !== null) g.confidence = g.confidence === null ? c : Math.min(g.confidence, c);
    if (p.flag_for_review === true) {
      g.flagged = true;
      const r = plainReason(str(p.review_reason));
      if (r && !g.reasons.includes(r)) g.reasons.push(r);
    }
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
}

function useAgent(job: JobState, label: AgentLabel): AgentJson | null {
  const raw = job.results[label]?.raw;
  return useMemo(() => (raw ? extractAgentJson(raw) : null), [raw]);
}

function ConfidenceBar({ value }: { value: unknown }) {
  const n = num(value);
  const tone = confTone(value);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${Math.round((n ?? 0) * 100)}%` }} />
      </div>
      <span className={`text-xs font-medium tabular-nums ${TONE_TEXT[tone]}`}>{pct(value)}</span>
    </div>
  );
}

function FieldValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const rows = value.filter(isObj);
    if (rows.length && rows.length === value.length) {
      const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      return (
        <div className="mt-1 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900">
              <tr>{cols.map((c) => <th key={c} className="px-2 py-1.5 text-left font-medium">{humanize(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  {cols.map((c) => <td key={c} className="px-2 py-1.5 align-top">{str(r[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <>{value.map(str).join(", ")}</>;
  }
  return <>{str(value) || "–"}</>;
}

export function CaseView({ job }: { job: JobState }) {
  const [tab, setTab] = useState<Tab>("summary");
  const [lang, setLang] = useState<Lang>("en");

  const cls = useAgent(job, "classification");
  const ext = useAgent(job, "extraction");
  const brief = useAgent(job, "summarisation");
  const st = job.stages;

  const pages = useMemo(() => list(cls?.pages).filter(isObj), [cls]);
  const groups = useMemo(() => groupPages(pages), [pages]);
  const docs = useMemo(
    () => (Array.isArray(ext?.documents) ? ext.documents.filter(isObj) : isObj(ext?.fields_with_confidence) ? [ext as Obj] : []),
    [ext],
  );
  const lowFields = useMemo(
    () =>
      docs.flatMap((d) =>
        list(d.low_confidence_fields)
          .filter(isObj)
          .filter((l) => (num(l.confidence) ?? 0) < 0.9)
          .map((l): Obj & { doc: string } => ({ ...l, doc: str(d.document_type) })),
      ),
    [docs],
  );
  const flaggedGroups = groups.filter((g) => g.flagged);
  const identity = str(brief?.identity_check_outcome);
  const identityOk = identity === "consistent";
  const reviewCount = flaggedGroups.length + lowFields.length + (identity && !identityOk ? 1 : 0);

  // Applicant: the brief when it has landed, otherwise the ID card fields from extraction.
  const idCard = docs.find((d) => /national id|id card|บัตรประจำตัว/i.test(str(d.document_type)));
  const idf = isObj(idCard?.fields_with_confidence) ? (idCard!.fields_with_confidence as Obj) : {};
  const fv = (k: string) => (isObj(idf[k]) ? str((idf[k] as Obj).value) : "");
  const applicant = {
    name: str(brief?.applicant_name) || [fv("name_en"), fv("surname_en")].filter(Boolean).join(" "),
    id: str(brief?.applicant_id) || fv("id_no"),
    age: str(brief?.applicant_age),
    address: str(brief?.applicant_address) || fv("address"),
  };

  const steps = list(brief?.section_6_suggested_considerations).map(str).filter(Boolean);
  const conditions = list(brief?.section_4_severity_sorted_diseases).filter(isObj);
  const history = list(brief?.section_2_key_diseases).filter(isObj);
  const commentary = isObj(brief?.section_5_analytical_commentary) ? (brief!.section_5_analytical_commentary as Obj) : {};

  return (
    <div className="flex flex-col gap-6">
      {/* Applicant + headline numbers */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Applicant</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {applicant.name || <span className="text-slate-400">Identifying the applicant…</span>}
            </h2>
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
              {applicant.id && <div><dt className="text-slate-500">National ID</dt><dd className="font-medium tabular-nums">{applicant.id}</dd></div>}
              {applicant.age && <div><dt className="text-slate-500">Age</dt><dd className="font-medium">{applicant.age}</dd></div>}
              {applicant.address && <div className="max-w-md"><dt className="text-slate-500">Address</dt><dd className="font-medium">{applicant.address}</dd></div>}
            </dl>
          </div>
          {identity && (
            <Pill tone={identityOk ? "good" : "warn"}>{identityOk ? "Identity consistent across documents" : humanize(identity)}</Pill>
          )}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Pages read", value: str(cls?.page_count) || (pages.length ? String(pages.length) : ""), stage: st.classification },
            { label: "Documents found", value: groups.length ? String(groups.length) : docs.length ? String(docs.length) : "", stage: st.classification },
            { label: "Overall confidence", value: cls ? pct(cls.overall_confidence) : "", stage: st.classification },
            { label: "Items to review", value: cls || ext ? String(reviewCount) : "", stage: st.classification },
          ].map((k) => (
            <div key={k.label} className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-900">
              <div className="text-xs text-slate-500">{k.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {k.value || <span className="text-base font-normal text-slate-400">{k.stage.status === "failed" ? "Not available" : "…"}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800">
        <div role="tablist" className="-mb-px flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium ${
                tab === t.id
                  ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex overflow-hidden rounded-lg border border-slate-300 text-xs dark:border-slate-700" aria-label="Language">
          {([["en", "English"], ["th", "ไทย"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setLang(id)}
              aria-pressed={lang === id}
              className={`px-3 py-1.5 ${lang === id ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "hover:bg-slate-50 dark:hover:bg-slate-900"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div role="tabpanel" hidden={tab !== "summary"} className="flex flex-col gap-5">
        {brief ? (
          <>
            <Card title="Overview">
              <Prose text={pick(brief.section_1_overview, lang)} />
            </Card>
            {conditions.length > 0 && (
              <Card title="Conditions found">
                <ul className="flex flex-wrap gap-2">
                  {conditions.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
                      <span>{pick(c.condition, lang)}</span>
                      {str(c.severity) && <Pill tone={severityTone(str(c.severity))}>{str(c.severity)}</Pill>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        ) : (
          <Waiting stage={st.summarisation} what="Writing the underwriter brief" />
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Recommended next steps">
            {steps.length ? (
              <ol className="flex flex-col gap-3">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">{i + 1}</span>
                    <span className="pt-0.5">{pick(s, lang)}</span>
                  </li>
                ))}
              </ol>
            ) : brief ? (
              <p className="text-sm text-slate-500">No further steps suggested.</p>
            ) : (
              <Waiting stage={st.summarisation} what="Writing the underwriter brief" />
            )}
          </Card>
          <Card title="Needs attention" aside={cls || ext ? <Pill tone={reviewCount ? "warn" : "good"}>{reviewCount ? `${reviewCount} items` : "Nothing flagged"}</Pill> : undefined}>
            {cls || ext ? (
              <ul className="flex flex-col divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {identity && !identityOk && (
                  <li className="py-2.5"><span className="font-medium">Identity check:</span> {humanize(identity)}</li>
                )}
                {flaggedGroups.map((g) => (
                  <li key={g.name} className="py-2.5">
                    <span className="font-medium">{g.name}</span>
                    <span className="text-slate-500"> · page {g.pages.join(", ")}</span>
                    {g.reasons.map((r) => <div key={r} className="text-slate-500">{r}</div>)}
                  </li>
                ))}
                {lowFields.map((l, i) => (
                  <li key={i} className="py-2.5">
                    <span className="font-medium">{humanize(str(l.field))}</span>
                    <span className="text-slate-500"> · {l.doc} · {pct(l.confidence)} sure</span>
                    {str(l.concern) && <div className="text-slate-500">{str(l.concern)}</div>}
                  </li>
                ))}
                {reviewCount === 0 && <li className="py-2.5 text-slate-500">Every page and field was read with high confidence.</li>}
              </ul>
            ) : (
              <Waiting stage={st.classification} what="Identifying documents" />
            )}
          </Card>
        </div>
      </div>

      {/* Documents */}
      <div role="tabpanel" hidden={tab !== "documents"}>
        {groups.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => (
              <Card key={g.name} title={g.name} aside={<Pill tone={g.flagged ? "warn" : "good"}>{g.flagged ? "Check" : "OK"}</Pill>}>
                <p className="text-xs text-slate-500">{g.type}</p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-600 dark:text-slate-300">
                    {g.pages.length === 1 ? `Page ${g.pages[0]}` : `Pages ${g.pages.join(", ")}`}
                  </span>
                  <ConfidenceBar value={g.confidence} />
                </div>
                {g.reasons.map((r) => (
                  <p key={r} className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{r}</p>
                ))}
                {g.reasoning && (
                  <details className="mt-3 text-xs text-slate-500">
                    <summary className="cursor-pointer select-none">Why this label</summary>
                    <p className="mt-1.5">{g.reasoning}</p>
                  </details>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Waiting stage={st.classification} what="Identifying documents" />
        )}
      </div>

      {/* Applicant details */}
      <div role="tabpanel" hidden={tab !== "details"} className="flex flex-col gap-4">
        {docs.length ? (
          docs.map((d, i) => {
            const fields = isObj(d.fields_with_confidence) ? Object.entries(d.fields_with_confidence as Obj) : [];
            const missing = fields.filter(([, f]) => isObj(f) && typeof f.reason_code === "string").map(([k]) => humanize(k));
            const found = fields.filter(([, f]) => !(isObj(f) && typeof f.reason_code === "string"));
            const concerns = new Map(list(d.low_confidence_fields).filter(isObj).map((l) => [str(l.field), str(l.concern)]));
            return (
              <details key={i} open={i === 0} className="group rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
                <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-5 py-4">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{str(d.document_type)}</span>
                  <span className="text-xs text-slate-500">
                    {found.length} details{missing.length ? ` · ${missing.length} not found` : ""}
                  </span>
                </summary>
                <div className="border-t border-slate-100 px-5 py-4 dark:border-slate-800">
                  <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                    {found.map(([k, f]) => {
                      const field = isObj(f) ? f : { value: f };
                      const concern = concerns.get(k);
                      const wide = Array.isArray(field.value);
                      return (
                        <div key={k} className={`${wide ? "sm:col-span-2" : ""} ${concern ? "border-l-2 border-amber-400 pl-3" : ""}`}>
                          <dt className="flex items-center gap-1.5 text-xs text-slate-500">
                            <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[confTone(field.confidence)]}`} title={`Confidence ${pct(field.confidence)}`} />
                            {humanize(k)}
                          </dt>
                          <dd className="mt-0.5 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
                            <FieldValue value={field.value} />
                          </dd>
                          {concern && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{concern}</p>}
                        </div>
                      );
                    })}
                  </dl>
                  {missing.length > 0 && (
                    <p className="mt-5 text-xs text-slate-500">
                      <span className="font-medium">Not found in this document:</span> {missing.join(", ")}
                    </p>
                  )}
                </div>
              </details>
            );
          })
        ) : (
          <Waiting stage={st.extraction} what="Extracting details" />
        )}
        {docs.length > 0 && (
          <p className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT.good}`} />90% sure or more</span>
            <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT.fair}`} />75 to 89%</span>
            <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT.low}`} />below 75%</span>
          </p>
        )}
      </div>

      {/* Medical & risk */}
      <div role="tabpanel" hidden={tab !== "risk"} className="flex flex-col gap-5">
        {brief ? (
          <>
            {(conditions.length > 0 || history.length > 0) && (
              <Card title="Medical history">
                <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
                  {(history.length ? history : conditions).map((h, i) => {
                    const sev = str(conditions[i]?.severity ?? h.severity);
                    const status = str(conditions[i]?.status ?? h.status);
                    return (
                      <div key={i} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{pick(h.diagnosis ?? h.condition, lang)}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {[pick(h.hospital, lang), str(h.treatment_date), str(h.type), str(h.icd10) && str(h.icd10) !== "—" ? `ICD-10 ${str(h.icd10)}` : ""].filter(Boolean).join(" · ")}
                          </p>
                          {status && <p className="mt-1 text-xs text-slate-500">Status: {status}</p>}
                        </div>
                        {sev && <Pill tone={severityTone(sev)}>{sev}</Pill>}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
            <Card title="Risk profile">
              <Prose text={pick(brief.section_3_risk_profile, lang)} />
            </Card>
            {Object.keys(commentary).length > 0 && (
              <div className="grid gap-4 md:grid-cols-2">
                {Object.entries(commentary).map(([k, v]) => (
                  <Card key={k} title={humanize(k)}>
                    <Prose text={pick(v, lang)} />
                  </Card>
                ))}
              </div>
            )}
          </>
        ) : (
          <Waiting stage={st.summarisation} what="Writing the underwriter brief" />
        )}
      </div>

      <RawData job={job} />
    </div>
  );
}

function RawData({ job }: { job: JobState }) {
  const items: { label: AgentLabel; title: string }[] = [
    { label: "classification", title: "Document classification" },
    { label: "extraction", title: "Extracted details" },
    { label: "summarisation", title: "Underwriter brief" },
  ];
  const ready = items.filter((i) => job.results[i.label]);
  if (!ready.length) return null;
  return (
    <details className="rounded-2xl border border-dashed border-slate-300 px-5 py-4 text-sm dark:border-slate-700">
      <summary className="cursor-pointer select-none text-slate-500">Raw data for system integration (JSON)</summary>
      <div className="mt-4 flex flex-col gap-4">
        {ready.map((i) => (
          <RawBlock key={i.label} title={i.title} raw={job.results[i.label]!.raw} />
        ))}
      </div>
    </details>
  );
}

function RawBlock({ title, raw }: { title: string; raw: string }) {
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => {
    const data = extractAgentJson(raw);
    return data ? JSON.stringify(data, null, 2) : raw;
  }, [raw]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{title}</span>
        <button onClick={copy} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed dark:bg-slate-900">{json}</pre>
    </div>
  );
}
