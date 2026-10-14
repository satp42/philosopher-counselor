import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

export type Levels = { input: number; output: number };
export type OrbMode = "idle" | "active" | "thinking" | "paused";

const silent = (): Levels => ({ input: 0, output: 0 });
const BREATH_MS = 4800;

function rgb(cssVar: string, fallback: string) {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || fallback;
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return Number.isNaN(n) ? [122, 74, 43] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = ([r, g, b]: number[], a: number) => `rgba(${r},${g},${b},${a})`;

interface Props {
  mode: OrbMode;
  label: string;
  getLevels?: () => Levels;
}

export default function VoiceOrb({ mode, label, getLevels = silent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ mode, getLevels });
  useEffect(() => {
    live.current = { mode, getLevels };
  });
  // Kept across loop restarts so a mode change eases from the current levels.
  const smoothed = useRef({ input: 0, output: 0, breath: 0 });
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const accent = rgb("--color-accent", "#7a4a2b");
    const muted = rgb("--color-muted", "#6a6257");
    const level = smoothed.current;
    let frame = 0;

    const ease = (from: number, to: number) => from + (to - from) * (to > from ? 0.25 : 0.06);

    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const size = canvas.clientWidth * dpr;
      if (!size) return;
      if (canvas.width !== size) canvas.width = canvas.height = size;

      const { mode, getLevels } = live.current;
      const levels = mode === "active" ? getLevels() : silent();
      const input = (level.input = ease(level.input, Math.min(1, levels.input)));
      const output = (level.output = ease(level.output, Math.min(1, levels.output)));

      const c = size / 2;
      const r0 = size * 0.24;
      const breath = (level.breath = ease(level.breath, mode === "thinking" && !reduce ? Math.sin((t / BREATH_MS) * Math.PI * 2) : 0));
      const swell = reduce ? 0 : 0.2 * output + 0.05 * breath;
      const r = r0 * (1 + swell);
      const color = mode === "paused" ? muted : accent;
      const presence = mode === "idle" || mode === "paused" ? 0.55 : 0.85 + 0.15 * Math.max(output, breath * 0.5);

      ctx.clearRect(0, 0, size, size);

      const halo = ctx.createRadialGradient(c, c, r * 0.6, c, c, r * 1.9);
      halo.addColorStop(0, rgba(color, 0.22 * presence + 0.2 * output));
      halo.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      if (input > 0.02 && !reduce) {
        ctx.beginPath();
        ctx.arc(c, c, r + size * (0.03 + 0.1 * input), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(color, 0.35 * input);
        ctx.lineWidth = dpr * 1.5;
        ctx.stroke();
      }

      const body = ctx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
      body.addColorStop(0, rgba(color, 0.55 * presence));
      body.addColorStop(1, rgba(color, presence));
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();

      // A still orb burns no battery; the mode change in this effect's deps restarts the loop.
      const still = mode === "idle" || mode === "paused" || (reduce && mode === "thinking");
      if (still && input < 0.001 && output < 0.001 && Math.abs(breath) < 0.001) cancelAnimationFrame(frame);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [reduce, mode]);

  return (
    <figure className="flex flex-col items-center gap-3">
      <canvas ref={canvasRef} aria-hidden="true" className="size-56 sm:size-72" />
      <figcaption className="min-h-6 text-center font-serif text-lg text-muted italic">{label}</figcaption>
    </figure>
  );
}
