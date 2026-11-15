import type { PDFDocumentProxy } from './pdf';
import type { PDFPageProxy } from 'pdfjs-dist';
import { splitChordText } from './music';

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
  bounds: number[]; // measure boundaries (barlines + staff edges), length = detected measures + 1
  measures: number; // measures in this staff (user can correct)
}

/** A fret number read from the PDF text layer, placed on a tab staff. */
export interface NoteMark {
  staff: number; // index into PageAnalysis.staves
  string: number; // 1 (high E) .. 6 (low E)
  fret: number;
  x: number;
}

/** A chord name printed on the page. */
export interface ChordLabel {
  text: string;
  x: number;
  y: number; // baseline
  size: number; // font size as a fraction of page height
  diagram: boolean; // a chord diagram is already printed under it
}

export interface PageAnalysis {
  staves: Staff[];
  notes: NoteMark[];
  labels: ChordLabel[];
  tempo: number | null;
  capo: number | null;
  aspect: number; // height / width
}

const ANALYSIS_WIDTH = 1200; // px — enough to see thin lines, cheap to scan
const DARK = 140; // luminance below this counts as ink

/** Render a page offscreen and turn it into a 0/1 ink mask. */
async function inkMask(page: PDFPageProxy) {
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
  const lum = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < ink.length; i++, j += 4) {
    const l = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    lum[i] = l;
    ink[i] = l < DARK ? 1 : 0;
  }
  return { ink, lum, W, H };
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
    bounds: bounds.map((b) => b / W),
    measures: Math.max(1, bounds.length - 1),
  };
}

/**
 * Is a chord-diagram grid printed just under a label?
 * A grid = several short horizontal lines AND several short vertical lines
 * (thin and often light grey, so a lighter ink threshold is used).
 */
function hasDiagramBelow(lum: Uint8Array, W: number, H: number, x: number, y: number, size: number): boolean {
  const fs = size * H;
  const x0 = Math.max(0, Math.floor(x * W - fs * 0.8));
  const x1 = Math.min(W - 1, Math.ceil(x * W + fs * 3.5));
  const y0 = Math.max(0, Math.floor(y * H + fs * 0.25));
  const y1 = Math.min(H - 1, Math.ceil(y * H + fs * 4));
  const faint = (px: number, py: number) => lum[py * W + px] < 200;

  const longest = (len: number, at: (i: number) => boolean) => {
    let run = 0;
    let best = 0;
    for (let i = 0; i < len; i++) {
      if (at(i)) best = Math.max(best, ++run);
      else run = 0;
    }
    return best;
  };
  const countGroups = (hits: boolean[]) => hits.filter((h, i) => h && !hits[i - 1]).length;

  const rows: boolean[] = [];
  for (let py = y0; py <= y1; py++) rows.push(longest(x1 - x0 + 1, (i) => faint(x0 + i, py)) >= fs * 1.4);
  const cols: boolean[] = [];
  for (let px = x0; px <= x1; px++) cols.push(longest(y1 - y0 + 1, (i) => faint(px, y0 + i)) >= fs * 1.0);
  const nRows = countGroups(rows);
  const nCols = countGroups(cols);
  // a staff has long rows but at most a barline or two of columns
  return nRows >= 3 && nRows <= 8 && nCols >= 4;
}

interface TextBit {
  str: string;
  font: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

async function readText(page: PDFPageProxy): Promise<TextBit[]> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out: TextBit[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const t = it.transform;
    const [x, y] = vp.convertToViewportPoint(t[4], t[5]);
    out.push({
      str: it.str,
      font: it.fontName,
      x: x / vp.width,
      y: y / vp.height,
      w: it.width / vp.width,
      size: Math.hypot(t[2], t[3]) / vp.height,
    });
  }
  return out;
}

export async function analyzePage(doc: PDFDocumentProxy, pageNumber: number): Promise<PageAnalysis> {
  const page = await doc.getPage(pageNumber);
  const { ink, lum, W, H } = await inkMask(page);
  const staves = groupStaves(findHorizontalLines(ink, W, H), H).map((g) => analyzeStaff(ink, W, H, g));
  const text = await readText(page).catch(() => [] as TextBit[]);

  /* fret numbers sitting on a tab staff */
  const notes: NoteMark[] = [];
  for (const t of text) {
    const m = /^\(?(\d{1,2})\)?$/.exec(t.str.trim());
    if (!m) continue;
    const cy = t.y - t.size * 0.35; // glyph centre is above the baseline
    staves.forEach((s, si) => {
      if (s.lines !== 6) return;
      const sp = (s.bottom - s.top) / 5;
      const k = (cy - s.top) / sp;
      const string = Math.round(k);
      if (string < 0 || string > 5 || Math.abs(k - string) > 0.4) return;
      if (t.x < s.left - 0.01 || t.x > s.right + 0.01) return;
      notes.push({ staff: si, string: string + 1, fret: Number(m[1]), x: t.x + t.w / 2 });
    });
  }

  /* chord names — only from fonts that are mostly chord names */
  const byFont = new Map<string, TextBit[]>();
  for (const t of text) byFont.set(t.font, [...(byFont.get(t.font) ?? []), t]);
  const labels: ChordLabel[] = [];
  for (const items of byFont.values()) {
    const parsed = items.map((t) => ({ t, chords: splitChordText(t.str) }));
    const ok = parsed.filter((p) => p.chords);
    if (ok.length < 3 || ok.length / parsed.length < 0.7) continue;
    for (const { t, chords } of ok) {
      const len = Math.max(1, t.str.length);
      for (const c of chords!) {
        const x = t.x + (t.w * c.offset) / len;
        labels.push({ text: c.text, x, y: t.y, size: t.size, diagram: hasDiagramBelow(lum, W, H, x, t.y, t.size) });
      }
    }
  }
  // labels inside a staff are fingerings / numbers, not chord names
  const inStaff = (l: ChordLabel) => staves.some((s) => l.y > s.top - 0.002 && l.y - l.size < s.bottom + 0.002);
  const chordLabels = labels.filter((l) => !inStaff(l));

  /* tempo (♩ = 124) and capo */
  let tempo: number | null = null;
  let capo: number | null = null;
  for (const t of text) {
    const tm = /=\s*(\d{2,3})(?!\d)/.exec(t.str);
    if (tempo === null && tm && +tm[1] >= 30 && +tm[1] <= 300) tempo = +tm[1];
    const cm = /capo\.?\s*(?:fret)?\s*(\d{1,2})/i.exec(t.str);
    if (capo === null && cm) capo = +cm[1];
  }

  return { staves, notes, labels: chordLabels, tempo, capo, aspect: H / W };
}

/** Which staves drive the timing: tab staves if the score has any, otherwise standard staves. */
export function pickSystemLines(pages: PageAnalysis[]): number {
  return pages.some((p) => p.staves.some((s) => s.lines === 6)) ? 6 : 5;
}
