/**
 * Reading a credit card statement PDF in the browser.
 *
 * A statement PDF has a text layer: the rows are real text, positioned on the
 * page rather than laid out as lines. Extracting it means taking the positioned
 * items, grouping them by their y coordinate into rows, and sorting each row by
 * x — which is what turns a scatter of fragments back into
 * "07 AUG  MONEYSEND …  (259.28)".
 *
 * This runs entirely in your browser. The file is never uploaded: only the
 * lines you go on to import are sent, and only to your own Worker.
 */

export interface PdfPage {
  page: number;
  lines: string[];
}

/** Items within this many points of each other belong to the same row. */
const ROW_TOLERANCE = 3;

export interface TextItem {
  str: string;
  x: number;
  y: number;
}

/**
 * Positioned fragments back into lines: group by y, read left to right, top of
 * the page first. Pure, so it can be exercised without a browser.
 */
export function linesFromItems(items: TextItem[]): string[] {
  const rows: { y: number; items: TextItem[] }[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.y - item.y) <= ROW_TOLERANCE);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  // PDF y grows upward, so the top of the page is the highest y.
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

export async function extractPdfLines(file: File | ArrayBuffer): Promise<PdfPage[]> {
  // Loaded on demand: it is by far the largest dependency here, and most
  // sessions never open a statement.
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;

  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    // Each item carries a transform; index 5 is its y, index 4 its x.
    const items = content.items
      .filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i && 'transform' in i)
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }))
      .filter((i) => i.str.trim() !== '');

    pages.push({ page: n, lines: linesFromItems(items) });
    page.cleanup();
  }
  await task.destroy();
  return pages;
}
