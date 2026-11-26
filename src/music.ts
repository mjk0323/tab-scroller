/**
 * Guitar chord theory helpers: pitch math, chord recognition from tab notes,
 * chord-name parsing and fingering (voicing) generation. No AI — just rules.
 *
 * Fret arrays are indexed by string: [0] = 1st string (high E) … [5] = 6th string (low E).
 * null = string not played (x).
 */
export type Frets = (number | null)[];

export const OPEN_MIDI = [64, 59, 55, 50, 45, 40]; // standard tuning, 1st → 6th string
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export type Spelling = 'mixed' | 'sharp' | 'flat';
const spellTable = (sp: Spelling) => (sp === 'sharp' ? SHARPS : sp === 'flat' ? FLATS : NAMES);

/**
 * Sharps or flats for this song, from its notes: find the major key whose scale
 * covers the most notes, then use that key signature's accidentals.
 */
export function spellingFor(notes: TabNote[]): Spelling {
  if (notes.length < 20) return 'mixed';
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[(OPEN_MIDI[n.string - 1] + n.fret) % 12]++;
  const major = [0, 2, 4, 5, 7, 9, 11];
  let best = 0;
  let bestScore = -1;
  for (let k = 0; k < 12; k++) {
    const sc = major.reduce((a, i) => a + hist[(k + i) % 12], 0);
    if (sc > bestScore) ((bestScore = sc), (best = k));
  }
  if ([7, 2, 9, 4, 11, 6, 1].includes(best)) return 'sharp'; // G D A E B F# C# (and their relative minors)
  if ([5, 10, 3, 8].includes(best)) return 'flat'; // F Bb Eb Ab
  return 'mixed';
}
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface Quality {
  suffix: string;
  iv: number[]; // intervals from the root
  req: number[]; // intervals that must be present to call it this chord
}

export const QUALITIES: Quality[] = [
  { suffix: '', iv: [0, 4, 7], req: [0, 4] },
  { suffix: 'm', iv: [0, 3, 7], req: [0, 3] },
  { suffix: '7', iv: [0, 4, 7, 10], req: [0, 4, 10] },
  { suffix: 'M7', iv: [0, 4, 7, 11], req: [0, 4, 11] },
  { suffix: 'm7', iv: [0, 3, 7, 10], req: [0, 3, 10] },
  { suffix: 'sus4', iv: [0, 5, 7], req: [0, 5, 7] },
  { suffix: 'sus2', iv: [0, 2, 7], req: [0, 2, 7] },
  { suffix: 'add9', iv: [0, 2, 4, 7], req: [0, 2, 4] },
  { suffix: 'madd9', iv: [0, 2, 3, 7], req: [0, 2, 3] },
  { suffix: '7sus4', iv: [0, 5, 7, 10], req: [0, 5, 7, 10] },
  { suffix: '6', iv: [0, 4, 7, 9], req: [0, 4, 9] },
  { suffix: 'm6', iv: [0, 3, 7, 9], req: [0, 3, 9] },
  { suffix: 'm7(b5)', iv: [0, 3, 6, 10], req: [0, 3, 6, 10] },
  { suffix: 'dim', iv: [0, 3, 6], req: [0, 3, 6] },
  { suffix: 'dim7', iv: [0, 3, 6, 9], req: [0, 3, 6, 9] },
  { suffix: 'aug', iv: [0, 4, 8], req: [0, 4, 8] },
  { suffix: '9', iv: [0, 2, 4, 7, 10], req: [0, 2, 4, 10] },
  { suffix: 'M9', iv: [0, 2, 4, 7, 11], req: [0, 2, 4, 11] },
  { suffix: 'm9', iv: [0, 2, 3, 7, 10], req: [0, 2, 3, 10] },
];
const BY_SUFFIX = new Map(QUALITIES.map((q) => [q.suffix, q]));

