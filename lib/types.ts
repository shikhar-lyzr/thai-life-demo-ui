export type StageName = "upload" | "classification" | "extraction" | "summarisation";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type AgentLabel = "classification" | "extraction" | "summarisation";

export interface ChunkState {
  /** 0-indexed position in the chunks array. */
  idx: number;
  status: StageStatus;
  /** 1-indexed inclusive [start, end] page range in the source PDF. */
  page_range: [number, number];
  /** Set once the chunk finishes uploading. */
  asset_id?: string;
  /** Wall-clock for the upload of this chunk (after retries). */
  elapsed_ms?: number;
  /** Populated if the chunk's upload failed after all retries. */
  error?: string;
}

export interface StageState {
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  elapsed_ms?: number;
  /** Fast path (≤CHUNK_SIZE-page PDF): single asset_id. */
  asset_id?: string;
  /** Chunked path (>CHUNK_SIZE-page PDF): one asset_id per chunk, in chunk order. */
  asset_ids?: string[];
  /** Chunked path: per-chunk progress for UI rendering. */
  chunks?: ChunkState[];
  error?: string;
}

export interface AgentResult {
  raw: string;
  agent: AgentLabel;
}

export interface JobState {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  file_name: string;
  created_at: number;
  stages: Record<StageName, StageState>;
  results: Partial<Record<AgentLabel, AgentResult>>;
  error?: { stage: StageName; message: string };
}

export interface AgentConfig {
  agent_id: string;
  user_id: string;
  message: string;
  label: AgentLabel;
}

export const AGENTS: AgentConfig[] = [
  {
    agent_id: "69f377c87045b738bc045749",
    user_id: "1af38f4d-145c-4c47-9f78-736aa203e485",
    message: "Classify the uploaded document(s).",
    label: "classification",
  },
  {
    agent_id: "69f37dc6577450ec8542003b",
    user_id: "80507ff4-6a59-436b-babf-6de0fdf93cba",
    message: "Extract all required fields from the bundle.",
    label: "extraction",
  },
  {
    agent_id: "69f380b2180bca7eef235036",
    user_id: "fea3f4d7-90ef-4495-865c-be1a52628799",
    message: "Produce a six-section underwriter brief.",
    label: "summarisation",
  },
];
