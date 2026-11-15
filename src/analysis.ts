import type { PDFDocumentProxy } from './pdf';

/**
 * One detected staff (5-line standard notation or 6-line guitar tab).
 * All coordinates are fractions of the page (0..1) so they survive zoom.
 */
export interface Staff {
  lines: number; // 5 or 6
  top: number; // y of first line
  bottom: number; // y of last line
  left: number; // x where the staff lines start
  right: number; // x where the staff lines end
  bars: number[]; // x of each detected barline
  measures: number; // measures in this staff (user can correct)
}

export interface PageAnalysis {
  staves: Staff[];
}

const ANALYSIS_WIDTH = 1200; // px — enough to see thin lines, cheap to scan
const DARK = 140; // luminance below this counts as ink

/** Render a page offscreen and turn it into a 0/1 ink mask. */
async function inkMask(doc: PDFDocumentProxy, pageNumber: number) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: ANALYSIS_WIDTH / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const { width: W, height: H } = canvas;
  const px = ctx.getImageData(0, 0, W, H).data;
  const ink = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < ink.length; i++, j += 4) {
    const lum = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    ink[i] = lum < DARK ? 1 : 0;
  }
  return { ink, W, H };
}

interface Line {
  y0: number;
  y1: number;
  y: number; // center
}

/** Rows that are mostly ink across the page are candidate staff lines. */
function findHorizontalLines(ink: Uint8Array, W: number, H: number): Line[] {
  const lines: Line[] = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    let isLine = false;
    if (y < H) {
      let n = 0;
      const row = y * W;
      for (let x = 0; x < W; x++) n += ink[row + x];
      isLine = n / W > 0.35;
    }
    if (isLine && start < 0) start = y;
    if (!isLine && start >= 0) {
      if (y - start <= 6) lines.push({ y0: start, y1: y - 1, y: (start + y - 1) / 2 });
      start = -1;
    }
  }
  return lines;
}

/** Group evenly spaced lines into staves of 5 or 6 lines. */
function groupStaves(lines: Line[], H: number): Line[][] {
  const groups: Line[][] = [];
  let cur: Line[] = [];
  const flush = () => {
    if (cur.length === 5 || cur.length === 6) groups.push(cur);
    cur = [];
  };
  for (const ln of lines) {
    if (cur.length === 0) {
      cur.push(ln);
      continue;
    }
    const gap = ln.y - cur[cur.length - 1].y;
    if (cur.length === 1) {
      if (gap > 2 && gap < H * 0.025) cur.push(ln);
      else cur = [ln];
      continue;
    }
    const avg = (cur[cur.length - 1].y - cur[0].y) / (cur.length - 1);
    if (Math.abs(gap - avg) <= Math.max(2, avg * 0.25)) {
      cur.push(ln);
    } else {
      flush();
      cur = [ln];
    }
  }
  flush();
  return groups;
}

/** Longest continuous ink run on a row → where the staff line starts/ends. */
function lineExtent(ink: Uint8Array, W: number, y: number): [number, number] {
  let best: [number, number] = [0, W - 1];
  let bestLen = 0;
  let s = -1;
  let gapRun = 0;
  const row = Math.round(y) * W;
  for (let x = 0; x <= W; x++) {
    const on = x < W && ink[row + x] === 1;
    if (on) {
      if (s < 0) s = x;
      gapRun = 0;
    } else if (s >= 0) {
      // tolerate small breaks (fret numbers are often drawn over the line)
      if (++gapRun > 40 || x === W) {
        const end = x - gapRun;
        if (end - s > bestLen) {
          bestLen = end - s;
          best = [s, end];
        }
        s = -1;
        gapRun = 0;
      }
    }
  }
  return best;
}

const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

function analyzeStaff(ink: Uint8Array, W: number, H: number, ls: Line[]): Staff {
  const extents = ls.map((l) => lineExtent(ink, W, l.y));
  const left = median(extents.map((e) => e[0]));
  const right = median(extents.map((e) => e[1]));
  const y0 = ls[0].y0;
  const y1 = ls[ls.length - 1].y1;
  const span = y1 - y0 + 1;

  // A barline is a column that is ink from the top line to the bottom line.
  const cols: number[] = [];
  for (let x = Math.max(0, left - 3); x <= Math.min(W - 1, right + 3); x++) {
    let n = 0;
    for (let y = y0; y <= y1; y++) n += ink[y * W + x];
    if (n / span >= 0.9) cols.push(x);
  }
  // merge adjacent columns, and double / thick-thin bars that sit close together
  const mergeDist = W * 0.012;
  const bars: number[] = [];
  let groupStart = -1;
  let prev = -1;
  for (const x of cols) {
    if (groupStart < 0) groupStart = x;
    else if (x - prev > mergeDist) {
      bars.push((groupStart + prev) / 2);
      groupStart = x;
    }
    prev = x;
  }
  if (groupStart >= 0) bars.push((groupStart + prev) / 2);

  // staff edges count as boundaries even when no barline is drawn there
  const tol = W * 0.02;
  const bounds = [...bars];
  if (!bounds.some((b) => Math.abs(b - left) < tol)) bounds.unshift(left);
  if (!bounds.some((b) => Math.abs(b - right) < tol)) bounds.push(right);

  return {
    lines: ls.length,
    top: ls[0].y / H,
    bottom: ls[ls.length - 1].y / H,
    left: left / W,
    right: right / W,
    bars: bars.map((b) => b / W),
    measures: Math.max(1, bounds.length - 1),
  };
}

export async function analyzePage(doc: PDFDocumentProxy, pageNumber: number): Promise<PageAnalysis> {
  const { ink, W, H } = await inkMask(doc, pageNumber);
  const groups = groupStaves(findHorizontalLines(ink, W, H), H);
  return { staves: groups.map((g) => analyzeStaff(ink, W, H, g)) };
}

/** Which staves drive the timing: tab staves if the score has any, otherwise standard staves. */
export function pickSystemLines(pages: PageAnalysis[]): number {
  return pages.some((p) => p.staves.some((s) => s.lines === 6)) ? 6 : 5;
}
