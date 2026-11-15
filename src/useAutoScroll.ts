import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Smoothly scrolls `el` downward at `speed` CSS px per second while playing.
 * Manual scrolling (wheel / touch / scrollbar) during playback is respected:
 * the scroller picks up from wherever the user left it.
 */
export function useAutoScroll(
  el: HTMLElement | null,
  speed: number,
  startDelaySec: number,
) {
  const [playing, setPlaying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // countdown before playback starts
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
    let last = performance.now();
    let pos = el.scrollTop;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1); // clamp after tab switches
      last = now;
      // user moved the view manually -> continue from there
      if (Math.abs(el.scrollTop - pos) > 2) pos = el.scrollTop;
      pos += speedRef.current * dt;
      const max = el.scrollHeight - el.clientHeight;
      if (pos >= max) {
        el.scrollTop = max;
        setPlaying(false);
        return;
      }
      el.scrollTop = pos;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, el]);

  const toggle = useCallback(() => {
    if (playing) {
      setPlaying(false);
    } else if (countdown > 0) {
      setCountdown(0); // cancel count-in
    } else if (startDelaySec > 0) {
      setCountdown(startDelaySec);
    } else {
      setPlaying(true);
    }
  }, [playing, countdown, startDelaySec]);

  const stop = useCallback(() => {
    setPlaying(false);
    setCountdown(0);
  }, []);

  return { playing, countdown, toggle, stop };
}
