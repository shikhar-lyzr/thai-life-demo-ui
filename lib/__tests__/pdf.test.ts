import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { countPages } from "../pdf";

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
