import { useCallback, useEffect, useState } from "react";

/** Continuous playback over [0, max] hours driven by requestAnimationFrame. */
export function usePlayback(max: number, hoursPerSecond: number) {
  const [hour, setHourState] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); // clamp after tab switches
      last = now;
      setHourState((h) => Math.min(max, h + dt * hoursPerSecond));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, hoursPerSecond, max]);

  useEffect(() => {
    if (playing && hour >= max) setPlaying(false);
  }, [hour, max, playing]);

  const setHour = useCallback((h: number) => setHourState(Math.max(0, Math.min(max, h))), [max]);
  const toggle = useCallback(() => {
    if (!playing && hour >= max) setHourState(0); // replay from departure once the end is reached
    setPlaying(!playing);
  }, [playing, hour, max]);
  const reset = useCallback(() => {
    setPlaying(false);
    setHourState(0);
  }, []);

  return { hour, setHour, playing, setPlaying, toggle, reset };
}
