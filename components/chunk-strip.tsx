import type { ChunkState } from "@/lib/types";

interface Props {
  chunks: ChunkState[] | undefined;
}

export function ChunkStrip({ chunks }: Props) {
  if (!chunks || chunks.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="text-xs text-gray-500 mb-1">
        Upload progress ({chunks.filter((c) => c.status === "done").length}/{chunks.length} chunks)
      </div>
      <div className="flex gap-1 flex-wrap">
        {chunks.map((c) => (
          <div
            key={c.idx}
            title={`pages ${c.page_range[0]}-${c.page_range[1]} · ${c.status}${c.error ? ` · ${c.error}` : ""}`}
            className={`px-2 py-1 text-xs rounded border ${
              c.status === "done"
                ? "bg-green-50 border-green-300 text-green-800"
                : c.status === "failed"
                ? "bg-red-50 border-red-300 text-red-800"
                : c.status === "running"
                ? "bg-amber-50 border-amber-300 text-amber-800"
                : "bg-gray-50 border-gray-300 text-gray-600"
            }`}
          >
            {c.page_range[0]}–{c.page_range[1]}
          </div>
        ))}
      </div>
    </div>
  );
}
