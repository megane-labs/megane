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
 * The chrome is Mantine (`BuilderProviders`); the 3D view is the viewer's own
 * renderer (`Viewport` + `MoleculeRenderer`, driven through
 * `applyViewportState`), and the parsers, writers and edit engine are shared
 * too. Nothing in the viewer imports this app.
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
import { Alert, Box, Button, Group, Menu, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { Viewport } from "../components/Viewport";
import { Tooltip as HoverTooltip } from "../components/Tooltip";
import { ViewAxisControls } from "../components/ViewAxisControls";
import { OVERLAY_INSET } from "../components/overlayLayout";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import { applyViewportState } from "../pipeline/apply";
import type { ViewportState } from "../pipeline/types";
import { parseStructureFile } from "../parsers/structure";
import { STRUCTURE_EXPORT_FORMATS, exportSnapshot } from "../export/structureExport";
import type { StructureWriteFormat } from "../parsers/parseCore";
import { useThemeStore, themeToHex, type Theme } from "../stores/useThemeStore";
import type { HoverInfo } from "../types";
import { useBuilderStore, shownSnapshot } from "./store";
import { builderViewportState, BUILDER_SOURCE_ID } from "./view";
import { useBuilderHandlers } from "./useBuilderHandlers";
import { useBuilderShortcuts, TOOL_KEYS } from "./shortcuts";
import { BuilderSidebar, TOOLS } from "./BuilderSidebar";
import { NewStructureDialog, type NewStructureKind } from "./NewStructureDialog";
import { BuilderProviders } from "./providers";

const SIDEBAR_WIDTH = 320;

const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ORDER: Theme[] = ["system", "light", "dark"];

/** ⌘ on a Mac, Ctrl elsewhere, for the shortcut hints in the tooltips. */
function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

export function BuilderApp() {
  return (
    <BuilderProviders>
      <BuilderShell />
    </BuilderProviders>
  );
}

function BuilderShell() {
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
      renderer.setBackgroundColor(themeToHex(useThemeStore.getState().resolvedTheme));
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
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  // The 3D view is not a Mantine surface, so it follows the theme itself —
  // as the viewer's own canvas does.
  useEffect(() => {
    rendererRef.current?.setBackgroundColor(themeToHex(resolvedTheme));
  }, [resolvedTheme]);
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
    <Box
      data-testid="megane-builder"
      data-atom-count={shown?.nAtoms ?? 0}
      data-bond-count={shown?.nBonds ?? 0}
      data-edit-count={edits.length}
      w="100%"
      h="100%"
      display="flex"
      bg="var(--mantine-color-body)"
      style={{ flexDirection: "column" }}
    >
      <Paper
        data-testid="builder-topbar"
        radius={0}
        withBorder
        px="sm"
        py={6}
        style={{ borderWidth: "0 0 1px 0" }}
      >
        <Group gap="xs">
          <Text fw={700} size="md" style={{ letterSpacing: "-0.02em" }}>
            megane Builder
          </Text>
          <Text size="xs" c="dimmed" mr="xs" data-testid="builder-file-name">
            {fileName ?? "No structure"}
            {edits.length > 0 && ` · ${edits.length} edit${edits.length === 1 ? "" : "s"}`}
          </Text>
          <Tooltip label={`Open a structure file (${mod}+O)`} openDelay={400}>
            <Button
              variant="default"
              data-testid="builder-open"
              onClick={() => inputRef.current?.click()}
            >
              Open…
            </Button>
          </Tooltip>
          <input
            ref={inputRef}
            data-testid="builder-open-input"
            type="file"
            style={{ display: "none" }}
            onChange={(e) => void handleOpenChange(e)}
          />
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <Button
                variant="default"
                data-testid="builder-new"
                title="Start a new structure (replaces the open one)"
              >
                New ▾
              </Button>
            </Menu.Target>
            <Menu.Dropdown data-testid="builder-new-menu">
              <Menu.Item data-testid="builder-new-cell-item" onClick={() => setNewDialog("cell")}>
                Empty cell…
              </Menu.Item>
              <Menu.Item data-testid="builder-new-bulk-item" onClick={() => setNewDialog("bulk")}>
                Bulk crystal…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Tooltip label={`Undo (${mod}+Z)`} openDelay={400}>
            <Button
              variant="default"
              data-testid="builder-topbar-undo"
              disabled={edits.length === 0}
              onClick={() => undo()}
            >
              Undo
            </Button>
          </Tooltip>
          <Tooltip label={`Redo (${mod}+Shift+Z)`} openDelay={400}>
            <Button
              variant="default"
              data-testid="builder-topbar-redo"
              disabled={redoStack.length === 0}
              onClick={() => redo()}
            >
              Redo
            </Button>
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                data-testid="builder-save"
                disabled={!shown}
                title={`Save the edited structure (${mod}+S saves XYZ)`}
              >
                Save ▾
              </Button>
            </Menu.Target>
            <Menu.Dropdown data-testid="builder-save-menu">
              {STRUCTURE_EXPORT_FORMATS.map((f) => (
                <Menu.Item
                  key={f.value}
                  data-testid={`builder-save-${f.value}`}
                  onClick={() => void handleExport(f.value)}
                >
                  Save {f.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button
            variant="default"
            data-testid="builder-theme"
            onClick={cycleTheme}
            title={`Theme: ${THEME_LABELS[theme]} (click to cycle)`}
          >
            {THEME_LABELS[theme]}
          </Button>
        </Group>
      </Paper>

      <Box style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Box
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
            <Box
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
              <Paper
                withBorder
                shadow="md"
                radius="md"
                p="lg"
                style={{ pointerEvents: "auto", maxWidth: 460 }}
              >
                <Stack gap="sm" align="center">
                  <Text fw={600}>Build a structure</Text>
                  <Text size="xs" c="dimmed" ta="center">
                    Open a file (PDB, XYZ, MOL, CIF, …) — or drop one here — or start from scratch.
                  </Text>
                  <Group gap="xs" justify="center">
                    <Button
                      data-testid="builder-welcome-open"
                      onClick={() => inputRef.current?.click()}
                    >
                      Open…
                    </Button>
                    <Button
                      variant="default"
                      data-testid="builder-welcome-new"
                      onClick={() => setNewDialog("cell")}
                    >
                      New empty cell…
                    </Button>
                    <Button
                      variant="default"
                      data-testid="builder-welcome-bulk"
                      onClick={() => setNewDialog("bulk")}
                    >
                      New bulk crystal…
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            </Box>
          )}
          {dropActive && (
            <Box
              data-testid="builder-drop-overlay"
              style={{
                position: "absolute",
                inset: 8,
                borderRadius: 10,
                border: "2px dashed var(--mantine-color-blue-filled)",
                background: "var(--mantine-color-blue-light)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <Text fw={600} c="blue">
                Drop a structure file to open it
              </Text>
            </Box>
          )}
          <HoverTooltip info={hoverInfo} />
        </Box>
        <Box
          w={SIDEBAR_WIDTH}
          style={{
            borderLeft: "1px solid var(--mantine-color-default-border)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <BuilderSidebar />
        </Box>
      </Box>

      {notice && (
        <Alert
          data-testid="builder-notice"
          data-level={notice.level}
          color={notice.level === "error" ? "red" : "blue"}
          variant="light"
          radius={0}
          py={6}
          px="sm"
          withCloseButton={false}
        >
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" style={{ flex: 1 }}>
              {notice.text}
            </Text>
            <Button
              variant="default"
              data-testid="builder-notice-dismiss"
              onClick={() => setNotice(null)}
            >
              Dismiss
            </Button>
          </Group>
        </Alert>
      )}

      <Paper
        data-testid="builder-statusbar"
        radius={0}
        withBorder
        px="sm"
        py={4}
        style={{ borderWidth: "1px 0 0 0" }}
      >
        <Group gap="md">
          <Text size="xs" c="dimmed" data-testid="builder-status-atoms">
            {shown ? `${shown.nAtoms} atoms · ${shown.nBonds} bonds` : "No structure"}
          </Text>
          {hasCell && (
            <Text size="xs" c="dimmed" data-testid="builder-status-cell">
              Cell
            </Text>
          )}
          {selected.length > 0 && (
            <Text size="xs" c="dimmed" data-testid="builder-status-selection">
              {selected.length} selected
            </Text>
          )}
          <div style={{ flex: 1 }} />
          <Text size="xs" c="dimmed" data-testid="builder-status-tool" truncate>
            {activeTool.label} ({TOOL_KEYS[activeTool.value]}) · {activeTool.hint}
          </Text>
          {showOriginal && (
            <Text size="xs" c="dimmed">
              Showing original
            </Text>
          )}
        </Group>
      </Paper>

      {newDialog && (
        <NewStructureDialog
          initialKind={newDialog}
          hasDocument={!!source}
          onNewCell={newCell}
          onNewBulk={newBulk}
          onClose={() => setNewDialog(null)}
        />
      )}
    </Box>
  );
}
