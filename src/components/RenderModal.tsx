/**
 * Render export modal – snapshot (PNG/EPS) and animation (GIF/MP4).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { createPortal } from "react-dom";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import {
  captureSnapshot,
  captureGif,
  captureVideo,
  captureGltf,
  captureObj,
  downloadBlob,
} from "../renderer/RenderCapture";

type Mode = "snapshot" | "animation";
type SnapshotFormat = "png" | "eps" | "svg" | "gltf" | "obj";
type AnimationFormat = "gif" | "mp4";

const ANIMATION_UNAVAILABLE_HINT =
  "Animation is unavailable: the current structure has only 1 frame. " +
  "Load a trajectory (2+ frames) to export GIF/MP4.";

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

/** Standard output resolutions offered in the Resolution dropdown. */
export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { label: "HD 16:9", width: 1280, height: 720 },
  { label: "Full HD 16:9", width: 1920, height: 1080 },
  { label: "4K UHD 16:9", width: 3840, height: 2160 },
  { label: "XGA 4:3", width: 1024, height: 768 },
  { label: "UXGA 4:3", width: 1600, height: 1200 },
  { label: "Square 1:1", width: 1024, height: 1024 },
  { label: "Square 1:1", width: 2048, height: 2048 },
  { label: "Portrait 3:4", width: 768, height: 1024 },
  { label: "Portrait 9:16", width: 720, height: 1280 },
  { label: "Portrait 9:16", width: 1080, height: 1920 },
];

/**
 * Defaults picked on open, one per aspect ratio, all around one megapixel.
 * Larger output is one Scale step (2× / 4×) away.
 */
const DEFAULT_PRESETS: readonly ResolutionPreset[] = [
  RESOLUTION_PRESETS[0], // 1280×720
  RESOLUTION_PRESETS[3], // 1024×768
  RESOLUTION_PRESETS[5], // 1024×1024
  RESOLUTION_PRESETS[7], // 768×1024
  RESOLUTION_PRESETS[8], // 720×1280
];

/**
 * Pick the default output resolution for a viewport: the standard preset
 * whose aspect ratio is closest to the viewport's, so the export frames the
 * scene like the screen does without inheriting its odd pixel size.
 */
export function defaultResolutionFor(viewW: number, viewH: number): ResolutionPreset {
  if (!(viewW > 0) || !(viewH > 0)) return DEFAULT_PRESETS[0];
  const target = Math.log(viewW / viewH);
  let best = DEFAULT_PRESETS[0];
  let bestDiff = Infinity;
  for (const p of DEFAULT_PRESETS) {
    const diff = Math.abs(Math.log(p.width / p.height) - target);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }
  return best;
}

function presetKey(w: number, h: number): string {
  return `${w}x${h}`;
}

interface RenderModalProps {
  open: boolean;
  onClose: () => void;
  rendererRef: React.RefObject<MoleculeRenderer | null>;
  totalFrames: number;
  currentFrame: number;
  onSeek: (frame: number) => void;
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.3)",
  backdropFilter: "blur(4px)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panelStyle: React.CSSProperties = {
  background: "var(--megane-surface)",
  backdropFilter: "blur(16px)",
  borderRadius: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
  border: "1px solid var(--megane-border)",
  maxWidth: 440,
  width: "90vw",
  maxHeight: "85vh",
  overflow: "auto",
  padding: "20px 24px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--megane-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 6,
  marginTop: 14,
};

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  padding: "6px 10px",
  background: "var(--megane-surface-raised)",
  color: "var(--megane-text)",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
  appearance: "auto" as const,
};

const tabContainerStyle: React.CSSProperties = {
  display: "flex",
  borderRadius: 10,
  overflow: "hidden",
  border: "1px solid var(--megane-border-solid)",
  marginBottom: 10,
};

