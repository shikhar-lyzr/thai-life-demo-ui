import { PDFDocument } from "pdf-lib";

/**
 * Returns the number of pages in a PDF buffer.
 * Loads the PDF into memory once via pdf-lib's parser.
 */
export async function countPages(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

export interface PdfChunk {
  /** 1-indexed inclusive page range in the source PDF. */
  pageRange: [number, number];
  /** Bytes of a freshly-built PDF containing only those pages. */
  buffer: Buffer;
}

/**
 * Splits a PDF into overlapping chunks. Each chunk has up to chunkSize pages.
 * Chunk i (i>=2) starts `overlap` pages before chunk i-1 ends — meaning
 * chunk i-1's last `overlap` pages are repeated at the start of chunk i.
 *
 * Effective new pages per chunk = chunkSize - overlap.
 *
 * If totalPages <= chunkSize, returns a single chunk covering the whole PDF
 * (a verbatim re-serialization, NOT the original bytes).
 *
 * Chunks that would consist entirely of overlap (no new pages vs the
 * previous chunk) are not emitted.
 */
export async function splitPdfWithOverlap(
  buffer: Buffer,
  chunkSize: number,
  overlap: number
): Promise<PdfChunk[]> {
  if (chunkSize <= overlap) {
    throw new Error(`chunkSize must be greater than overlap (got chunkSize=${chunkSize}, overlap=${overlap})`);
  }

  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = src.getPageCount();
  if (totalPages === 0) return [];

  const stride = chunkSize - overlap;
  const chunks: PdfChunk[] = [];

  for (let i = 0; ; i++) {
    const start = i * stride + 1;             // 1-indexed
    const end = Math.min(start + chunkSize - 1, totalPages);
    if (start > totalPages) break;

    // Skip chunks that would be entirely overlap with the previous chunk.
    // Chunk i>=1 has new pages starting at `start + overlap`. If that's
    // already past totalPages, every page in this chunk is repeated content
    // from the previous chunk — don't emit it.
    if (i >= 1 && start + overlap > totalPages) break;

    const dst = await PDFDocument.create();
    const indices: number[] = [];
    for (let p = start; p <= end; p++) indices.push(p - 1); // pdf-lib uses 0-indexed
    const copied = await dst.copyPages(src, indices);
    for (const page of copied) dst.addPage(page);

    chunks.push({
      pageRange: [start, end],
      buffer: Buffer.from(await dst.save()),
    });
  }

  return chunks;
}

/**
 * Runs `fn(item, idx)` for each item with at most `limit` in flight at any time.
 * Returns results in the input order. Rejects on the first error.
 *
 * Note: when fn throws, in-flight tasks continue to run to their natural
 * completion (their results are discarded); we just don't await any further
 * unstarted items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (limit < 1) throw new Error(`limit must be >= 1 (got ${limit})`);
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  let aborted = false;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      if (aborted) return;
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
