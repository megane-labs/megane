/**
 * Small performance readout shown next to the Reset View button.
 *
 * Displays the loaded atom count, bond count, per-frame draw calls, and render
 * FPS. Atom/bond counts come from React state in the parent; FPS and draw calls
 * are polled from the renderer on an interval (NOT per render frame — the parent
 * deliberately avoids per-frame React renders, see MeganeViewer's snapshot
 * subscription comment).
 */

import { useEffect, useState } from "react";
import { PERF_HUD_LEFT_DEFAULT } from "./overlayLayout";

interface PerfHudProps {
  atomCount: number;
  bondCount: number;
  getStats: () => { fps: number; drawCalls: number } | null;
  /**
   * When true, render a fixed FPS placeholder instead of the live value. Used by
   * E2E so screenshot baselines stay deterministic (FPS digits vary per run).
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

export function PerfHud({
  atomCount,
  bondCount,
  getStats,
  stable = false,
  left = PERF_HUD_LEFT_DEFAULT,
}: PerfHudProps) {
  const [stats, setStats] = useState<{ fps: number; drawCalls: number }>({
    fps: 0,
    drawCalls: 0,
  });

  useEffect(() => {
    const poll = () => {
      const next = getStats();
      if (next) setStats(next);
    };
    poll(); // populate immediately so draws/fps don't linger at 0
    const id = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(id);
  }, [getStats]);

  const fpsText = stable ? "--" : String(Math.round(stats.fps));

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
        whiteSpace: "nowrap",
      }}
    >
      <span data-testid="perf-hud-atoms">Atoms {atomCount}</span>
      {" · "}
      <span data-testid="perf-hud-bonds">Bonds {bondCount}</span>
      {" · "}
      <span data-testid="perf-hud-draws">Draws {stats.drawCalls}</span>
      {" · "}
      <span data-testid="perf-hud-fps">{fpsText} FPS</span>
    </div>
  );
}
