import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { countPages, splitPdfWithOverlap, mapWithConcurrency } from "../pdf";

const SCENE3 = resolve(__dirname, "../../Scene_3.pdf");

describe("countPages", () => {
  it("returns 8 for Scene_3.pdf", async () => {
    const buf = readFileSync(SCENE3);
    await expect(countPages(buf)).resolves.toBe(8);
  });

  it("returns 1 for a single-page PDF buffer", async () => {
    // Use pdf-lib to construct a single-page PDF inline so the test doesn't depend on a fixture
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const buf = Buffer.from(await doc.save());
    expect(await countPages(buf)).toBe(1);
  });

  it("returns 5 for a five-page synthetic PDF", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
    const buf = Buffer.from(await doc.save());
    expect(await countPages(buf)).toBe(5);
  });
});

async function makePdf(n: number): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe("splitPdfWithOverlap", () => {

  it("returns one chunk for an 8-page PDF when chunkSize=10", async () => {
    const buf = await makePdf(8);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(1);
    expect(await countPages(chunks[0].buffer)).toBe(8);
    expect(chunks[0].pageRange).toEqual([1, 8]);
  });

  it("returns one chunk for a 10-page PDF when chunkSize=10", async () => {
    const buf = await makePdf(10);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(1);
    expect(await countPages(chunks[0].buffer)).toBe(10);
    expect(chunks[0].pageRange).toEqual([1, 10]);
  });

  it("returns two chunks for an 11-page PDF, second chunk overlaps last 2 pages of first", async () => {
    const buf = await makePdf(11);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 11]);
    expect(await countPages(chunks[0].buffer)).toBe(10);
    expect(await countPages(chunks[1].buffer)).toBe(3);
  });

  it("returns two chunks for an 18-page PDF (clean boundary)", async () => {
    const buf = await makePdf(18);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 18]);
  });

  it("returns three chunks for a 19-page PDF", async () => {
    const buf = await makePdf(19);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[1].pageRange).toEqual([9, 18]);
    expect(chunks[2].pageRange).toEqual([17, 19]);
  });

  it("returns 21 chunks for a 169-page PDF (Scene_5 size)", async () => {
    const buf = await makePdf(169);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(21);
    expect(chunks[0].pageRange).toEqual([1, 10]);
    expect(chunks[20].pageRange).toEqual([161, 169]);
  });

  it("does not emit a chunk that would be entirely overlap with the previous", async () => {
    // 17 pages with chunkSize=10, overlap=2 should NOT produce a 3rd chunk of only [17, 17]
    const buf = await makePdf(17);
    const chunks = await splitPdfWithOverlap(buf, 10, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].pageRange).toEqual([9, 17]);
  });

  it("throws if chunkSize <= overlap", async () => {
    const buf = await makePdf(20);
    await expect(splitPdfWithOverlap(buf, 2, 2)).rejects.toThrow(/chunkSize must be greater than overlap/i);
  });
});

describe("mapWithConcurrency", () => {
  it("returns results in input order even when fn completes out of order", async () => {
    const items = [100, 50, 200, 10, 150];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([200, 100, 400, 20, 300]);
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it("propagates the first rejection without awaiting in-flight tasks past their next checkpoint", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("kaboom");
        await new Promise((r) => setTimeout(r, 5));
        return n;
      })
    ).rejects.toThrow("kaboom");
  });

  it("handles empty input", async () => {
    const results = await mapWithConcurrency<number, number>([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  it("passes item index to fn", async () => {
    const items = ["a", "b", "c"];
    const results = await mapWithConcurrency(items, 2, async (item, idx) => `${item}-${idx}`);
    expect(results).toEqual(["a-0", "b-1", "c-2"]);
  });
});
