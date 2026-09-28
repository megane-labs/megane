/**
 * Render export modal – snapshot (PNG/EPS) and animation (GIF/MP4).
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      onClick={active ? undefined : onClick}
      data-testid={testid}
      data-active={active}
      style={{
        flex: 1,
        background: active ? "rgba(59,130,246,0.08)" : "none",
        border: "none",
        padding: "7px 0",
        cursor: active ? "default" : "pointer",
        fontSize: 12,
        fontWeight: 600,
        color: active ? "var(--megane-primary)" : "var(--megane-text-muted)",
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
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [scaleFactor, setScaleFactor] = useState(1);
  const [lockAspect, setLockAspect] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(Math.max(0, totalFrames - 1));
  const [animFps, setAnimFps] = useState(30);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const aspectRef = useRef(1920 / 1080);

  // Sync resolution from viewport on open
  useEffect(() => {
    if (open && rendererRef.current) {
      const canvas = rendererRef.current.getCanvas();
      if (canvas) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        setWidth(w);
        setHeight(h);
        aspectRef.current = w / h;
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
  // mid-export). Registered in the capture phase and always marked handled so
  // it can't fall through to MeganeViewer's selection-clearing listener and
  // wipe the selection behind an open modal.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (!exporting) onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, exporting, onClose]);

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
            onClick={() => {
              if (hasAnimation) setMode("animation");
            }}
          />
        </div>
        {!hasAnimation && mode === "snapshot" && (
          <div
            style={{
              fontSize: 11,
              color: "var(--megane-text-muted)",
              marginBottom: 8,
              fontStyle: "italic",
            }}
          >
            Load a trajectory for animation export.
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
