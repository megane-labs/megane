/**
 * Small performance readout shown next to the Reset View button.
 *
 * Displays the loaded atom count, bond count, per-frame draw calls, render
 * FPS, main-thread CPU load, and the memory Megane's data takes. Atom/bond
 * counts come from React state in the parent; the rest is polled on an
 * interval (NOT per render frame — the parent deliberately avoids per-frame
 * React renders, see MeganeViewer's snapshot subscription comment).
 *
 * A page cannot read its process's CPU or memory use, so both readouts are
 * Megane's own measures: CPU is the busy share of the main thread
 * (`mainThreadLoad`), Mem the bytes of data Megane holds (see `PerfHudStats`).
 */

import { useEffect, useState } from "react";
import { OVERLAY_INSET, PERF_HUD_LEFT_DEFAULT } from "./overlayLayout";
import { mainThreadLoad, watchMainThreadLoad } from "../utils/mainThreadLoad";

export interface PerfHudStats {
  fps: number;
  drawCalls: number;
  /**
   * Bytes of data Megane holds: the renderer's geometry and texture buffers,
   * the trajectory frames playback keeps, and the parsers' WASM heap.
   */
  memoryBytes?: number;
}

interface PerfHudProps {
  atomCount: number;
  bondCount: number;
  getStats: () => PerfHudStats | null;
  /**
   * When true, render fixed placeholders instead of the live FPS, CPU, and
   * memory values. Used by E2E so screenshot baselines stay deterministic
   * (those digits vary per run); the live values stay readable from the
   * spans' `data-*` attributes.
   */
  stable?: boolean;
  /**
   * Distance from the viewer's left edge in px. Defaults to
   * {@link PERF_HUD_LEFT_DEFAULT}, which clears the Reset View button; hosts
   * that hide that button pass a smaller value so the HUD doesn't float with
   * an empty gap beside it.
   */
  left?: number;
}

const POLL_MS = 500;

const FIELD_STYLE = { whiteSpace: "nowrap" } as const;
/** Fields break only after the dot, so a wrapped line never starts with one. */
const SEPARATOR = "\u00a0· ";

/** "0.4 MB", "12.3 MB", "512 MB", "1.27 GB" (binary units, like browser task managers). */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function PerfHud({
  atomCount,
  bondCount,
  getStats,
  stable = false,
  left = PERF_HUD_LEFT_DEFAULT,
}: PerfHudProps) {
  const [stats, setStats] = useState<PerfHudStats>({ fps: 0, drawCalls: 0 });
  const [cpuLoad, setCpuLoad] = useState<number | null>(null);

  useEffect(() => watchMainThreadLoad(), []);

  useEffect(() => {
    const poll = () => {
      const next = getStats();
      if (next) setStats(next);
      setCpuLoad(mainThreadLoad());
    };
    poll(); // populate immediately so draws/fps don't linger at 0
    const id = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(id);
  }, [getStats]);

  const fpsText = stable ? "--" : String(Math.round(stats.fps));
  const cpuPercent = cpuLoad === null ? null : Math.round(cpuLoad * 100);
  const cpuText = stable || cpuPercent === null ? "--" : String(cpuPercent);
  const memBytes = stats.memoryBytes;
  const memText = stable || memBytes === undefined ? "-- MB" : formatBytes(memBytes);

  return (
    <div
      data-testid="perf-hud"
      style={{
        position: "absolute",
        top: 12,
        left,
        padding: "4px 8px",
        fontSize: 11,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
        background: "var(--megane-surface)",
        border: "1px solid var(--megane-border-solid)",
        borderRadius: 4,
        color: "var(--megane-text-body)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 10,
        userSelect: "none",
        pointerEvents: "none",
        // One line wherever it fits; on a narrow viewer, wrap between fields
        // rather than run past the edge.
        maxWidth: `calc(100% - ${left + OVERLAY_INSET}px)`,
      }}
    >
      <span data-testid="perf-hud-atoms" style={FIELD_STYLE}>
        Atoms {atomCount}
      </span>
      {SEPARATOR}
      <span data-testid="perf-hud-bonds" style={FIELD_STYLE}>
        Bonds {bondCount}
      </span>
      {SEPARATOR}
      <span data-testid="perf-hud-draws" style={FIELD_STYLE}>
        Draws {stats.drawCalls}
      </span>
      {SEPARATOR}
      <span data-testid="perf-hud-fps" style={FIELD_STYLE}>
        {fpsText} FPS
      </span>
      {SEPARATOR}
      <span data-testid="perf-hud-cpu" data-percent={cpuPercent ?? undefined} style={FIELD_STYLE}>
        CPU {cpuText}%
      </span>
      {SEPARATOR}
      <span data-testid="perf-hud-mem" data-bytes={memBytes} style={FIELD_STYLE}>
        Mem {memText}
      </span>
    </div>
  );
}