function TabButton({
  label,
  active,
  onClick,
  testid,
  disabled = false,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testid?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={active || disabled ? undefined : onClick}
      data-testid={testid}
      data-active={active}
      disabled={disabled}
      aria-disabled={disabled}
      title={title}
      style={{
        flex: 1,
        background: active ? "rgba(59,130,246,0.08)" : "none",
        border: "none",
        padding: "7px 0",
        cursor: disabled ? "not-allowed" : active ? "default" : "pointer",
        fontSize: 12,
        fontWeight: 600,
        color: active ? "var(--megane-primary)" : "var(--megane-text-muted)",
        opacity: disabled ? 0.4 : 1,
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}

export function RenderModal({
  open,
  onClose,
  rendererRef,
  totalFrames,
  currentFrame,
  onSeek,
}: RenderModalProps) {
  const [mode, setMode] = useState<Mode>("snapshot");
  const [snapshotFormat, setSnapshotFormat] = useState<SnapshotFormat>("png");
  const [animationFormat, setAnimationFormat] = useState<AnimationFormat>("gif");
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [scaleFactor, setScaleFactor] = useState(1);
  const [lockAspect, setLockAspect] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(Math.max(0, totalFrames - 1));
  const [animFps, setAnimFps] = useState(30);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const aspectRef = useRef(1280 / 720);

  // On open, default to the standard resolution closest to the viewport's
  // aspect ratio rather than the viewport's raw pixel size.
  useEffect(() => {
    if (open && rendererRef.current) {
      const canvas = rendererRef.current.getCanvas();
      if (canvas) {
        const preset = defaultResolutionFor(canvas.clientWidth, canvas.clientHeight);
        setWidth(preset.width);
        setHeight(preset.height);
        aspectRef.current = preset.width / preset.height;
      }
    }
  }, [open, rendererRef]);

  // Sync frame range on open
  useEffect(() => {
    if (open) {
      setStartFrame(0);
      setEndFrame(Math.max(0, totalFrames - 1));
    }
  }, [open, totalFrames]);

  // Escape closes the modal, matching the backdrop click (both are disabled
  // mid-export). Always marked handled so it can't fall through to
  // MeganeViewer's selection-clearing listener and wipe the selection behind
  // an open modal.
  useDismiss({
    onDismiss: () => {
      if (!exporting) onClose();
    },
    enabled: open,
  });

  const handleWidthChange = useCallback(
    (newW: number) => {
      setWidth(newW);
      if (lockAspect) {
        setHeight(Math.round(newW / aspectRef.current));
      }
    },
    [lockAspect],
  );

  const handleHeightChange = useCallback(
    (newH: number) => {
      setHeight(newH);
      if (lockAspect) {
        setWidth(Math.round(newH * aspectRef.current));
      }
    },
    [lockAspect],
  );

  const handlePresetChange = useCallback((key: string) => {
    const preset = RESOLUTION_PRESETS.find((p) => presetKey(p.width, p.height) === key);
    if (!preset) return;
    setWidth(preset.width);
    setHeight(preset.height);
    aspectRef.current = preset.width / preset.height;
  }, []);

  const activePresetKey = RESOLUTION_PRESETS.some((p) => p.width === width && p.height === height)
    ? presetKey(width, height)
    : "custom";

  const handleExport = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    setExporting(true);
    setProgress(0);

    try {
      const finalW = width * scaleFactor;
      const finalH = height * scaleFactor;

      if (mode === "snapshot") {
        if (snapshotFormat === "gltf") {
          const blob = await captureGltf(renderer);
          downloadBlob(blob, "megane-render.glb");
        } else if (snapshotFormat === "obj") {
          const blob = captureObj(renderer);
          downloadBlob(blob, "megane-render.obj");
        } else {
          const blob = await captureSnapshot(renderer, {
            width: finalW,
            height: finalH,
            transparent: transparent && snapshotFormat === "png",
            format: snapshotFormat as "png" | "eps" | "svg",
          });
          const ext = snapshotFormat === "eps" ? "eps" : snapshotFormat === "svg" ? "svg" : "png";
          downloadBlob(blob, `megane-render.${ext}`);
        }
      } else {
        if (animationFormat === "gif") {
          const blob = await captureGif(renderer, {
            width: finalW,
            height: finalH,
            transparent,
            startFrame,
            endFrame,
            fps: animFps,
            seekFrame: onSeek,
            onProgress: setProgress,
          });
          downloadBlob(blob, "megane-render.gif");
        } else {
          const blob = await captureVideo(renderer, {
            width: finalW,
            height: finalH,
            transparent,
            startFrame,
            endFrame,
            fps: animFps,
            seekFrame: onSeek,
            onProgress: setProgress,
          });
          downloadBlob(blob, "megane-render.webm");
        }
        // Restore to the frame we were on
        onSeek(currentFrame);
      }
    } catch (err) {
      console.error("Export failed:", err);
      alert("Export failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
      setProgress(0);
    }
  }, [
    rendererRef,
    mode,
    snapshotFormat,
    animationFormat,
    width,
    height,
    scaleFactor,
    transparent,
    startFrame,
    endFrame,
    animFps,
    onSeek,
    currentFrame,
  ]);

  if (!open) return null;

  const hasAnimation = totalFrames > 1;
  const is3DFormat = mode === "snapshot" && (snapshotFormat === "gltf" || snapshotFormat === "obj");

  return createPortal(
    <div
      style={backdropStyle}
      onClick={exporting ? undefined : onClose}
      data-testid="render-modal-backdrop"
    >
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        data-testid="render-modal"
        data-mode={hasAnimation ? "with-animation" : "snapshot-only"}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--megane-text)" }}>Render</span>
          <button
            onClick={onClose}
            disabled={exporting}
            style={{
              background: "none",
              border: "none",
              cursor: exporting ? "default" : "pointer",
              fontSize: 18,
              color: "var(--megane-text-muted)",
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {/* Mode tabs */}
        <div style={tabContainerStyle}>
          <TabButton
            label="Snapshot"
            testid="render-modal-tab-snapshot"
            active={mode === "snapshot"}
            onClick={() => setMode("snapshot")}
          />
          <TabButton
            label="Animation"
            testid="render-modal-tab-animation"
            active={mode === "animation"}
            disabled={!hasAnimation}
            title={hasAnimation ? undefined : ANIMATION_UNAVAILABLE_HINT}
            onClick={() => setMode("animation")}
          />
        </div>
        {!hasAnimation && mode === "snapshot" && (
          <div
            data-testid="render-modal-animation-hint"
            style={{
              fontSize: 11,
              color: "var(--megane-text-muted)",
              marginBottom: 8,
            }}
          >
            {ANIMATION_UNAVAILABLE_HINT}
          </div>
        )}

        {/* Format selector */}
        <div style={labelStyle}>Format</div>
        <div style={tabContainerStyle}>
          {mode === "snapshot" ? (
            <>
              <TabButton
                label="PNG"
                testid="render-modal-format-png"
                active={snapshotFormat === "png"}
                onClick={() => setSnapshotFormat("png")}
              />
              <TabButton
                label="EPS"
                testid="render-modal-format-eps"
                active={snapshotFormat === "eps"}
                onClick={() => setSnapshotFormat("eps")}
              />
              <TabButton
                label="SVG"
                testid="render-modal-format-svg"
                active={snapshotFormat === "svg"}
                onClick={() => setSnapshotFormat("svg")}
              />
              <TabButton
                label="glTF"
                testid="render-modal-format-gltf"
                active={snapshotFormat === "gltf"}
                onClick={() => setSnapshotFormat("gltf")}
              />
              <TabButton
                label="OBJ"
                testid="render-modal-format-obj"
                active={snapshotFormat === "obj"}
                onClick={() => setSnapshotFormat("obj")}
              />
            </>
          ) : (
            <>
              <TabButton
                label="GIF"
                testid="render-modal-format-gif"
                active={animationFormat === "gif"}
                onClick={() => setAnimationFormat("gif")}
              />
              <TabButton
                label="MP4"
                testid="render-modal-format-mp4"
                active={animationFormat === "mp4"}
                onClick={() => setAnimationFormat("mp4")}
              />
            </>
          )}
        </div>

        {/* Resolution (not applicable for 3D exports) */}
        {!is3DFormat && (
          <>
            <div style={labelStyle}>Resolution</div>
            <select
              value={activePresetKey}
              onChange={(e) => handlePresetChange(e.target.value)}
              style={{ ...selectStyle, marginBottom: 8 }}
              disabled={exporting}
              data-testid="render-modal-preset"
            >
              {RESOLUTION_PRESETS.map((p) => (
                <option key={presetKey(p.width, p.height)} value={presetKey(p.width, p.height)}>
                  {p.label} — {p.width} × {p.height}
                </option>
              ))}
              <option value="custom" disabled>
                Custom
              </option>
            </select>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={width}
                onChange={(e) => handleWidthChange(parseInt(e.target.value) || 1)}
                style={{ ...inputStyle, width: "auto", flex: 1 }}
                min={1}
                max={7680}
                disabled={exporting}
                data-testid="render-modal-width"
              />
              <span style={{ color: "var(--megane-text-muted)", fontSize: 12, fontWeight: 600 }}>
                ×
              </span>
              <input
                type="number"
                value={height}
                onChange={(e) => handleHeightChange(parseInt(e.target.value) || 1)}
                style={{ ...inputStyle, width: "auto", flex: 1 }}
                min={1}
                max={4320}
                disabled={exporting}
                data-testid="render-modal-height"
              />
            </div>

            {/* Scale factor + aspect lock */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ ...labelStyle, marginTop: 0, marginBottom: 4 }}>Scale</div>
                <select
                  value={scaleFactor}
                  onChange={(e) => setScaleFactor(parseInt(e.target.value))}
                  style={selectStyle}
                  disabled={exporting}
                >
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--megane-text-secondary)",
                  cursor: "pointer",
                  paddingTop: 16,
                }}
              >
                <input
                  type="checkbox"
                  checked={lockAspect}
                  onChange={(e) => setLockAspect(e.target.checked)}
                  disabled={exporting}
                />
                Lock aspect
              </label>
            </div>

            {/* Output resolution preview */}
            <div
              style={{
                fontSize: 11,
                color: "var(--megane-text-muted)",
                marginTop: 6,
              }}
            >
              Output: {width * scaleFactor} × {height * scaleFactor} px
            </div>
          </>
        )}

        {/* Transparent background (PNG only for snapshot; hidden for 3D formats) */}
        {(mode === "snapshot" ? snapshotFormat === "png" : true) && (
          <>
            <div style={labelStyle}>Options</div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--megane-text-secondary)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => setTransparent(e.target.checked)}
                disabled={exporting}
              />
              Transparent background
            </label>
          </>
        )}

        {/* Animation settings */}
        {mode === "animation" && (
          <>
            <div style={labelStyle}>Frame Range</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={startFrame}
                onChange={(e) =>
                  setStartFrame(Math.max(0, Math.min(parseInt(e.target.value) || 0, endFrame)))
                }
                style={{ ...inputStyle, width: "auto", flex: 1 }}
                min={0}
                max={endFrame}
                disabled={exporting}
                data-testid="render-modal-start-frame"
              />
              <span style={{ color: "var(--megane-text-muted)", fontSize: 12, fontWeight: 600 }}>
                –
              </span>
              <input
                type="number"
                value={endFrame}
                onChange={(e) =>
                  setEndFrame(
                    Math.min(totalFrames - 1, Math.max(parseInt(e.target.value) || 0, startFrame)),
                  )
                }
                style={{ ...inputStyle, width: "auto", flex: 1 }}
                min={startFrame}
                max={totalFrames - 1}
                disabled={exporting}
                data-testid="render-modal-end-frame"
              />
            </div>
            <div style={{ fontSize: 11, color: "var(--megane-text-muted)", marginTop: 4 }}>
              {endFrame - startFrame + 1} frames (total: {totalFrames})
            </div>

            <div style={labelStyle}>FPS</div>
            <select
              value={animFps}
              onChange={(e) => setAnimFps(parseInt(e.target.value))}
              style={selectStyle}
              disabled={exporting}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </>
        )}

        {/* Progress bar */}
        {exporting && (
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "var(--megane-border-solid)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(progress * 100)}%`,
                  background: "#3b82f6",
                  borderRadius: 3,
                  transition: "width 0.2s",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--megane-text-muted)",
                marginTop: 4,
                textAlign: "center",
              }}
            >
              Exporting... {Math.round(progress * 100)}%
            </div>
          </div>
        )}

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={exporting}
          data-testid="render-modal-export"
          style={{
            width: "100%",
            marginTop: 20,
            padding: "10px 0",
            borderRadius: 10,
            border: "none",
            background: exporting ? "#94a3b8" : "#3b82f6",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            cursor: exporting ? "default" : "pointer",
            transition: "all 0.15s",
          }}
        >
          {exporting
            ? "Exporting..."
            : mode === "snapshot"
              ? snapshotFormat === "gltf"
                ? "Export glTF (.glb)"
                : snapshotFormat === "obj"
                  ? "Export OBJ"
                  : `Export ${snapshotFormat.toUpperCase()}`
              : `Export ${animationFormat.toUpperCase()}`}
        </button>
      </div>
    </div>,
    document.body,
  );
}