export const pcName = (pc: number) => NAMES[((pc % 12) + 12) % 12];
export const midiOf = (string: number, fret: number) => OPEN_MIDI[string - 1] + fret;

export interface TabNote {
  string: number; // 1..6
  fret: number;
}

export interface Chord {
  root: number;
  quality: Quality;
  bass: number | null; // slash bass pc, if different from root
  name: string;
}

function chordName(root: number, q: Quality, bass: number | null, rootLabel?: string, bassLabel?: string, sp: Spelling = 'mixed') {
  const t = spellTable(sp);
  const r = rootLabel ?? t[root];
  const b = bass === null ? '' : '/' + (bassLabel ?? t[bass]);
  return r + q.suffix + b;
}

/* ------------------------------------------------------------------ */
/* Recognition                                                         */
/* ------------------------------------------------------------------ */

interface Profile {
  w: number[]; // normalized weight per pitch class
  bassPc: number;
}

function profile(notes: TabNote[]): Profile | null {
  if (!notes.length) return null;
  const w = new Array(12).fill(0);
  let low = Infinity;
  for (const n of notes) {
    const m = midiOf(n.string, n.fret);
    w[m % 12] += 1;
    low = Math.min(low, m);
  }
  const total = notes.length;
  for (let i = 0; i < 12; i++) w[i] /= total;
  return { w, bassPc: low % 12 };
}

function fit(p: Profile, root: number, q: Quality): number {
  const pcs = new Set(q.iv.map((i) => (root + i) % 12));
  let inW = 0;
  let outW = 0;
  for (let pc = 0; pc < 12; pc++) (pcs.has(pc) ? (inW += p.w[pc]) : (outW += p.w[pc]));
  const missing = q.req.filter((i) => p.w[(root + i) % 12] === 0).length;
  return (
    inW -
    1.5 * outW -
    0.35 * missing -
    0.1 * (q.iv.length - 3) +
    (p.bassPc === root ? 0.18 : 0) +
    (q.suffix === '' || q.suffix === 'm' ? 0.03 : 0)
  );
}

