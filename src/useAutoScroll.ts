import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A driver decides where the view should be after each frame.
 * - sync(): called when playback starts or the user scrolled by hand,
 *   so the driver can pick up from the current position.
 * - advance(): move forward by dt seconds; return the new scrollTop,
 *   or null when the piece is over.
 */
export interface ScrollDriver {
  sync(scrollTop: number): void;
  advance(dt: number, maxScroll: number): number | null;
}

export function useAutoScroll(
  el: HTMLElement | null,
  driverRef: React.MutableRefObject<ScrollDriver>,
  startDelaySec: number,
) {
  const [playing, setPlaying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const delayRef = useRef(startDelaySec);
  delayRef.current = startDelaySec;

  useEffect(() => {
    if (countdown <= 0) return;
    const t = window.setTimeout(() => {
      if (countdown === 1) setPlaying(true);
      setCountdown(countdown - 1);
    }, 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  useEffect(() => {
    if (!playing || !el) return;
    let raf = 0;
    let lastT = performance.now();
    let lastTop = el.scrollTop;
    driverRef.current.sync(lastTop);

    const tick = (now: number) => {
      const dt = Math.min((now - lastT) / 1000, 0.1); // clamp after tab switches
      lastT = now;
      // user moved the view by hand -> continue from there
      if (Math.abs(el.scrollTop - lastTop) > 3) driverRef.current.sync(el.scrollTop);
      const max = el.scrollHeight - el.clientHeight;
      const next = driverRef.current.advance(dt, max);
      if (next === null) {
        setPlaying(false);
        return;
      }
      lastTop = Math.max(0, Math.min(max, next));
      el.scrollTop = lastTop;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, el, driverRef]);

  const toggle = useCallback(() => {
    if (playing) setPlaying(false);
    else if (countdown > 0) setCountdown(0);
    else if (delayRef.current > 0) setCountdown(delayRef.current);
    else setPlaying(true);
  }, [playing, countdown]);

  const stop = useCallback(() => {
    setPlaying(false);
    setCountdown(0);
  }, []);

  return { playing, countdown, toggle, stop };
}
