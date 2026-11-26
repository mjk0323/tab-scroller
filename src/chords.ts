import type { NoteMark, PageAnalysis, Staff } from './analysis';
import { parseChordName, recognize, reconcile, shapeFor, spellingFor, type Frets, type Spelling, type TabNote } from './music';

export interface ChordEvent {
  system: number; // index into the systems list
  page: number;
  x: number; // page fraction where the chord starts
  local: number; // position inside the system, in measures
  name: string;
  frets: Frets;
  printed: boolean; // a diagram for it is already printed on the page
  fromLabel: boolean; // name came from the printed score (vs. worked out from the tab)
  labelY: number | null; // baseline of the printed name, if any
}

export interface SystemRef {
  page: number;
  staff: number;
}

/** x on the staff → measures from the start of the line */
export function localMeasure(s: Staff, x: number): number {
  const b = s.bounds;
  if (b.length - 1 === s.measures) {
    if (x <= b[0]) return 0;
    for (let i = 0; i < b.length - 1; i++) {
      if (x < b[i + 1]) return i + (x - b[i]) / (b[i + 1] - b[i]);
    }
    return s.measures;
  }
  // measure count was corrected by hand → assume evenly spaced measures
  return Math.max(0, Math.min(s.measures, ((x - s.left) / (s.right - s.left)) * s.measures));
}

const toTab = (ns: NoteMark[]): TabNote[] => ns.map((n) => ({ string: n.string, fret: n.fret }));

const SLOTS = 4; // chords may change on any beat of the bar
const CHANGE_COST = 0.12; // each extra chord in a bar has to earn its place

type Recognized = NonNullable<ReturnType<typeof recognize>>;

const OPEN = [64, 59, 55, 50, 45, 40];
/** Pitch classes of the bass notes: the lowest note of each column, when it is on string 5 or 6. */
function bassNotes(notes: NoteMark[]): number[] {
  const cols: NoteMark[][] = [];
  for (const n of [...notes].sort((a, b) => a.x - b.x)) {
    const last = cols[cols.length - 1];
    if (last && Math.abs(last[0].x - n.x) < 0.004) last.push(n);
    else cols.push([n]);
  }
  const out: number[] = [];
  for (const c of cols) {
    const low = c.reduce((a, b) => (OPEN[b.string - 1] + b.fret < OPEN[a.string - 1] + a.fret ? b : a));
    if (low.string >= 5) out.push((OPEN[low.string - 1] + low.fret) % 12);
  }
  return out;
}

/**
 * Split one bar into the chord sequence that best explains its notes.
 * Tries every way of cutting the bar on beat boundaries (1–4 chords) and
 * keeps the one with the best note-weighted fit, minus a cost per change.
 */
function segmentBar(inBar: NoteMark[], x0: number, x1: number, sp: Spelling): { notes: NoteMark[]; chord: Recognized }[] {
  const slotOf = (n: NoteMark) => Math.min(SLOTS - 1, Math.max(0, Math.floor(((n.x - x0) / (x1 - x0)) * SLOTS)));
  const total = inBar.length;
  const cache = new Map<string, { notes: NoteMark[]; chord: Recognized; value: number } | null>();
  const segment = (a: number, b: number) => {
    const k = `${a}-${b}`;
    if (cache.has(k)) return cache.get(k)!;
    const notes = inBar.filter((n) => slotOf(n) >= a && slotOf(n) < b);
    const pcs = new Set(notes.map((n) => n.string * 100 + n.fret));
    const chord = pcs.size >= 2 ? recognize(toTab(notes), sp) : null;
    let penalty = pcs.size < 3 ? 0.15 : 0; // thin evidence is less trustworthy than a full voicing
    if (chord) {
      // A new chord usually brings a new bass note. Two different bass notes in one
      // segment (other than an alternating root/fifth bass) means it should be split.
      const allowed = new Set([chord.root, (chord.root + 7) % 12, ...(chord.bass !== null ? [chord.bass] : [])]);
      const extra = new Set(bassNotes(notes).filter((pc) => !allowed.has(pc))).size;
      penalty += 0.3 * extra;
    }
    const value = chord ? (chord.score - penalty) * (notes.length / total) : 0;
    const r = chord ? { notes, chord, value } : null;
    cache.set(k, r);
    return r;
  };

  let best: { notes: NoteMark[]; chord: Recognized }[] = [];
  let bestScore = -Infinity;
  // every set of cut points between slots: bitmask over SLOTS-1 positions
  for (let mask = 0; mask < 1 << (SLOTS - 1); mask++) {
    const cuts = [0];
    for (let i = 1; i < SLOTS; i++) if (mask & (1 << (i - 1))) cuts.push(i);
    cuts.push(SLOTS);
    const segs: { notes: NoteMark[]; chord: Recognized }[] = [];
    let score = 0;
    let valid = true;
    for (let i = 0; i < cuts.length - 1; i++) {
      const notesIn = inBar.some((n) => slotOf(n) >= cuts[i] && slotOf(n) < cuts[i + 1]);
      if (!notesIn) continue; // empty beats just extend the previous chord
      const seg = segment(cuts[i], cuts[i + 1]);
      if (!seg) {
        valid = false;
        break;
      }
      if (segs.length && segs[segs.length - 1].chord.name === seg.chord.name) {
        valid = false; // same chord twice in a row is the unsplit version
        break;
      }
      segs.push(seg);
      score += seg.value;
    }
    if (!valid || !segs.length) continue;
    score -= CHANGE_COST * (segs.length - 1);
    if (score > bestScore) {
      bestScore = score;
      best = segs;
    }
  }
  return best;
}

