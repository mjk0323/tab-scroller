/**
 * OCR for scanned / image-only PDFs (no text layer), using Tesseract.js in the
 * browser. Loaded lazily — text-based PDFs never download it.
 *
 * Reads:
 *  - chord names above chord-chart boxes and above tab staves
 *  - fret numbers on tab staves
 */
import type { PDFDocumentProxy } from './pdf';
import { hasDiagramBelow, type ChordLabel, type NoteMark, type PageAnalysis } from './analysis';
import { parseChordName, splitChordText } from './music';
import type { Worker as TesseractWorker, Block } from 'tesseract.js';

const OCR_WIDTH = 2400; // px — fret digits end up ~25-30px tall
const CHORD_CHARS = 'ABCDEFGmMajdisu#b0123456789()/+-';

let workerPromise: Promise<TesseractWorker> | null = null;
function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng'));
  }
  return workerPromise;
}

interface Word {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  symbols: { text: string; x0: number; x1: number; y0: number; y1: number }[];
}

function wordsOf(blocks: Block[] | null): Word[] {
  const out: Word[] = [];
  for (const b of blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words)
          out.push({
            text: w.text.trim(),
            conf: w.confidence,
            ...w.bbox,
            symbols: w.symbols.map((s) => ({ text: s.text, ...s.bbox })),
          });
  return out;
}

async function renderForOcr(doc: PDFDocumentProxy, pageNumber: number) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: OCR_WIDTH / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Copy a region (page fractions) into its own canvas, optionally scaled. */
function crop(src: HTMLCanvasElement, x0: number, y0: number, x1: number, y1: number, scale = 1) {
  const W = src.width;
  const H = src.height;
  const sx = Math.max(0, Math.floor(x0 * W));
  const sy = Math.max(0, Math.floor(y0 * H));
  const sw = Math.min(W - sx, Math.ceil((x1 - x0) * W));
  const sh = Math.min(H - sy, Math.ceil((y1 - y0) * H));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return { canvas: c, sx, sy, scale };
}

/**
 * Prepare a tab staff for digit OCR: remove stems / barlines (long vertical
 * strokes) and the staff lines, keeping the strokes of the digits themselves.
 */
