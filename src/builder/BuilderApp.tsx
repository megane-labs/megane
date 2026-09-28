/**
 * megane Builder — a structure editor, separate from the viewer.
 *
 * Open a structure file or start from an empty cell, edit atoms, bonds and
 * the cell by clicking in the 3D view, and save the result as XYZ / PDB /
 * MOL. There is no pipeline here: the view always shows the document
 * (`BuilderStore`) as ball-and-stick with every atom, its bonds and its cell,
 * and every click is an edit.
 *
 * The shell follows the viewer's design: the 3D view fills the window and
 * every control floats over it on frosted-glass panels, each control in
 * exactly one of them. Everything you *do* is on the left, everything you
 * *read* on the right. The **top-left corner** holds Reset View and the axis
 * buttons as in the viewer, with the **tool rail** under them and the
 * **operations rail** under that (File; Structure, Insert, Tools; Undo /
 * Redo; theme — menus open to the right). On the right, the viewer's
 * collapsible panels (where the viewer keeps its Pipeline): **Details**
 * shows the options of whatever was picked on the left — the current tool's
 * settings (`ContextBar`) and the selection, or the form a menu opened (a
 * Structure operation, a new document, the tool server, a Python tool) —
 * and **History**, under it, the edit list. The **info line** beside Reset
 * View says what the document and the structure are, as the viewer's HUD
 * does; the **bottom-left** status line says what the current tool does,
 * under the single **notice** line that carries every message. Keyboard
 * shortcuts are in `shortcuts.ts`.
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
import { CollapsiblePanel } from "../components/CollapsiblePanel";
import { ViewAxisControls } from "../components/ViewAxisControls";
import { OVERLAY_INSET, PERF_HUD_LEFT_DEFAULT } from "../components/overlayLayout";
import { floatingSurfaceStyle, overlayButtonStyle } from "../components/toolbarStyles";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import { applyViewportState } from "../pipeline/apply";
import type { ViewportState } from "../pipeline/types";
import { parseStructureFile } from "../parsers/structure";
import { STRUCTURE_EXPORT_FORMATS, exportSnapshot } from "../export/structureExport";
import type { StructureWriteFormat } from "../parsers/parseCore";
import { useThemeStore, themeToHex } from "../stores/useThemeStore";
import type { HoverInfo } from "../types";
import { useBuilderStore, canEdit, editSteps, shownSnapshot, viewSnapshot } from "./store";
import { builderViewportState, BUILDER_SOURCE_ID } from "./view";
import { useBuilderHandlers } from "./useBuilderHandlers";
import { useBuilderShortcuts, TOOL_KEYS } from "./shortcuts";
import { HistoryBody } from "./HistoryPanel";
import { Inspector } from "./Inspector";
import { InfoHud } from "./InfoHud";
import { useSectionOpen } from "./panelState";
import { SymmetryOffer } from "./crystal/SymmetryOffer";
import { ToolRail, toolHint, toolInfo } from "./ToolRail";
import { TOOL_RAIL_WIDTH } from "./rail";
import { ContextBar } from "./ContextBar";
import type { MenuItem } from "./Menu";
import { OperationsRail } from "./OperationsRail";
import { NewStructureDialog, type NewStructureKind } from "./NewStructureDialog";
import { fileMenuItems } from "./topbarMenus";
import { CrystalDialog, type CrystalDialogKind } from "./crystal/CrystalDialog";
import { structureMenuItems } from "./crystal/structureMenu";
import { hasCellBox, symmetryOpsAvailable } from "./crystal/structure";
import { ToolServerDialog, toolsMenuItems, useToolServerLaunch } from "./tools/ToolServer";
import { ToolDialog } from "./tools/ToolDialog";
import { useToolsStore } from "./tools/store";
import { LibraryHost } from "./library/LibraryPanel";
import { AtomMenu, type AtomMenuTarget } from "./AtomMenu";
import { runCleanup } from "./cleanup";
import { useLibraryActions, useLibraryUi } from "./library/ui";
import { buttonStyle, hintStyle } from "./styles";
import { trackEvent, trackFileOpen } from "../analytics";

/** Width of the Details and History panels on the right of the view. */
const PANEL_WIDTH = 372;
/** Height of the History panel, under the Details panel. */
const HISTORY_HEIGHT = 220;
/** Room a collapsed panel's stub takes, for what sits beside or above it. */
const STUB_CLEARANCE = 120;
const STUB_HEIGHT = 40;
/** Left edge of the info line: beside Reset View, as the viewer's HUD. */
const INFO_LEFT = PERF_HUD_LEFT_DEFAULT;
/**
 * Left edge of the bottom-left status and notice lines: right of the rails,
 * so the rails can run down the whole left edge without being covered.
 */
