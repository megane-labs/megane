/**
 * Trajectory playback timeline with play/pause, step, seek, speed, loop range,
 * and keyboard shortcut support (ArrowLeft / ArrowRight to step frames).
 */

import { useEffect, useCallback } from "react";

interface TimelineProps {
  currentFrame: number;
  totalFrames: number;
  playing: boolean;
  fps: number;
  speedMultiplier: number;
  loopStart: number;
  loopEnd: number;
  onSeek: (frame: number) => void;
  onPlayPause: () => void;
  onFpsChange: (fps: number) => void;
  onSpeedChange: (speed: number) => void;
  onLoopRangeChange: (start: number, end: number) => void;
  onStepBackward: () => void;
  onStepForward: () => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;
const FPS_OPTIONS = [10, 20, 30, 60] as const;

const buttonStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  width: 28,
  height: 28,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  color: "var(--megane-text-secondary)",
  flexShrink: 0,
  transition: "all 0.15s",
  padding: 0,
};

const selectStyle: React.CSSProperties = {
  background: "var(--megane-surface)",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 6,
  padding: "2px 4px",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--megane-text-secondary)",
  cursor: "pointer",
  flexShrink: 0,
};

export function Timeline({
  currentFrame,
  totalFrames,
  playing,
  fps,
  speedMultiplier,
  loopStart,
  loopEnd,
  onSeek,
  onPlayPause,
  onFpsChange,
  onSpeedChange,
  onLoopRangeChange,
  onStepBackward,
  onStepForward,
}: TimelineProps) {
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSeek(parseInt(e.target.value, 10));
    },
    [onSeek],
  );

  // Keyboard shortcuts: ArrowLeft / ArrowRight step one frame
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onStepBackward();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onStepForward();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onStepBackward, onStepForward]);

  if (totalFrames <= 1) return null;

  const handleLoopStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) onLoopRangeChange(val, loopEnd);
  };

  const handleLoopEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) onLoopRangeChange(loopStart, val);
  };

  return (
    <div
      data-testid="timeline-root"
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "8px 16px 12px",
        background: "var(--megane-surface)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderTop: "1px solid var(--megane-border)",
        boxShadow: "0 -1px 8px rgba(0,0,0,0.04)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        zIndex: 10,
        fontSize: 13,
        color: "var(--megane-text-secondary)",
      }}
    >
      {/* Step backward */}
      <button
        data-testid="step-backward"
        onClick={onStepBackward}
        style={buttonStyle}
        title="Step backward (←)"
      >
        ⏮
      </button>

      {/* Play/Pause */}
      <button
        data-testid="playback-toggle"
        data-playing={playing ? "true" : "false"}
        onClick={onPlayPause}
        style={{ ...buttonStyle, width: 32, height: 32, fontSize: 14, fontWeight: 500 }}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? "⏸" : "▶"}
      </button>

      {/* Step forward */}
      <button
        data-testid="step-forward"
        onClick={onStepForward}
        style={buttonStyle}
        title="Step forward (→)"
      >
        ⏭
      </button>

      {/* Frame counter */}
      <span
        data-testid="frame-counter"
        style={{
          minWidth: 72,
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 500,
          color: "var(--megane-text-secondary)",
          flexShrink: 0,
          fontSize: 12,
        }}
      >
        {currentFrame + 1} / {totalFrames}
      </span>

      {/* Seek slider */}
      <input
        data-testid="playback-seekbar"
        type="range"
        min={0}
        max={totalFrames - 1}
        value={currentFrame}
        onChange={handleSliderChange}
        style={{
          flex: 1,
          height: 4,
          cursor: "pointer",
          accentColor: "var(--megane-primary)",
          minWidth: 60,
        }}
      />

      {/* Loop range */}
      <span style={{ fontSize: 11, color: "var(--megane-text-muted)", flexShrink: 0 }}>Loop</span>
      <input
        data-testid="loop-start"
        type="number"
        min={0}
        max={totalFrames - 1}
        value={loopStart}
        onChange={handleLoopStartChange}
        style={{
          ...selectStyle,
          width: 52,
          textAlign: "center",
          padding: "2px 4px",
        }}
        title="Loop start frame (0-based)"
      />
      <span style={{ fontSize: 11, color: "var(--megane-text-muted)" }}>–</span>
      <input
        data-testid="loop-end"
        type="number"
        min={0}
        max={totalFrames - 1}
        value={loopEnd}
        onChange={handleLoopEndChange}
        style={{
          ...selectStyle,
          width: 52,
          textAlign: "center",
          padding: "2px 4px",
        }}
        title="Loop end frame (0-based)"
      />

      {/* Speed multiplier */}
      <select
        data-testid="playback-speed"
        value={speedMultiplier}
        onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
        style={selectStyle}
        title="Playback speed"
      >
        {SPEED_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>

      {/* FPS selector */}
      <select
        data-testid="playback-fps"
        value={fps}
        onChange={(e) => onFpsChange(parseInt(e.target.value, 10))}
        style={selectStyle}
      >
        {FPS_OPTIONS.map((f) => (
          <option key={f} value={f}>
            {f} fps
          </option>
        ))}
      </select>
    </div>
  );
}