function cleanTab(c: HTMLCanvasElement, lineYs: number[], sp: number) {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const W = c.width;
  const H = c.height;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = d[j] + d[j + 1] + d[j + 2] < 3 * 160 ? 1 : 0;
  const white = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
  };
  // vertical strokes taller than a digit
  for (let x = 0; x < W; x++) {
    let s = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && dark[y * W + x] === 1;
      if (on && s < 0) s = y;
      if (!on && s >= 0) {
        if (y - s > sp * 1.15) for (let yy = s; yy < y; yy++) white(x, yy);
        s = -1;
      }
    }
  }
  // staff lines, except where a glyph crosses them
  const r = Math.max(3, Math.round(sp * 0.12)); // scans blur lines wider than they are
  for (const ly of lineYs) {
    for (let x = 0; x < W; x++) {
      const above = ly - r - 3;
      const below = ly + r + 3;
      const glyph = (above >= 0 && dark[above * W + x]) || (below < H && dark[below * W + x]);
      if (glyph) continue;
      for (let y = Math.max(0, ly - r); y <= Math.min(H - 1, ly + r); y++) white(x, y);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Pure black on white — drops coloured dots and grey watermarks that confuse OCR. */
function binarize(c: HTMLCanvasElement, threshold = 150) {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function luminance(c: HTMLCanvasElement): Uint8Array {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const lum = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return lum;
}

/** Turn an OCR word into chord labels, or nothing if it isn't one. */
function chordLabelsFrom(w: Word, toPageX: (x: number) => number, toPageY: (y: number) => number): ChordLabel[] {
  if (w.conf < 55 || !w.text) return [];
  const parts = splitChordText(w.text);
  if (!parts) return [];
  const out: ChordLabel[] = [];
  for (const p of parts) {
    if (!parseChordName(p.text)?.quality) continue;
    const frac = p.offset / Math.max(1, w.text.length);
    out.push({
      text: p.text,
      x: toPageX(w.x0 + (w.x1 - w.x0) * frac),
      y: toPageY(w.y1),
      size: toPageY(w.y1) - toPageY(w.y0),
      diagram: false,
    });
  }
  return out;
}

interface Glyph {
  canvas: HTMLCanvasElement; // the glyph group, black on white
  string: number; // 1..6
  staff: number;
  x: number; // page fraction (centre)
  x0: number;
  x1: number;
}

/**
 * Cut out fret-number glyphs from a cleaned tab staff: connected ink blobs of
 * digit size sitting on a string line. Neighbouring blobs on the same string
 * (the two digits of "12") are joined into one glyph group.
 */
function findGlyphs(c: HTMLCanvasElement, lineYs: number[], sp: number): Omit<Glyph, 'staff' | 'x'>[] {
  const W = c.width;
  const H = c.height;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = d[j] + d[j + 1] + d[j + 2] < 3 * 150 ? 1 : 0;
  // Digits on neighbouring strings can touch; a digit never reaches halfway to
  // the next string, so cut the ink there to keep them apart.
  for (let s = 0; s < 5; s++) {
    const mid = Math.round((lineYs[s] + lineYs[s + 1]) / 2);
    for (let x = 0; x < W; x++) dark[mid * W + x] = 0;
  }

  // connected components (4-neighbour)
  const label = new Int32Array(W * H);
  interface Comp { x0: number; x1: number; y0: number; y1: number; n: number }
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (!dark[p] || label[p]) continue;
    const comp: Comp = { x0: W, x1: 0, y0: H, y1: 0, n: 0 };
    comps.push(comp);
    label[p] = comps.length;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % W;
      const y = (q - x) / W;
      comp.n++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      const nb = [q - 1, q + 1, q - W, q + W];
      for (const r of nb) {
        if (r < 0 || r >= W * H || !dark[r] || label[r]) continue;
        if ((r === q - 1 && x === 0) || (r === q + 1 && x === W - 1)) continue;
        label[r] = comps.length;
        stack.push(r);
      }
    }
  }

  // keep digit-sized blobs centred on a string line
  const parts: (Comp & { string: number })[] = [];
  for (const k of comps) {
    const h = k.y1 - k.y0 + 1;
    const w = k.x1 - k.x0 + 1;
    if (h < sp * 0.35 || h > sp * 1.15 || w > sp * 1.3 || k.n < sp * 0.6) continue;
    const cy = (k.y0 + k.y1) / 2;
    let best = -1;
    for (let s = 0; s < 6; s++) if (Math.abs(cy - lineYs[s]) <= sp * 0.3) best = s;
    if (best >= 0) parts.push({ ...k, string: best + 1 });
  }

  // join neighbours on the same string ("1" + "2" = "12")
  parts.sort((a, b) => a.string - b.string || a.x0 - b.x0);
  const groups: (Comp & { string: number })[] = [];
  for (const p of parts) {
    const g = groups[groups.length - 1];
    if (g && g.string === p.string && p.x0 - g.x1 < sp * 0.18) {
      g.x1 = Math.max(g.x1, p.x1);
      g.y0 = Math.min(g.y0, p.y0);
      g.y1 = Math.max(g.y1, p.y1);
    } else groups.push({ ...p });
  }

  return groups.map((g) => {
    const pad = 2;
    const gc = document.createElement('canvas');
    gc.width = g.x1 - g.x0 + 1 + pad * 2;
    gc.height = g.y1 - g.y0 + 1 + pad * 2;
    const ctx = gc.getContext('2d')!;
    const img = ctx.createImageData(gc.width, gc.height);
    for (let y = 0; y < gc.height; y++) {
      for (let x = 0; x < gc.width; x++) {
        const sx = g.x0 - pad + x;
        const sy = g.y0 - pad + y;
        const on = sx >= 0 && sy >= 0 && sx < W && sy < H && dark[sy * W + sx];
        const i = (y * gc.width + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 0 : 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: gc, string: g.string, x0: g.x0, x1: g.x1 };
  });
}

/**
 * Lay glyphs out on one sheet with wide gaps, OCR it once, and give each glyph
 * the characters whose boxes fall inside its slot.
 */
async function readGlyphSheet(worker: TesseractWorker, glyphs: Glyph[]): Promise<(Glyph & { text: string })[]> {
  if (!glyphs.length) return [];
  const gh = Math.max(...glyphs.map((g) => g.canvas.height));
  const gap = Math.round(gh * 1.2);
  const perRow = 30;
  const rowH = Math.round(gh * 2.2);
  const rows = Math.ceil(glyphs.length / perRow);
  const slots: { x0: number; x1: number; y0: number; y1: number }[] = [];
  let maxW = 0;
  for (let r = 0; r < rows; r++) {
    let x = gap;
    for (let k = r * perRow; k < Math.min(glyphs.length, (r + 1) * perRow); k++) {
      const g = glyphs[k];
      slots.push({ x0: x - gap / 2, x1: x + g.canvas.width + gap / 2, y0: r * rowH, y1: (r + 1) * rowH });
      x += g.canvas.width + gap;
      maxW = Math.max(maxW, x);
    }
  }
  const sheet = document.createElement('canvas');
  sheet.width = Math.ceil(maxW + gap);
  sheet.height = rows * rowH + gap;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  glyphs.forEach((g, k) => {
    const s = slots[k];
    ctx.drawImage(g.canvas, s.x0 + gap / 2, s.y0 + gap / 2 + (gh - g.canvas.height) / 2);
  });

  const res = await worker.recognize(sheet, {}, { blocks: true });
  const text = glyphs.map(() => [] as { ch: string; x: number }[]);
  for (const w of wordsOf(res.data.blocks)) {
    for (const sym of w.symbols) {
      const cx = (sym.x0 + sym.x1) / 2;
      const cy = (sym.y0 + sym.y1) / 2;
      const k = slots.findIndex((s) => cx >= s.x0 && cx < s.x1 && cy >= s.y0 && cy < s.y1);
      if (k >= 0) text[k].push({ ch: sym.text, x: cx });
    }
  }
  return glyphs.map((g, k) => ({ ...g, text: text[k].sort((a, b) => a.x - b.x).map((t) => t.ch).join('') }));
}

export async function ocrPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  pa: PageAnalysis,
): Promise<{ labels: ChordLabel[]; notes: NoteMark[] }> {
  const tabStaves = pa.staves.map((s, i) => ({ s, i })).filter(({ s }) => s.lines === 6);
  const chartRows = pa.staves.filter((s) => s.lines === 0);
  if (!tabStaves.length && !chartRows.length) return { labels: [], notes: [] };

  const worker = await getWorker();
  const page = await renderForOcr(doc, pageNumber);
  const labels: ChordLabel[] = [];
  const notes: NoteMark[] = [];

  /* ---- chord names: one small crop right above each printed chord box ---- */
  if (pa.boxes.length) {
    await worker.setParameters({ tessedit_char_whitelist: CHORD_CHARS, tessedit_pageseg_mode: '7' as never });
    for (const bx of pa.boxes) {
      const bw = bx.x1 - bx.x0;
      const bh = bx.y1 - bx.y0;
      let name: string | null = null;
      // Different boxes fail in different ways (neighbouring names, lyrics above,
      // long names overhanging), so try a few crops and keep the first clean read.
      // (top/bottom: how far above the box the crop starts/ends, in box heights)
      const attempts = [
        { widen: 0.15, top: 0.75, bottom: 0.06, bin: true, psm: '7' }, // chart: name right on top of the box
        { widen: 0.3, top: 1.3, bottom: 0.3, bin: true, psm: '7' }, // tab diagram: name above the x/o string marks
        { widen: 0.15, top: 0.75, bottom: 0.06, bin: false, psm: '7' },
        { widen: 0.6, top: 1.6, bottom: 0.3, bin: true, psm: '7' },
        { widen: 0.45, top: 0.75, bottom: 0.06, bin: true, psm: '7' },
        { widen: 0.15, top: 0.6, bottom: 0.06, bin: true, psm: '7' },
        { widen: 0.15, top: 0.9, bottom: 0.06, bin: true, psm: '7' },
        { widen: 0.15, top: 0.75, bottom: 0.06, bin: true, psm: '10' }, // single letter names ("E", "A")
        { widen: 0.3, top: 1.3, bottom: 0.3, bin: true, psm: '10' },
      ];
      let psm = '7';
      for (const a of attempts) {
        if (a.psm !== psm) {
          psm = a.psm;
          await worker.setParameters({ tessedit_pageseg_mode: psm as never });
        }
        const c = crop(page, bx.x0 - bw * a.widen, bx.y0 - bh * a.top, bx.x1 + bw * a.widen, bx.y0 - bh * a.bottom);
        if (a.bin) binarize(c.canvas);
        const res = await worker.recognize(c.canvas);
        const text = res.data.text.replace(/\s+/g, '');
        // OCR noise often looks chord-ish ("Em34"), so only accept known chord types here
        if (res.data.confidence >= 40 && parseChordName(text)?.quality && splitChordText(text)?.length === 1) {
          name = text;
          break;
        }
      }
      if (psm !== '7') await worker.setParameters({ tessedit_pageseg_mode: '7' as never });
      // Unreadable name: still a chord position — "?" lets the chord be worked out from the tab notes.
      labels.push({ text: name ?? '?', x: bx.x0, y: bx.y0 - bh * 0.3, size: bh * 0.4, diagram: true });
    }
  }

  /* ---- chord names above tab staves that have no printed boxes: scan a band ---- */
  const lum = tabStaves.length ? luminance(page) : null;
  await worker.setParameters({ tessedit_char_whitelist: CHORD_CHARS, tessedit_pageseg_mode: '11' as never });
  for (let k = 0; k < tabStaves.length; k++) {
    const { s } = tabStaves[k];
    const prevBottom = k > 0 ? tabStaves[k - 1].s.bottom : 0;
    const y0 = Math.max(prevBottom + 0.01, s.top - 0.08);
    const y1 = s.top - 0.004;
    if (y1 <= y0) continue;
    if (pa.boxes.some((bx) => bx.y1 < s.top && bx.y0 > y0 - 0.02)) continue; // names already read from the boxes
    const c = crop(page, s.left - 0.02, y0, s.right, y1);
    const res = await worker.recognize(c.canvas, {}, { blocks: true });
    const toX = (x: number) => (c.sx + x / c.scale) / page.width;
    const toY = (y: number) => (c.sy + y / c.scale) / page.height;
    for (const w of wordsOf(res.data.blocks)) {
      for (const l of chordLabelsFrom(w, toX, toY)) {
        labels.push({ ...l, diagram: lum ? hasDiagramBelow(lum, page.width, page.height, l.x, l.y, l.size) : false });
      }
    }
  }

  /* ---- fret numbers ---- */
  if (tabStaves.length) {
    const glyphs: Glyph[] = [];
    const SCALE = 2;
    for (const { s, i } of tabStaves) {
      const sp = (s.bottom - s.top) / 5;
      const c = crop(page, s.left - 0.005, s.top - sp * 0.7, s.right + 0.005, s.bottom + sp * 0.7, SCALE);
      const spPx = sp * page.height * SCALE;
      const lineYs = Array.from({ length: 6 }, (_, k) => Math.round(((s.top + k * sp) * page.height - c.sy) * SCALE));
      cleanTab(c.canvas, lineYs, spPx);
      for (const g of findGlyphs(c.canvas, lineYs, spPx)) {
        glyphs.push({ ...g, staff: i, x: (c.sx + (g.x0 + g.x1) / 2 / SCALE) / page.width });
      }
    }
    // read every glyph of the page in one pass from a clean sheet
    await worker.setParameters({ tessedit_char_whitelist: '0123456789X', tessedit_pageseg_mode: '6' as never });
    for (const g of await readGlyphSheet(worker, glyphs)) {
      if (!/^\d{1,2}$/.test(g.text) || +g.text > 24) continue; // "X" (muted) and junk are skipped
      notes.push({ staff: g.staff, string: g.string, fret: +g.text, x: g.x });
    }
  }

  return { labels, notes };
}