const STATUS_LEFT = OVERLAY_INSET + TOOL_RAIL_WIDTH + OVERLAY_INSET;

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
  const placeSource = useBuilderStore((s) => s.placeSource);
  const notice = useBuilderStore((s) => s.notice);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const newCell = useBuilderStore((s) => s.newCell);
  const newBulk = useBuilderStore((s) => s.newBulk);
  const openStructure = useBuilderStore((s) => s.openStructure);
  const setNotice = useBuilderStore((s) => s.setNotice);
  const reportError = useBuilderStore((s) => s.reportError);
  const pushOp = useBuilderStore((s) => s.pushOp);
  const preview = useBuilderStore((s) => s.preview);
  const boxSelect = useBuilderStore((s) => s.boxSelect);
  const setSelected = useBuilderStore((s) => s.setSelected);
  const toolsStatus = useToolsStore((s) => s.status);
  const toolsConnection = useToolsStore((s) => s.connection);
  const openTool = useToolsStore((s) => s.openTool);
  const openForm = useToolsStore((s) => s.openForm);
  const setTool = useBuilderStore((s) => s.setTool);
  const openSketch = useLibraryUi((s) => s.openSketch);
  const setGalleryOpen = useLibraryUi((s) => s.setGalleryOpen);
  const importer = useLibraryUi((s) => s.importer);
  const { saveSelection } = useLibraryActions();

  // `shown` is the document (what Save writes); `viewed` is what the view
  // draws, which is the preview of a Structure dialog's op while one is open.
  const shown = useMemo(
    () => shownSnapshot({ source, result, showOriginal }),
    [source, result, showOriginal],
  );
  const viewed = useMemo(
    () => viewSnapshot({ source, result, showOriginal, preview }),
    [source, result, showOriginal, preview],
  );
  const viewportState = useMemo(() => builderViewportState(viewed), [viewed]);

  const handlers = useBuilderHandlers(api);

  // ── Renderer ──
  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const prevViewportStateRef = useRef<ViewportState | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo>(null);
  const [atomMenu, setAtomMenu] = useState<AtomMenuTarget | null>(null);
  const closeAtomMenu = useCallback(() => setAtomMenu(null), []);
  useToolServerLaunch();
  const [dropActive, setDropActive] = useState(false);

  // ── The panels on the right ──
  // Details shows the options of whatever was picked on the left: a form
  // (a Structure operation, a new document, the tool server, a Python tool)
  // while one is open, else the current tool's settings and the selection.
  // One form at a time; opening one closes the others and opens the panel.
  const [detailsOpen, toggleDetails, revealDetails] = useSectionOpen("details", true);
  const [historyOpen, toggleHistory] = useSectionOpen("history", edits.length > 0);
  const [newDialog, setNewDialog] = useState<NewStructureKind | null>(null);
  const [crystalDialog, setCrystalDialog] = useState<CrystalDialogKind | null>(null);
  const [toolServerOpen, setToolServerOpen] = useState(false);
  const closeForm = useToolsStore((s) => s.closeForm);
  const showForm = useCallback(
    (form: { crystal?: CrystalDialogKind; create?: NewStructureKind; server?: boolean }) => {
      setCrystalDialog(form.crystal ?? null);
      setNewDialog(form.create ?? null);
      setToolServerOpen(!!form.server);
      closeForm();
      revealDetails();
    },
    [closeForm, revealDetails],
  );
  // A Python tool's form opens from the tools store.
  useEffect(() => {
    if (!openTool) return;
    setCrystalDialog(null);
    setNewDialog(null);
    setToolServerOpen(false);
    revealDetails();
  }, [openTool, revealDetails]);
  const closeCrystalDialog = useCallback(() => setCrystalDialog(null), []);
  const closeToolServer = useCallback(() => setToolServerOpen(false), []);
  // A new document ends whatever a Structure dialog was about to do to the old one.
  useEffect(() => setCrystalDialog(null), [source]);
  // The panels' inset as last applied, for a renderer that arrives later.
  const panelInsetRef = useRef(PANEL_WIDTH + OVERLAY_INSET);

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
      renderer.setBackgroundColor(themeToHex(useThemeStore.getState().resolvedTheme));
      // The panel floats over the right of the view: centre the structure in
      // the part left of it, as the viewer does beside its Pipeline panel.
      renderer.setViewInsets(0, panelInsetRef.current);
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
  const hasCell = latticeVectors(viewed?.box) !== null;
  const structureItems = structureMenuItems(
    {
      hasDocument: !!shown,
      editable: canEdit({ source, result, showOriginal }),
      hasCell: hasCellBox(shown?.box),
      nAtoms: shown?.nAtoms ?? 0,
      symmetryOps: symmetryOpsAvailable(source, edits),
      nSelected: selected.length,
    },
    (kind) => showForm({ crystal: kind }),
    pushOp,
    () => void runCleanup(api),
  );
  const toolsItems = toolsMenuItems(
    { status: toolsStatus, connection: toolsConnection, openForm },
    () => showForm({ server: true }),
  );

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

  // The view's background follows the theme, as in the viewer.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  useEffect(() => {
    rendererRef.current?.setBackgroundColor(themeToHex(resolvedTheme));
  }, [resolvedTheme]);

  // A Structure dialog's preview can grow or shrink the structure (a
  // supercell, a slab, a new cell): fit the view to what is drawn whenever
  // the preview starts, changes or ends (Apply, Cancel), keeping the angle.
  // Parent effects run after the Viewport's, so the snapshot is loaded.
  const previewSeen = useRef(preview);
  useEffect(() => {
    if (previewSeen.current === preview) return;
    previewSeen.current = preview;
    rendererRef.current?.resetView();
  }, [preview]);
  const lastContextMenuAt = useRef<{ x: number; y: number } | null>(null);
  const steps = useMemo(() => editSteps(edits).length, [edits]);

  const highlighted = useMemo(() => {
    const set = new Set(selected);
    if (pendingBondAtom !== null) set.add(pendingBondAtom);
    return set.size > 0 ? [...set] : null;
  }, [selected, pendingBondAtom]);

  const activeTool = toolInfo(tool);

  // What the panels cover on the right. The renderer centres the structure in
  // the part of the view left of them, as the viewer does beside its Pipeline
  // panel; the info line (beside Details) and the status line (beside
  // History) keep clear of them or of their stubs.
  const panelInset = detailsOpen || historyOpen ? PANEL_WIDTH + OVERLAY_INSET : 0;
  const infoRight = detailsOpen ? PANEL_WIDTH + 2 * OVERLAY_INSET : STUB_CLEARANCE;
  const statusRight = historyOpen ? PANEL_WIDTH + 2 * OVERLAY_INSET : STUB_CLEARANCE;
  const detailsBottom = OVERLAY_INSET + (historyOpen ? HISTORY_HEIGHT : STUB_HEIGHT) + 8;
  useEffect(() => {
    panelInsetRef.current = panelInset;
    rendererRef.current?.setViewInsets(0, panelInset);
  }, [panelInset]);

  const insertItems: MenuItem[] = [
    {
      label: "Molecule…",
      testId: "builder-insert-molecule",
      title: "Choose a library molecule to place (P)",
      onSelect: () => {
        setTool("place");
        setGalleryOpen(true);
      },
    },
    {
      label: "Sketch molecule…",
      testId: "builder-insert-sketch",
      title: "Draw a molecule in Ketcher and add it to the library",
      onSelect: () => openSketch(),
    },
    {
      label: "Molecule from file…",
      testId: "builder-insert-import",
      title: "Add a molecule to the library from a structure file",
      onSelect: () => importer?.(),
    },
    { separator: true },
    {
      label: "Save selection as molecule",
      testId: "builder-insert-save-selection",
      disabled: selected.length === 0,
      title: "Keep the selected atoms (and the bonds between them) in the library",
      onSelect: saveSelection,
    },
  ];

  return (
    <div
      data-testid="megane-builder"
      data-atom-count={shown?.nAtoms ?? 0}
      data-bond-count={shown?.nBonds ?? 0}
      data-edit-count={edits.length}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "var(--megane-bg, #fff)",
        color: "var(--megane-text, #1e293b)",
      }}
    >
      <input
        ref={inputRef}
        data-testid="builder-open-input"
        type="file"
        style={{ display: "none" }}
        onChange={(e) => void handleOpenChange(e)}
      />

      {/* The 3D view fills the window; everything else floats over it. */}
      <div
        style={{ position: "absolute", inset: 0 }}
        onDragOver={(e) => {
          e.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropActive(false);
        }}
        onDrop={handleDrop}
        onContextMenuCapture={(e) => {
          lastContextMenuAt.current = { x: e.clientX, y: e.clientY };
        }}
        data-testid="builder-dropzone"
      >
        <Viewport
          snapshot={viewed}
          frame={null}
          atomLabels={null}
          atomVectors={null}
          onRendererReady={handleRendererReady}
          onHover={setHoverInfo}
          previewIndices={highlighted}
          buildActive={true}
          buildHandlers={handlers}
          preserveCameraKey={revision}
          boxSelectActive={!!source && tool === "select" && boxSelect}
          onBoxSelect={(indices, { additive }) =>
            setSelected(additive ? [...new Set([...api.getState().selected, ...indices])] : indices)
          }
          onAtomRightClick={(atom) => {
            // A preview's atoms are not the document's; nothing to act on.
            if (api.getState().preview) return;
            const at = lastContextMenuAt.current ?? { x: 0, y: 0 };
            setAtomMenu({ atom, x: at.x, y: at.y });
          }}
        />
        <Tooltip info={atomMenu ? null : hoverInfo} />
      </div>

      {/* Top-left, as in the viewer: Reset View and the axis buttons, then the
          tool rail and, under it, the operations rail — every action. */}
      <div
        data-testid="builder-left-column"
        style={{
          position: "absolute",
          top: OVERLAY_INSET,
          left: OVERLAY_INSET,
          bottom: OVERLAY_INSET,
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 4,
          pointerEvents: "none",
        }}
      >
        <div
          data-testid="view-controls"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
            pointerEvents: "auto",
          }}
        >
          <button
            type="button"
            data-testid="builder-reset-view"
            title="Reset view (R): fit the structure in the standard orientation"
            onClick={handleResetView}
            style={overlayButtonStyle}
          >
            Reset View
          </button>
          <ViewAxisControls hasCell={hasCell} onAlign={handleAlignView} />
        </div>
        <div
          style={{
            marginTop: 8,
            minHeight: 0,
            // A short window scrolls the rails; room for their shadows, and
            // no scrollbar over a 50 px column.
            overflowY: "auto",
            scrollbarWidth: "none",
            padding: "0 10px 10px 0",
            marginRight: -10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <ToolRail />
          <OperationsRail
            fileItems={fileMenuItems({
              open: () => inputRef.current?.click(),
              newCell: () => showForm({ create: "cell" }),
              newBulk: () => showForm({ create: "bulk" }),
              formats: STRUCTURE_EXPORT_FORMATS,
              save: (f) => void handleExport(f as StructureWriteFormat),
              canSave: !!shown,
              mod,
            })}
            structureItems={structureItems}
            insertItems={insertItems}
            toolsItems={toolsItems}
            hasDocument={!!shown}
            canUndo={edits.length > 0}
            canRedo={redoStack.length > 0}
            onUndo={() => undo()}
            onRedo={() => redo()}
            mod={mod}
          />
        </div>
      </div>

      <InfoHud
        fileName={fileName}
        steps={steps}
        viewed={viewed}
        left={INFO_LEFT}
        right={infoRight}
      />
      {!source && tool !== "place" && (
        <div
          data-testid="builder-welcome"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: panelInset,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <div
            style={{
              ...floatingSurfaceStyle,
              pointerEvents: "auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: 24,
              maxWidth: 420,
              margin: 16,
              textAlign: "center",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.02em" }}>
              Build a structure
            </div>
            <div style={hintStyle}>
              Open a file (PDB, XYZ, MOL, CIF, …) — or drop one here — or start from scratch.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
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
                onClick={() => showForm({ create: "cell" })}
              >
                New empty cell…
              </button>
              <button
                type="button"
                data-testid="builder-welcome-bulk"
                style={buttonStyle()}
                onClick={() => showForm({ create: "bulk" })}
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
            zIndex: 30,
            borderRadius: 12,
            border: "2px dashed #3b82f6",
            background: "rgba(59, 130, 246, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            color: "var(--megane-primary-text, #2563eb)",
            pointerEvents: "none",
          }}
        >
          Drop a structure file to open it
        </div>
      )}

      <CollapsiblePanel
        title="Details"
        collapsed={!detailsOpen}
        onToggleCollapse={toggleDetails}
        width={PANEL_WIDTH}
        bottom={detailsBottom}
      >
        <div
          data-testid="builder-sidebar"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 10,
            overflowY: "auto",
            fontSize: 13,
            color: "var(--megane-text, #1e293b)",
          }}
        >
          {crystalDialog ? (
            <CrystalDialog key={crystalDialog} kind={crystalDialog} onClose={closeCrystalDialog} />
          ) : newDialog ? (
            <NewStructureDialog
              key={newDialog}
              initialKind={newDialog}
              hasDocument={!!source}
              onNewCell={newCell}
              onNewBulk={newBulk}
              onClose={() => setNewDialog(null)}
            />
          ) : openTool ? (
            <ToolDialog key={openTool.name} tool={openTool} />
          ) : toolServerOpen ? (
            <ToolServerDialog onClose={closeToolServer} />
          ) : (
            <>
              {/* Place works with nothing open, so its settings (and gallery) do too. */}
              {(source || tool === "place") && <ContextBar />}
              <Inspector />
              <SymmetryOffer />
              {(!(source || tool === "place") || activeTool.needs.length === 0) &&
                selected.length === 0 && (
                  <div style={hintStyle} data-testid="builder-empty-hint">
                    {source
                      ? `${activeTool.label} has no settings. Pick a tool or an operation on the left; its options appear here.`
                      : "Open a structure or start a new one from the File menu on the left; the options of what you pick there appear here."}
                  </div>
                )}
            </>
          )}
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="History"
        subtitle={
          <span data-testid="builder-op-count">
            {steps} edit{steps === 1 ? "" : "s"}
          </span>
        }
        collapsed={!historyOpen}
        onToggleCollapse={toggleHistory}
        width={PANEL_WIDTH}
        bottom={OVERLAY_INSET}
        height={HISTORY_HEIGHT}
      >
        <HistoryBody />
      </CollapsiblePanel>

      {/* Bottom-left, right of the rails: the one notice line over the
          status line. */}
      <div
        style={{
          position: "absolute",
          left: STATUS_LEFT,
          right: statusRight,
          bottom: OVERLAY_INSET,
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 6,
          pointerEvents: "none",
        }}
      >
        {notice && (
          <div
            data-testid="builder-notice"
            data-level={notice.level}
            role={notice.level === "error" ? "alert" : "status"}
            style={{
              ...floatingSurfaceStyle,
              pointerEvents: "auto",
              maxWidth: "100%",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 8px 6px 12px",
              fontSize: 12,
              borderLeft: `3px solid ${notice.level === "error" ? "#ef4444" : "#3b82f6"}`,
              color:
                notice.level === "error"
                  ? "var(--megane-danger-text, #b91c1c)"
                  : "var(--megane-text, #1e293b)",
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
            ...overlayButtonStyle,
            cursor: "default",
            maxWidth: "100%",
            boxSizing: "border-box",
            display: "flex",
            flexWrap: "wrap",
            columnGap: 12,
            rowGap: 4,
            lineHeight: 1.3,
            color: "var(--megane-text-secondary, #64748b)",
          }}
        >
          {preview && (
            <span
              data-testid="builder-status-preview"
              style={{ color: "var(--megane-primary-text, #2563eb)" }}
            >
              Preview — Apply keeps it
            </span>
          )}
          {selected.length > 0 && (
            <span data-testid="builder-status-selection">{selected.length} selected</span>
          )}
          {showOriginal && <span>Showing original</span>}
          <span data-testid="builder-status-tool">
            <b style={{ fontWeight: 600, color: "var(--megane-text-body, #334155)" }}>
              {activeTool.label} ({TOOL_KEYS[activeTool.value]})
            </b>{" "}
            ·{" "}
            <span data-testid="builder-tool-hint">
              {toolHint(tool, pendingBondAtom, placeSource)}
            </span>
          </span>
        </div>
      </div>

      <LibraryHost />
      {atomMenu && <AtomMenu target={atomMenu} onClose={closeAtomMenu} />}
    </div>
  );
}
