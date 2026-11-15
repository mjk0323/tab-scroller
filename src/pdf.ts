import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

/**
 * Render one page into `canvas` so that it is `cssWidth` CSS pixels wide,
 * at device-pixel-ratio resolution for crisp text.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  signal: { cancelled: boolean },
): Promise<void> {
  const page = await doc.getPage(pageNumber);
  if (signal.cancelled) return;
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const scale = (cssWidth / base.width) * dpr;
  const viewport = page.getViewport({ scale });

  // Render offscreen first so the visible canvas never flashes blank.
  const off = document.createElement('canvas');
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  const ctx = off.getContext('2d');
  if (!ctx) return;
  const task: RenderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await task.promise;
  } catch {
    return; // cancelled or failed; leave the old image in place
  }
  if (signal.cancelled) return;

  canvas.width = off.width;
  canvas.height = off.height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(off.height / off.width) * cssWidth}px`;
  canvas.getContext('2d')?.drawImage(off, 0, 0);
}
