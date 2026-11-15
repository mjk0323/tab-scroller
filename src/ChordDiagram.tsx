import type { Frets } from './music';

/**
 * Standard chord box: strings left (6th, low E) → right (1st, high E),
 * frets top → bottom. Strokes use currentColor so it follows the theme.
 */
export default function ChordDiagram({ name, frets, size = 64, showName = true }: { name: string; frets: Frets; size?: number; showName?: boolean }) {
  const fretted = frets.filter((f): f is number => f !== null && f > 0);
  const maxF = fretted.length ? Math.max(...fretted) : 0;
  const minF = fretted.length ? Math.min(...fretted) : 0;
  const start = maxF <= 4 ? 1 : minF;
  const rows = 4;

  const W = 60;
  const padX = 9;
  const top = showName ? 26 : 12;
  const gx = (W - padX * 2) / 5;
  const gy = 10;
  const H = top + gy * rows + 6;
  // string index 0 = high E → drawn rightmost
  const xOf = (stringIdx: number) => padX + (5 - stringIdx) * gx;
  const yOf = (fret: number) => top + (fret - start + 0.5) * gy;

  // barre: lowest fret used on 3+ strings, across a contiguous span
  let barre: { fret: number; from: number; to: number } | null = null;
  if (minF > 0) {
    const idx = frets.map((f, i) => (f === minF ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 3) {
      const lo = Math.min(...idx);
      const hi = Math.max(...idx);
      const between = frets.slice(lo, hi + 1);
      if (between.every((f) => f !== null && f >= minF)) barre = { fret: minF, from: lo, to: hi };
    }
  }

  return (
    <svg className="chord-diagram" viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} role="img" aria-label={`${name} 코드`}>
      {showName && (
        <text x={W / 2} y={11} textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor">
          {name}
        </text>
      )}
      {/* nut or position marker */}
      {start === 1 ? (
        <rect x={padX - 0.5} y={top - 2.5} width={gx * 5 + 1} height={2.5} fill="currentColor" />
      ) : (
        <text x={padX - 2} y={top + gy * 0.75} textAnchor="end" fontSize="7" fill="currentColor">
          {start}
        </text>
      )}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line key={`f${r}`} x1={padX} x2={padX + gx * 5} y1={top + r * gy} y2={top + r * gy} stroke="currentColor" strokeWidth="0.7" />
      ))}
      {Array.from({ length: 6 }, (_, s) => (
        <line key={`s${s}`} x1={padX + s * gx} x2={padX + s * gx} y1={top} y2={top + rows * gy} stroke="currentColor" strokeWidth="0.7" />
      ))}
      {frets.map((f, i) =>
        f === null ? (
          <text key={`m${i}`} x={xOf(i)} y={top - 4.5} textAnchor="middle" fontSize="7" fill="currentColor">
            ×
          </text>
        ) : f === 0 ? (
          <circle key={`o${i}`} cx={xOf(i)} cy={top - 6.5} r={2.2} fill="none" stroke="currentColor" strokeWidth="0.8" />
        ) : null,
      )}
      {barre && (
        <rect
          x={xOf(barre.to) - 3.2}
          y={yOf(barre.fret) - 3.2}
          width={xOf(barre.from) - xOf(barre.to) + 6.4}
          height={6.4}
          rx={3.2}
          fill="currentColor"
        />
      )}
      {frets.map((f, i) =>
        f !== null && f > 0 && !(barre && f === barre.fret && i >= barre.from && i <= barre.to) ? (
          <circle key={`d${i}`} cx={xOf(i)} cy={yOf(f)} r={3.3} fill="currentColor" />
        ) : null,
      )}
    </svg>
  );
}