/** Best chord for a set of tab notes, or null if there is not enough to go on. */
export function recognize(notes: TabNote[], sp: Spelling = 'mixed'): (Chord & { score: number }) | null {
  const p = profile(notes);
  if (!p || p.w.filter((v) => v > 0).length < 2) return null;
  let best: (Chord & { score: number }) | null = null;
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const s = fit(p, root, q);
      if (!best || s > best.score) {
        const inChord = q.iv.some((i) => (root + i) % 12 === p.bassPc);
        const bass = p.bassPc !== root && inChord ? p.bassPc : null;
        best = { root, quality: q, bass, name: chordName(root, q, bass, undefined, undefined, sp), score: s };
      }
    }
  }
  // Root + 2nd + 5th with no 3rd: guitar scores in this style almost always call it "add9"
  // (Cadd9, Aadd9) — the 3rd is in the grip, it just isn't picked in the pattern.
  if (best && best.quality.suffix === 'sus2') {
    const q = BY_SUFFIX.get('add9')!;
    best = { ...best, quality: q, name: chordName(best.root, q, best.bass, undefined, undefined, sp) };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Parsing printed chord names                                         */
/* ------------------------------------------------------------------ */

const CHORD_RE = /^([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G])([#b♯♭]?))?$/;

function normalizeSuffix(raw: string): string {
  let s = raw.replace(/\s+/g, '').replace(/♯/g, '#').replace(/♭/g, 'b');
  s = s.replace(/^maj7|^△7|^Δ7/, 'M7').replace(/^min/, 'm');
  // some PDFs drop the flat glyph: "m7(5)" / "m7-5" → "m7(b5)"
  s = s.replace(/\((5)\)$/, '(b5)').replace(/-5$/, '(b5)').replace(/m7b5$/, 'm7(b5)');
  if (s === 'ø' || s === 'ø7') s = 'm7(b5)';
  if (s === 'M') s = '';
  if (s === 'add2') s = 'add9';
  if (s === 'o7' || s === '°7') s = 'dim7';
  if (s === 'o' || s === '°') s = 'dim';
  return s;
}

export function looksLikeChord(token: string): boolean {
  const m = CHORD_RE.exec(token);
  if (!m) return false;
  return /^(?:M|m|maj|min|dim|aug|sus|add|\d|\(|\)|b|#|-|\+|△|Δ|ø|o)*$/.test(m[3]);
}

/**
 * Split a text run like "A add9 Bsus4" or "F m 7" into chord strings with
 * their character offsets (PDF fonts often put spaces inside chord names).
 */
export function splitChordText(str: string): { text: string; offset: number }[] | null {
  const tokens: { t: string; i: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) tokens.push({ t: m[0], i: m.index });
  if (!tokens.length) return null;
  const out: { text: string; offset: number }[] = [];
  for (const tk of tokens) {
    const startsNew = /^[A-G]/.test(tk.t) && !(out.length && out[out.length - 1].text.endsWith('/'));
    if (startsNew) out.push({ text: tk.t, offset: tk.i });
    else if (out.length) out[out.length - 1].text += tk.t;
    else return null;
  }
  return out.every((c) => looksLikeChord(c.text)) ? out : null;
}

export interface ParsedName {
  letter: string;
  accidental: string; // '', '#', 'b'
  suffix: string;
  quality: Quality | null;
  bassLetter: string | null;
  bassAccidental: string;
}

export function parseChordName(text: string): ParsedName | null {
  const m = CHORD_RE.exec(text.replace(/\s+/g, ''));
  if (!m) return null;
  const suffix = normalizeSuffix(m[3]);
  return {
    letter: m[1],
    accidental: (m[2] || '').replace('♯', '#').replace('♭', 'b'),
    suffix,
    quality: BY_SUFFIX.get(suffix) ?? null,
    bassLetter: m[4] ?? null,
    bassAccidental: (m[5] || '').replace('♯', '#').replace('♭', 'b'),
  };
}

const accOffset = (a: string) => (a === '#' ? 1 : a === 'b' ? -1 : 0);

/**
 * Combine a printed chord name with the notes actually written in the tab.
 * The letter comes from the print; a missing ♯/♭ (common in PDF text) is
 * restored from the notes.
 */
export function reconcile(p: ParsedName, notes: TabNote[]): Chord {
  const prof = profile(notes);
  const q = p.quality ?? (p.suffix.startsWith('m') && !p.suffix.startsWith('maj') ? BY_SUFFIX.get('m')! : BY_SUFFIX.get('')!);
  const base = LETTER_PC[p.letter];

  let acc = p.accidental;
  if (!acc && prof) {
    let best = -Infinity;
    for (const a of ['', '#', 'b']) {
      if (['B#', 'E#', 'Cb', 'Fb'].includes(p.letter + a)) continue; // never spelled that way in practice
      const s = fit(prof, (base + accOffset(a) + 12) % 12, q) + (a === '' ? 0.05 : 0);
      if (s > best) {
        best = s;
        acc = a;
      }
    }
  }
  const root = (base + accOffset(acc) + 12) % 12;

  let bass: number | null = null;
  let bassLabel: string | undefined;
  if (p.bassLetter) {
    let bacc = p.bassAccidental;
    const bbase = LETTER_PC[p.bassLetter];
    if (!bacc && prof) {
      // trust the lowest written note if it is a semitone off the printed letter
      const d = (prof.bassPc - bbase + 12) % 12;
      if (d === 1) bacc = '#';
      else if (d === 11) bacc = 'b';
    }
    bass = (bbase + accOffset(bacc) + 12) % 12;
    bassLabel = p.bassLetter + bacc;
  }
  const quality = p.quality ?? { ...q, suffix: p.suffix };
  return { root, quality, bass, name: chordName(root, quality, bass, p.letter + acc, bassLabel) };
}

/* ------------------------------------------------------------------ */
/* Fingerings                                                          */
/* ------------------------------------------------------------------ */

function fingersNeeded(f: Frets): number {
  const fretted = f.filter((x): x is number => x !== null && x > 0);
  if (!fretted.length) return 0;
  const min = Math.min(...fretted);
  const atMin = fretted.filter((x) => x === min).length;
  return fretted.length - atMin + 1; // notes on the lowest fret can share a barre
}

function playable(f: Frets): boolean {
  const fretted = f.filter((x): x is number => x !== null && x > 0);
  if (!fretted.length) return true;
  return Math.max(...fretted) - Math.min(...fretted) <= 3 && fingersNeeded(f) <= 4;
}

/**
 * Common grips as players actually hold them (6th → 1st string, x = muted).
 * Anything not listed gets a generated fingering.
 */
const GRIP_TABLE: Record<string, string> = {
  C: 'x32010', Cadd9: 'x32030', CM7: 'x32000', C7: 'x32310', Cm: 'x35543', Cm7: 'x35343',
  'C#m': 'x46654', 'C#m7': 'x46454', 'C#7': 'x46464',
  D: 'xx0232', Dm: 'xx0231', D7: 'xx0212', DM7: 'xx0222', Dm7: 'xx0211', Dsus4: 'xx0233', Dsus2: 'xx0230', Dadd9: 'xx0230', 'D/F#': '200232',
  Eb: 'x68886', EbM7: 'x65333',
  E: '022100', Em: '022000', E7: '020100', Em7: '022030', EM7: '021100', Esus4: '022200', E7sus4: '020200', 'E/G#': '4x2100',
  F: '133211', FM7: 'xx3210', Fm: '133111', F7: '131211', Fm7: '131111',
  'F#': '244322', 'F#m': '244222', 'F#m7': '2x222x', 'F#7': '242322', 'F#m7(b5)': '2x221x',
  G: '320003', G7: '320001', GM7: '320002', Gm: '355333', 'G/B': 'x20003', Gsus4: '330013', Gadd9: '3x0203',
  'G#m': '466444', 'G#m7': '4x444x', 'G#7': '464544',
  A: 'x02220', Am: 'x02210', A7: 'x02020', Am7: 'x02010', AM7: 'x02120', Asus4: 'x02230', Asus2: 'x02200', Aadd9: 'x02420', A7sus4: 'x02030', 'A/C#': 'x42220',
  Bb: 'x13331', BbM7: 'x13231',
  B: 'x24442', Bm: 'x24432', B7: 'x21202', Bm7: 'x24232', Bsus4: 'x24452', B7sus4: 'x24252', 'Bm7(b5)': 'x2323x',
};
const GRIPS = new Map<string, Frets>();
for (const [name, grip] of Object.entries(GRIP_TABLE)) {
  const p = parseChordName(name);
  if (!p) continue;
  const root = (LETTER_PC[p.letter] + accOffset(p.accidental) + 12) % 12;
  const bass = p.bassLetter ? (LETTER_PC[p.bassLetter] + accOffset(p.bassAccidental) + 12) % 12 : null;
  const frets = [...grip].map((ch) => (ch === 'x' ? null : Number(ch))).reverse();
  GRIPS.set(`${root}|${p.suffix}|${bass}`, frets);
}

const voicingCache = new Map<string, Frets>();

/** Generate a sensible fingering for a chord (open position preferred). */
export function voicing(c: Chord): Frets {
  const known = GRIPS.get(`${c.root}|${c.quality.suffix}|${c.bass}`);
  if (known) return known;
  const key = `${c.root}|${c.quality.iv.join(',')}|${c.bass}`;
  const hit = voicingCache.get(key);
  if (hit) return hit;

  const pcs = new Set(c.quality.iv.map((i) => (c.root + i) % 12));
  const req = c.quality.req.map((i) => (c.root + i) % 12);
  const bassPc = c.bass ?? c.root;
  if (c.bass !== null) pcs.add(c.bass);

  let best: Frets = [null, null, null, null, null, null];
  let bestScore = -Infinity;

  for (let lo = 0; lo <= 9; lo++) {
    const minF = Math.max(1, lo);
    const maxF = minF + 3;
    const options: (number | null)[][] = [];
    for (let s = 1; s <= 6; s++) {
      const opts: (number | null)[] = [null];
      if (lo === 0 && pcs.has(OPEN_MIDI[s - 1] % 12)) opts.push(0);
      for (let f = minF; f <= maxF; f++) if (pcs.has((OPEN_MIDI[s - 1] + f) % 12)) opts.push(f);
      options.push(opts);
    }
    const cur: Frets = new Array(6).fill(null);
    const walk = (s: number) => {
      if (s < 0) {
        score(cur.slice());
        return;
      }
      for (const o of options[s]) {
        cur[s] = o;
        walk(s - 1);
      }
    };
    const score = (f: Frets) => {
      const sounded = f.map((x, i) => (x === null ? null : (OPEN_MIDI[i] + x) % 12));
      const n = sounded.filter((x) => x !== null).length;
      if (n < 3) return;
      // lowest sounding string must be the bass note
      let lowest = -1;
      for (let i = 5; i >= 0; i--) if (sounded[i] !== null) { lowest = i; break; }
      if (sounded[lowest] !== bassPc) return;
      if (!req.every((pc) => sounded.includes(pc))) return;
      if (!playable(f)) return;
      // muted strings should only be at the bass side
      let inner = 0;
      for (let i = 0; i < lowest; i++) if (f[i] === null) inner++;
      const fretted = f.filter((x): x is number => x !== null && x > 0);
      const pos = fretted.length ? Math.min(...fretted) : 0;
      const opens = f.filter((x) => x === 0).length;
      const s = n * 1.0 - inner * 2.5 - pos * 0.35 + (lo === 0 ? opens * 0.15 : 0) - fingersNeeded(f) * 0.1;
      if (s > bestScore) {
        bestScore = s;
        best = f;
      }
    };
    walk(5);
  }
  voicingCache.set(key, best);
  return best;
}

/**
 * The hand shape actually written in the tab for this chord, if it is a clean
 * one; otherwise fall back to the generated voicing.
 */
export function shapeFor(c: Chord, notes: TabNote[]): Frets {
  const v = voicing(c);
  const pcs = new Set(c.quality.iv.map((i) => (c.root + i) % 12));
  if (c.bass !== null) pcs.add(c.bass);

  const counts: Map<number, number>[] = Array.from({ length: 6 }, () => new Map());
  for (const n of notes) {
    if (!pcs.has(midiOf(n.string, n.fret) % 12)) continue;
    const m = counts[n.string - 1];
    m.set(n.fret, (m.get(n.fret) ?? 0) + 1);
  }
  const tab: Frets = counts.map((m) => {
    let bf: number | null = null;
    let bc = 0;
    for (const [f, c2] of m) if (c2 > bc || (c2 === bc && bf !== null && f < bf)) ((bf = f), (bc = c2));
    return bf;
  });
  const played = tab.filter((x) => x !== null).length;
  if (played === 0) return v;

  const sounded = tab.map((f, i) => (f === null ? null : (OPEN_MIDI[i] + f) % 12));
  const req = c.quality.req.map((i) => (c.root + i) % 12);
  const complete = played >= 3 && playable(tab) && req.every((pc) => sounded.includes(pc));

  // Everything the tab plays fits the usual grip → show the grip the hand actually holds.
  if (tab.every((f, i) => f === null || v[i] === f)) return v;
  // Otherwise the tab uses its own shape → show exactly what is written.
  if (complete) return tab;
  return v;
}
