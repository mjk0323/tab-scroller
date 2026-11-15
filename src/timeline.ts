/**
 * Maps musical position (in measures) <-> scroll position (in px).
 *
 * Each system (one line of music) has a y position in the scroll content and a
 * measure count. While system i is being played the view glides from system i
 * to system i+1, so system i+1 reaches the reading line exactly when it starts.
 */
export interface SystemPos {
  y: number; // top of the staff, in scroll-content px
  height: number; // staff height in px
  measures: number;
}

export class Timeline {
  private starts: number[] = []; // measure index where each system starts
  readonly total: number;

  constructor(private systems: SystemPos[]) {
    let acc = 0;
    for (const s of systems) {
      this.starts.push(acc);
      acc += s.measures;
    }
    this.total = acc;
  }

  get length() {
    return this.systems.length;
  }

  /** y where system i "ends" = where the next one starts (virtual one after the last). */
  private nextY(i: number) {
    const s = this.systems;
    if (i + 1 < s.length) return s[i + 1].y;
    const prevGap = s.length > 1 ? s[i].y - s[i - 1].y : s[i].height * 3;
    return s[i].y + prevGap;
  }

  systemAt(p: number): number {
    let i = 0;
    while (i + 1 < this.starts.length && this.starts[i + 1] <= p) i++;
    return i;
  }

  /** content y of the reading line at position p (measures) */
  yAt(p: number): number {
    if (!this.systems.length) return 0;
    const i = this.systemAt(p);
    const s = this.systems[i];
    const frac = Math.min(1, Math.max(0, (p - this.starts[i]) / s.measures));
    return s.y + frac * (this.nextY(i) - s.y);
  }

  /** inverse of yAt */
  pAt(y: number): number {
    const s = this.systems;
    if (!s.length || y <= s[0].y) return 0;
    for (let i = 0; i < s.length; i++) {
      const y1 = this.nextY(i);
      if (y < y1) return this.starts[i] + ((y - s[i].y) / (y1 - s[i].y)) * s[i].measures;
    }
    return this.total;
  }
}
