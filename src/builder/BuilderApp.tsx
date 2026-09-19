/**
 * megane Builder — a structure editor, separate from the viewer.
 *
 * Open a structure file or start from an empty cell, edit atoms, bonds and
 * the cell by clicking in the 3D view, and save the result as XYZ / PDB /
 * MOL. There is no pipeline here: the view always shows the document
 * (`BuilderStore`) as ball-and-stick with every atom, its bonds and its cell,
 * and every click is an edit.
 *
 * Reuses the viewer's renderer (`Viewport` + `MoleculeRenderer`, driven through
 * `applyViewportState`), parsers, writers and the edit engine; nothing in the
 * viewer imports this app.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Viewport } from "../components/Viewport";
import { Tooltip } from "../components/Tooltip";
import { ViewAxisControls } from "../components/ViewAxisControls";
import { OVERLAY_INSET } from "../components/overlayLayout";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import { applyViewportState } from "../pipeline/apply";
import type { ViewportState } from "../pipeline/types";
import { parseStructureFile } from "../parsers/structure";
import { STRUCTURE_EXPORT_FORMATS, exportSnapshot } from "../export/structureExport";
import type { StructureWriteFormat } from "../parsers/parseCore";
import { useThemeStore, type Theme } from "../stores/useThemeStore";
import type { HoverInfo } from "../types";
import { useBuilderStore, shownSnapshot } from "./store";
import { builderViewportState, BUILDER_SOURCE_ID } from "./view";
import { useBuilderHandlers } from "./useBuilderHandlers";
import { BuilderSidebar, DEFAULT_NEW_CELL_EDGE, chipStyle, hintStyle } from "./BuilderSidebar";

const SIDEBAR_WIDTH = 320;

const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ORDER: Theme[] = ["system", "light", "dark"];

const barButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--megane-border-solid, #cbd5e1)",
  background: "var(--megane-surface-solid, #f8f9fb)",
  color: "var(--megane-text, #1e293b)",
  cursor: "pointer",
};

function barButton(disabled: boolean): React.CSSProperties {
  return {
    ...barButtonStyle,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "default" : "pointer",
  };
}

export function BuilderApp() {
  const api = useBuilderStore;
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const fileName = useBuilderStore((s) => s.fileName);
  const sourceLabels = useBuilderStore((s) => s.sourceLabels);
  const edits = useBuilderStore((s) => s.edits);
  const redoStack = useBuilderStore((s) => s.redoStack);
  const revision = useBuilderStore((s) => s.revision);
  const selected = useBuilderStore((s) => s.selected);
  const pendingBondAtom = useBuilderStore((s) => s.pendingBondAtom);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const newCell = useBuilderStore((s) => s.newCell);
  const openStructure = useBuilderStore((s) => s.openStructure);

  const shown = useMemo(
    () => shownSnapshot({ source, result, showOriginal }),
    [source, result, showOriginal],
  );
  const viewportState = useMemo(() => builderViewportState(shown), [shown]);

  const handlers = useBuilderHandlers(api);

  // ── Renderer ──
  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const prevViewportStateRef = useRef<ViewportState | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const applyState = useCallback(
    (renderer: MoleculeRenderer, vs: ViewportState) => {
      applyViewportState(
        renderer,
        vs,
        prevViewportStateRef.current,
        BUILDER_SOURCE_ID,
        sourceLabels,
      );
      prevViewportStateRef.current = vs;
    },
    [sourceLabels],
  );

  const handleRendererReady = useCallback(
    (renderer: MoleculeRenderer) => {
      rendererRef.current = renderer;
      renderer.setViewInsets(0, SIDEBAR_WIDTH + OVERLAY_INSET);
      applyState(renderer, viewportState);
    },
    // Only the first state matters here; later ones arrive through the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) applyState(renderer, viewportState);
  }, [viewportState, applyState]);

  // ── Open ──
  const inputRef = useRef<HTMLInputElement>(null);
  const handleOpenChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const parsed = await parseStructureFile(file);
        openStructure(parsed.snapshot, parsed.labels, file.name);
        setOpenError(null);
      } catch (err) {
        setOpenError(
          `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [openStructure],
  );

  const handleExport = useCallback(
    async (format: StructureWriteFormat) => {
      if (!shown) return;
      await exportSnapshot(shown, format, fileName, sourceLabels);
    },
    [shown, fileName, sourceLabels],
  );

  // ── View controls ──
  const handleResetView = useCallback(() => rendererRef.current?.resetCamera(), []);
  const handleAlignView = useCallback(
    (axis: ViewAxis) => rendererRef.current?.alignCameraToAxis(axis),
    [],
  );
  const hasCell = latticeVectors(shown?.box) !== null;

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cycleTheme = useCallback(() => {
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]);
  }, [theme, setTheme]);

  const preview = useMemo(() => {
    const set = new Set(selected);
    if (pendingBondAtom !== null) set.add(pendingBondAtom);
    return set.size > 0 ? [...set] : null;
  }, [selected, pendingBondAtom]);

  return (
    <div
      data-testid="megane-builder"
      data-atom-count={shown?.nAtoms ?? 0}
      data-bond-count={shown?.nBonds ?? 0}
      data-edit-count={edits.length}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--megane-bg, #fff)",
        color: "var(--megane-text, #1e293b)",
      }}
    >
      <div
        data-testid="builder-topbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--megane-border-solid, #e2e8f0)",
          background: "var(--megane-surface-solid, #f8f9fb)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>
          megane Builder
        </span>
        <span style={{ ...hintStyle, marginRight: 8 }} data-testid="builder-file-name">
          {fileName ?? "No structure"}
          {edits.length > 0 && ` · ${edits.length} edit${edits.length === 1 ? "" : "s"}`}
        </span>
        <button
          data-testid="builder-open"
          style={barButtonStyle}
          onClick={() => inputRef.current?.click()}
          title="Open a structure file"
        >
          Open…
        </button>
        <input
          ref={inputRef}
          data-testid="builder-open-input"
          type="file"
          style={{ display: "none" }}
          onChange={(e) => void handleOpenChange(e)}
        />
        <button
          data-testid="builder-new"
          style={barButtonStyle}
          onClick={() => newCell(DEFAULT_NEW_CELL_EDGE)}
          title={`Start from an empty ${DEFAULT_NEW_CELL_EDGE} Å cell`}
        >
          New
        </button>
        <button
          data-testid="builder-topbar-undo"
          style={barButton(edits.length === 0)}
          disabled={edits.length === 0}
          onClick={() => undo()}
        >
          Undo
        </button>
        <button
          data-testid="builder-topbar-redo"
          style={barButton(redoStack.length === 0)}
          disabled={redoStack.length === 0}
          onClick={() => redo()}
        >
          Redo
        </button>
        <span style={{ flex: 1 }} />
        {STRUCTURE_EXPORT_FORMATS.map((f) => (
          <button
            key={f.value}
            data-testid={`builder-save-${f.value}`}
            style={barButton(!shown)}
            disabled={!shown}
            onClick={() => void handleExport(f.value)}
          >
            Save {f.label}
          </button>
        ))}
        <button
          data-testid="builder-theme"
          style={barButtonStyle}
          onClick={cycleTheme}
          title={`Theme: ${THEME_LABELS[theme]} (click to cycle)`}
        >
          {THEME_LABELS[theme]}
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <Viewport
            snapshot={shown}
            frame={null}
            atomLabels={null}
            atomVectors={null}
            onRendererReady={handleRendererReady}
            onHover={setHoverInfo}
            previewIndices={preview}
            buildActive={true}
            buildHandlers={handlers}
            preserveCameraKey={revision}
          />
          <div
            data-testid="view-controls"
            style={{
              position: "absolute",
              top: OVERLAY_INSET,
              left: OVERLAY_INSET,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 4,
              zIndex: 10,
            }}
          >
            <button
              data-testid="reset-view-btn"
              title="Reset view (fit to structure, standard orientation)"
              onClick={handleResetView}
              style={{
                padding: "4px 8px",
                fontSize: 11,
                lineHeight: 1,
                background: "rgba(255,255,255,0.85)",
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 4,
                cursor: "pointer",
                color: "#374151",
                backdropFilter: "blur(4px)",
                userSelect: "none",
              }}
            >
              Reset View
            </button>
            <ViewAxisControls hasCell={hasCell} onAlign={handleAlignView} />
          </div>
          {!source && (
            <div
              data-testid="builder-welcome"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  pointerEvents: "auto",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  padding: 24,
                  borderRadius: 12,
                  background: "var(--megane-surface, rgba(255,255,255,0.92))",
                  border: "1px solid var(--megane-border-solid, #e2e8f0)",
                  boxShadow: "0 4px 24px var(--megane-shadow, rgba(0,0,0,0.06))",
                }}
              >
                <div style={{ fontWeight: 600 }}>Build a structure</div>
                <div style={hintStyle}>
                  Open a file (PDB, XYZ, MOL, CIF, …) or start from an empty cell.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <span
                    role="button"
                    data-testid="builder-welcome-open"
                    style={chipStyle(true)}
                    onClick={() => inputRef.current?.click()}
                  >
                    Open…
                  </span>
                  <span
                    role="button"
                    data-testid="builder-welcome-new"
                    style={chipStyle(false)}
                    onClick={() => newCell(DEFAULT_NEW_CELL_EDGE)}
                  >
                    New empty cell ({DEFAULT_NEW_CELL_EDGE} Å)
                  </span>
                </div>
              </div>
            </div>
          )}
          {openError && (
            <div
              data-testid="builder-open-error"
              role="alert"
              style={{
                position: "absolute",
                left: OVERLAY_INSET,
                bottom: OVERLAY_INSET,
                padding: "6px 10px",
                borderRadius: 6,
                background: "rgba(220, 38, 38, 0.1)",
                color: "#991b1b",
                fontSize: 12,
                maxWidth: "60%",
              }}
            >
              {openError}
              <button
                style={{ ...barButtonStyle, marginLeft: 8, padding: "2px 6px" }}
                onClick={() => setOpenError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          <Tooltip info={hoverInfo} />
        </div>
        <div
          style={{
            width: SIDEBAR_WIDTH,
            borderLeft: "1px solid var(--megane-border-solid, #e2e8f0)",
            background: "var(--megane-surface-solid, #f8f9fb)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <BuilderSidebar />
        </div>
      </div>

      <div
        data-testid="builder-statusbar"
        style={{
          display: "flex",
          gap: 16,
          padding: "4px 12px",
          borderTop: "1px solid var(--megane-border-solid, #e2e8f0)",
          background: "var(--megane-surface-solid, #f8f9fb)",
          ...hintStyle,
        }}
      >
        <span data-testid="builder-status-atoms">
          {shown ? `${shown.nAtoms} atoms · ${shown.nBonds} bonds` : "No structure"}
        </span>
        {hasCell && <span>Cell</span>}
        {showOriginal && <span>Showing original</span>}
      </div>
    </div>
  );
}
