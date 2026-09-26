/**
 * megane Builder — a structure editor, separate from the viewer.
 *
 * Open a structure file or start from an empty cell, edit atoms, bonds and
 * the cell by clicking in the 3D view, and save the result as XYZ / PDB /
 * MOL. There is no pipeline here: the view always shows the document
 * (`BuilderStore`) as ball-and-stick with every atom, its bonds and its cell,
 * and every click is an edit.
 *
 * The shell is in four places and each control appears in exactly one of
 * them: the **top bar** owns the document (open, new, undo / redo, save),
 * the **sidebar** owns the tools and the structure's own edits, the
 * **status bar** says what is on screen and what the current tool does, and
 * a single **notice** line carries every message. Keyboard shortcuts are in
 * `shortcuts.ts`.
 *
 * Reuses the viewer's renderer (`Viewport` + `MoleculeRenderer`, driven through
 * `applyViewportState`), parsers, writers and the edit engine; nothing in the
 * viewer imports this app.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
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
import { useBuilderShortcuts, TOOL_KEYS } from "./shortcuts";
import { BuilderSidebar, TOOLS } from "./BuilderSidebar";
import { Menu } from "./Menu";
import { NewStructureDialog, type NewStructureKind } from "./NewStructureDialog";
import { buttonStyle, hintStyle } from "./styles";
import { trackEvent, trackFileOpen } from "../analytics";

const SIDEBAR_WIDTH = 320;

const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ORDER: Theme[] = ["system", "light", "dark"];

/** ⌘ on a Mac, Ctrl elsewhere, for the shortcut hints in the tooltips. */
function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
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
  const tool = useBuilderStore((s) => s.tool);
  const pendingBondAtom = useBuilderStore((s) => s.pendingBondAtom);
  const notice = useBuilderStore((s) => s.notice);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const newCell = useBuilderStore((s) => s.newCell);
  const newBulk = useBuilderStore((s) => s.newBulk);
  const openStructure = useBuilderStore((s) => s.openStructure);
  const setNotice = useBuilderStore((s) => s.setNotice);
  const reportError = useBuilderStore((s) => s.reportError);

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
  const [newDialog, setNewDialog] = useState<NewStructureKind | null>(null);
  const [dropActive, setDropActive] = useState(false);

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
  const openFile = useCallback(
    async (file: File) => {
      try {
        const parsed = await parseStructureFile(file);
        openStructure(parsed.snapshot, parsed.labels, file.name);
        trackFileOpen("structure", file.name);
      } catch (err) {
        reportError(
          `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [openStructure, reportError],
  );
  const handleOpenChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) await openFile(file);
    },
    [openFile],
  );
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDropActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    },
    [openFile],
  );

  const handleExport = useCallback(
    async (format: StructureWriteFormat) => {
      if (!shown) return;
      await exportSnapshot(shown, format, fileName, sourceLabels);
      trackEvent("export_structure", { file_format: format });
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

  // ── Keyboard ──
  const shortcutHost = useMemo(
    () => ({
      open: () => inputRef.current?.click(),
      save: () => void handleExport(STRUCTURE_EXPORT_FORMATS[0].value),
      resetView: () => rendererRef.current?.resetCamera(),
    }),
    [handleExport],
  );
  useBuilderShortcuts(api, shortcutHost);
  const mod = modKeyLabel();

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

  const activeTool = TOOLS.find((t) => t.value === tool)!;

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
          type="button"
          data-testid="builder-open"
          style={buttonStyle()}
          onClick={() => inputRef.current?.click()}
          title={`Open a structure file (${mod}+O)`}
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
        <Menu
          testId="builder-new"
          label="New"
          title="Start a new structure (replaces the open one)"
          items={[
            {
              label: "Empty cell…",
              testId: "builder-new-cell-item",
              onSelect: () => setNewDialog("cell"),
            },
            {
              label: "Bulk crystal…",
              testId: "builder-new-bulk-item",
              onSelect: () => setNewDialog("bulk"),
            },
          ]}
        />
        <button
          type="button"
          data-testid="builder-topbar-undo"
          style={buttonStyle("default", edits.length === 0)}
          disabled={edits.length === 0}
          title={`Undo (${mod}+Z)`}
          onClick={() => undo()}
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="builder-topbar-redo"
          style={buttonStyle("default", redoStack.length === 0)}
          disabled={redoStack.length === 0}
          title={`Redo (${mod}+Shift+Z)`}
          onClick={() => redo()}
        >
          Redo
        </button>
        <span style={{ flex: 1 }} />
        <Menu
          testId="builder-save"
          label="Save"
          variant="primary"
          disabled={!shown}
          title={`Save the edited structure (${mod}+S saves XYZ)`}
          items={STRUCTURE_EXPORT_FORMATS.map((f) => ({
            label: `Save ${f.label}`,
            testId: `builder-save-${f.value}`,
            onSelect: () => void handleExport(f.value),
          }))}
        />
        <button
          type="button"
          data-testid="builder-theme"
          style={buttonStyle()}
          onClick={cycleTheme}
          title={`Theme: ${THEME_LABELS[theme]} (click to cycle)`}
        >
          {THEME_LABELS[theme]}
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{ flex: 1, position: "relative", minWidth: 0 }}
          onDragOver={(e) => {
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropActive(false);
          }}
          onDrop={handleDrop}
          data-testid="builder-dropzone"
        >
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
              title="Reset view (fit to structure, standard orientation) — R"
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
                  Open a file (PDB, XYZ, MOL, CIF, …) — or drop one here — or start from scratch.
                </div>
                <div
                  style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}
                >
                  <button
                    type="button"
                    data-testid="builder-welcome-open"
                    style={buttonStyle("primary")}
                    onClick={() => inputRef.current?.click()}
                  >
                    Open…
                  </button>
                  <button
                    type="button"
                    data-testid="builder-welcome-new"
                    style={buttonStyle()}
                    onClick={() => setNewDialog("cell")}
                  >
                    New empty cell…
                  </button>
                  <button
                    type="button"
                    data-testid="builder-welcome-bulk"
                    style={buttonStyle()}
                    onClick={() => setNewDialog("bulk")}
                  >
                    New bulk crystal…
                  </button>
                </div>
              </div>
            </div>
          )}
          {dropActive && (
            <div
              data-testid="builder-drop-overlay"
              style={{
                position: "absolute",
                inset: 8,
                borderRadius: 10,
                border: "2px dashed #2563eb",
                background: "rgba(37, 99, 235, 0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                color: "#1d4ed8",
                pointerEvents: "none",
              }}
            >
              Drop a structure file to open it
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

      {notice && (
        <div
          data-testid="builder-notice"
          data-level={notice.level}
          role={notice.level === "error" ? "alert" : "status"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            fontSize: 12,
            borderTop: "1px solid var(--megane-border-solid, #e2e8f0)",
            background:
              notice.level === "error" ? "rgba(220, 38, 38, 0.1)" : "rgba(37, 99, 235, 0.08)",
            color: notice.level === "error" ? "#991b1b" : "var(--megane-text, #1e293b)",
          }}
        >
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button
            type="button"
            data-testid="builder-notice-dismiss"
            style={buttonStyle()}
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

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
        {hasCell && <span data-testid="builder-status-cell">Cell</span>}
        {selected.length > 0 && (
          <span data-testid="builder-status-selection">{selected.length} selected</span>
        )}
        <span style={{ flex: 1 }} />
        <span data-testid="builder-status-tool">
          {activeTool.label} ({TOOL_KEYS[activeTool.value]}) · {activeTool.hint}
        </span>
        {showOriginal && <span>Showing original</span>}
      </div>

      {newDialog && (
        <NewStructureDialog
          initialKind={newDialog}
          hasDocument={!!source}
          onNewCell={newCell}
          onNewBulk={newBulk}
          onClose={() => setNewDialog(null)}
        />
      )}
    </div>
  );
}
