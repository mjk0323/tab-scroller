import type { PDFDocumentProxy } from './pdf';
import type { PDFPageProxy } from 'pdfjs-dist';
import { splitChordText } from './music';

/**
 * One detected staff (5-line standard notation or 6-line guitar tab).
 * All coordinates are fractions of the page (0..1) so they survive zoom.
 */
export interface Staff {
  lines: number; // 5 or 6 for a staff; 0 for a row of a chord chart (boxes + lyrics, no staff)
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

/** A printed chord box (diagram grid), page fractions. */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PageAnalysis {
  staves: Staff[];
  notes: NoteMark[];
  labels: ChordLabel[];
  boxes: Box[]; // printed chord boxes (diagram grids)
  tempo: number | null;
  capo: number | null;
  aspect: number; // height / width
  needsOcr: boolean; // no text layer (scanned / image PDF): names and numbers must be read from pixels
}

export const emptyAnalysis = (): PageAnalysis => ({
  staves: [], notes: [], labels: [], boxes: [], tempo: null, capo: null, aspect: 1.414, needsOcr: false,
});

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
export function hasDiagramBelow(lum: Uint8Array, W: number, H: number, x: number, y: number, size: number): boolean {
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
  const detect = (mask: Uint8Array) =>
    groupStaves(findHorizontalLines(mask, W, H), H)
      .map((g) => analyzeStaff(mask, W, H, g))
      .filter(isRealStaff);
  let staves = detect(ink);
  if (!staves.length) {
    // Some exports (e.g. Songsterr) draw staff lines and barlines in light grey.
    const light = new Uint8Array(W * H);
    for (let i = 0; i < light.length; i++) light[i] = lum[i] < 230 ? 1 : 0;
    staves = detect(light);
  }
  const text = await readText(page).catch(() => [] as TextBit[]);

  // Printed chord boxes. With no staff at all the page is a chord chart
  // (rows of chord boxes with lyrics); otherwise they help OCR find chord names.
  const boxes = findChordBoxes(lum, W, H);
  if (!staves.length) staves.push(...chartRows(lum, W, H, boxes));

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

  return {
    staves,
    notes,
    labels: chordLabels,
    boxes: boxes.map((b) => ({ x0: b.x0 / W, x1: b.x1 / W, y0: b.y0 / H, y1: b.y1 / H })),
    tempo,
    capo,
    aspect: H / W,
    needsOcr: text.length === 0,
  };
}

/**
 * Rows of chord-box grids line up into what looks like a 6-line staff with a
 * "barline" at every fret. Real staves have a handful of wide measures.
 */
function isRealStaff(s: Staff): boolean {
  if (s.measures > 12) return false;
  const gaps = s.bounds.slice(1).map((b, i) => b - s.bounds[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  return !sorted.length || sorted[Math.floor(sorted.length / 2)] >= 0.03;
}

/* ------------------------------------------------------------------ */
/* Chord charts                                                        */
/* ------------------------------------------------------------------ */

interface PxBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Find chord-diagram grids by their fret/string lines: at least 4 thin vertical
 * lines of the same height, evenly spaced, also crossed by horizontal lines.
 * (Vertical lines are used because neighbouring boxes and open-string circles
 * make horizontal lines run into each other.)
 */
function findChordBoxes(lum: Uint8Array, W: number, H: number): PxBox[] {
  const faint = (x: number, y: number) => lum[y * W + x] < 200;
  const minH = H * 0.015;
  const maxH = H * 0.07;

  // 1. thin vertical lines: per-column runs, merged across adjacent columns
  interface VLine { x0: number; x1: number; y0: number; y1: number }
  const lines: VLine[] = [];
  let active: VLine[] = [];
  for (let x = 0; x < W; x++) {
    const next: VLine[] = [];
    let s = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && faint(x, y);
      if (on && s < 0) s = y;
      if (!on && s >= 0) {
        const y1 = y - 1;
        if (y1 - s >= minH && y1 - s <= maxH) {
          const prev = active.find((l) => Math.abs(l.y0 - s) <= 2 && Math.abs(l.y1 - y1) <= 2);
          if (prev) {
            prev.x1 = x;
            next.push(prev);
          } else {
            const l = { x0: x, x1: x, y0: s, y1 };
            lines.push(l);
            next.push(l);
          }
        }
        s = -1;
      }
    }
    active = next;
  }
  const thin = lines.filter((l) => l.x1 - l.x0 <= 4); // thick bars are measure separators, not grid lines

  // 2. evenly spaced lines of the same height form a grid
  thin.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const used = new Set<VLine>();
  const boxes: PxBox[] = [];
  for (const l of thin) {
    if (used.has(l)) continue;
    const same = thin
      .filter((o) => !used.has(o) && Math.abs(o.y0 - l.y0) <= 3 && Math.abs(o.y1 - l.y1) <= 3)
      .sort((a, b) => a.x0 - b.x0);
    // split into runs with consistent spacing
    let run: VLine[] = [];
    const flush = () => {
      if (run.length >= 4) {
        const x0 = run[0].x0;
        const x1 = run[run.length - 1].x1;
        const y0 = Math.min(...run.map((r) => r.y0));
        const y1 = Math.max(...run.map((r) => r.y1));
        if (horizontalLines(x0, x1, y0, y1) >= 4) {
          boxes.push({ x0, x1, y0, y1 });
          run.forEach((r) => used.add(r));
        }
      }
      run = [];
    };
    for (const o of same) {
      if (!run.length) {
        run.push(o);
        continue;
      }
      const d = o.x0 - run[run.length - 1].x0;
      const avg = run.length >= 2 ? (run[run.length - 1].x0 - run[0].x0) / (run.length - 1) : d;
      const okSpacing = d >= W * 0.005 && d <= W * 0.03 && Math.abs(d - avg) <= Math.max(2, avg * 0.25);
      if (okSpacing) run.push(o);
      else {
        flush();
        run.push(o);
      }
    }
    flush();
  }

  function horizontalLines(x0: number, x1: number, y0: number, y1: number): number {
    let count = 0;
    let prev = false;
    for (let y = y0; y <= y1; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) n += faint(x, y) ? 1 : 0;
      const hit = n >= (x1 - x0 + 1) * 0.85;
      if (hit && !prev) count++;
      prev = hit;
    }
    return count;
  }

  // Boxes printed edge to edge read as one wide grid: split them back into
  // boxes of the usual width for this page.
  if (!boxes.length) return boxes;
  const widths = boxes.map((b) => b.x1 - b.x0).sort((a, b) => a - b);
  const usual = widths[Math.floor(widths.length / 2)];
  const out: PxBox[] = [];
  for (const b of boxes) {
    const w = b.x1 - b.x0;
    const n = Math.round(w / (usual * 1.15));
    if (n < 2) {
      out.push(b);
      continue;
    }
    const step = (w - usual) / (n - 1);
    for (let k = 0; k < n; k++) {
      const x0 = Math.round(b.x0 + k * step);
      out.push({ x0, x1: Math.round(x0 + usual), y0: b.y0, y1: b.y1 });
    }
  }
  return out;
}

/**
 * Group chord boxes into rows. Each row becomes a pseudo-staff (lines = 0)
 * whose measures are separated by the thick bars printed between boxes.
 */
function chartRows(lum: Uint8Array, W: number, H: number, boxes: PxBox[]): Staff[] {
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: PxBox[][] = [];
  for (const b of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y0 - b.y0) < (b.y1 - b.y0) * 0.5);
    if (row) row.push(b);
    else rows.push([b]);
  }

  return rows.map((row) => {
    row.sort((a, b) => a.x0 - b.x0);
    const top = Math.min(...row.map((b) => b.y0));
    const bottom = Math.max(...row.map((b) => b.y1));
    const left = row[0].x0;
    const right = row[row.length - 1].x1;
    const h = bottom - top;

    // measure bars: tall dark columns between boxes
    const inBox = (x: number) => row.some((b) => x >= b.x0 - 3 && x <= b.x1 + 3);
    const bars: number[] = [];
    let run = -1;
    const scanFrom = Math.max(0, Math.floor(left - W * 0.05));
    const scanTo = Math.min(W - 1, Math.ceil(right + W * 0.05));
    for (let x = scanFrom; x <= scanTo + 1; x++) {
      let hit = false;
      if (x <= scanTo && !inBox(x)) {
        let n = 0;
        const ya = Math.floor(top + h * 0.15);
        const yb = Math.ceil(bottom - h * 0.15);
        for (let y = ya; y <= yb; y++) n += lum[y * W + x] < 160 ? 1 : 0;
        hit = n >= (yb - ya + 1) * 0.9;
      }
      if (hit && run < 0) run = x;
      if (!hit && run >= 0) {
        if (x - run >= 2) bars.push((run + x - 1) / 2);
        run = -1;
      }
    }

    // Measures: stretches between bars that contain boxes. Inside a stretch, boxes
    // packed tightly together share a measure; widely spaced ones get one each.
    const edges = [-Infinity, ...bars, Infinity];
    const starts: number[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const inside = row.filter((b) => b.x0 > edges[i] && b.x1 < edges[i + 1]);
      inside.forEach((b, j) => {
        const w = b.x1 - b.x0;
        if (j === 0 || b.x0 - inside[j - 1].x1 > w * 0.6) starts.push(b.x0);
      });
    }
    const bounds = [...starts, right];

    return {
      lines: 0,
      top: top / H,
      bottom: bottom / H,
      left: left / W,
      right: right / W,
      bars: bars.filter((x) => x > left && x < right).map((x) => x / W),
      bounds: bounds.map((x) => x / W),
      measures: Math.max(1, starts.length),
    };
  });
}

/** Which staves drive the timing: tab staves if the score has any, otherwise standard staves. */
export function pickSystemLines(pages: PageAnalysis[]): number {
  for (const n of [6, 5, 0]) if (pages.some((p) => p.staves.some((s) => s.lines === n))) return n;
  return 6;
}