export function buildChordEvents(pages: PageAnalysis[], systems: SystemRef[], ignorePrinted: boolean): ChordEvent[] {
  const events: ChordEvent[] = [];
  const sp = spellingFor(pages.flatMap((p) => toTab(p.notes)));

  systems.forEach((r, si) => {
    const pa = pages[r.page];
    const s = pa.staves[r.staff];
    const notes = pa.notes.filter((n) => n.staff === r.staff).sort((a, b) => a.x - b.x);

    // Chord names printed between the previous line on this page and this one.
    const prevBottom = systems
      .slice(0, si)
      .filter((o) => o.page === r.page)
      .map((o) => pa.staves[o.staff].bottom)
      .reduce((m, v) => Math.max(m, v), 0);
    const labels = ignorePrinted
      ? []
      : pa.labels
          .filter((l) => l.y < s.top && l.y > prevBottom && s.top - l.y < 0.15 && l.x > s.left - 0.03 && l.x < s.right)
          .sort((a, b) => a.x - b.x);

    const push = (x: number, name: string, frets: Frets, printed: boolean, fromLabel: boolean, labelY: number | null) => {
      const prev = events[events.length - 1];
      if (!fromLabel && prev && prev.system === si && prev.name === name) return; // same chord continues
      events.push({ system: si, page: r.page, x, local: localMeasure(s, x), name, frets, printed, fromLabel, labelY });
    };

    if (labels.length) {
      // Printed names: they tell us where chords change. The tab tells us exactly what is played.
      const tol = 0.012;
      labels.forEach((l, i) => {
        const end = i + 1 < labels.length ? labels[i + 1].x - tol : s.right;
        const seg = toTab(notes.filter((n) => n.x >= l.x - tol && n.x < end));
        // "?" = a printed chord box whose name OCR couldn't read: work it out from the notes
        const parsed = l.text === '?' ? null : parseChordName(l.text);
        const chord = parsed ? reconcile(parsed, seg) : recognize(seg, sp);
        if (!chord) return;
        push(l.x, chord.name, shapeFor(chord, seg), l.diagram, !!parsed, l.y);
      });
      return;
    }

    // Tab only: work the chords out per measure (or per half measure when it changes mid-bar).
    const nb = s.bounds.length - 1 === s.measures ? s.bounds : null;
    for (let m = 0; m < s.measures; m++) {
      const x0 = nb ? nb[m] : s.left + ((s.right - s.left) * m) / s.measures;
      const x1 = nb ? nb[m + 1] : s.left + ((s.right - s.left) * (m + 1)) / s.measures;
      const inBar = notes.filter((n) => n.x >= x0 && n.x < x1);
      if (!inBar.length) continue;

      for (const seg of segmentBar(inBar, x0, x1, sp)) {
        push(seg.notes[0].x, seg.chord.name, shapeFor(seg.chord, toTab(seg.notes)), false, false, null);
      }
    }
  });

  return events;
}
