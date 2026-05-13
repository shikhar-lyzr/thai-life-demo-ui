import { PDFDocument } from "pdf-lib";

/**
 * Returns the number of pages in a PDF buffer.
 * Loads the PDF into memory once via pdf-lib's parser.
 */
export async function countPages(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}
