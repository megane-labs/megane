/**
 * Three.js canvas wrapper component.
 * Manages the lifecycle of MoleculeRenderer.
 */

import { useEffect, useRef } from "react";
import { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import type { Snapshot, Frame, HoverInfo } from "../types";
import type { BuildHandlers } from "../builder/types";

interface ViewportProps {
  snapshot: Snapshot | null;
  frame: Frame | null;
  atomLabels?: string[] | null;
  atomVectors?: Float32Array | null;
  onRendererReady?: (renderer: MoleculeRenderer) => void;
  onHover?: (info: HoverInfo) => void;
  onAtomRightClick?: (atomIndex: number) => void;
  onFrameUpdated?: () => void;
  /** Atom indices to highlight live as the Inspector's current selection. */
  previewIndices?: number[] | null;
  /** When true, left-drag draws a rubber-band box instead of rotating. */
  boxSelectActive?: boolean;
  /** Called with the atom indices inside a completed box drag. */
  onBoxSelect?: (indices: number[]) => void;
  /** Called when an atom is left-clicked while the Inspector is active. */
  onInspectorPick?: (atomIndex: number) => void;
  /** True while the Selection Inspector tab is the active editing surface. */
  inspectorActive?: boolean;
  /**
   * True while a structure editor (megane Builder) owns the view: a left click
   * reports the atom (or empty-space point) to `buildHandlers.pick`, and a
   * left-drag on an atom becomes a move when `buildHandlers.dragStart`
   * accepts it (camera rotation is suspended for that drag only).
   */
  buildActive?: boolean;
  buildHandlers?: BuildHandlers | null;
  /**
   * Changes to this value mark the next snapshot as an in-place edit of the
   * structure already on screen (the `edit` node re-executing after a click
   * in the Builder): the camera then keeps its zoom / orbit instead of
   * re-fitting to the new bounds. A snapshot arriving without a change here
   * is gated by the topology heuristic as before.
   */
  preserveCameraKey?: number;
}

export function Viewport({
  snapshot,
  frame,
  atomLabels,
  atomVectors,
  onRendererReady,
  onHover,
  onAtomRightClick,
  onFrameUpdated,
  previewIndices,
  boxSelectActive,
  onBoxSelect,
  onInspectorPick,
  inspectorActive,
  buildActive,
  buildHandlers,
  preserveCameraKey,
}: ViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const onHoverRef = useRef(onHover);
  const onAtomRightClickRef = useRef(onAtomRightClick);
  const onFrameUpdatedRef = useRef(onFrameUpdated);
  const boxSelectActiveRef = useRef(boxSelectActive);
  const onBoxSelectRef = useRef(onBoxSelect);
  const onInspectorPickRef = useRef(onInspectorPick);
  const inspectorActiveRef = useRef(inspectorActive);
  const buildActiveRef = useRef(buildActive);
  const buildHandlersRef = useRef(buildHandlers);

  // Keep callback refs up to date
  onHoverRef.current = onHover;
  onAtomRightClickRef.current = onAtomRightClick;
  onFrameUpdatedRef.current = onFrameUpdated;
  boxSelectActiveRef.current = boxSelectActive;
  onBoxSelectRef.current = onBoxSelect;
  onInspectorPickRef.current = onInspectorPick;
  inspectorActiveRef.current = inspectorActive;
  buildActiveRef.current = buildActive;
  buildHandlersRef.current = buildHandlers;

  useEffect(() => {
    if (!containerRef.current) return;

    const renderer = new MoleculeRenderer();
    renderer.mount(containerRef.current);
    rendererRef.current = renderer;
    onRendererReady?.(renderer);

    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Mouse event handlers
  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = renderer?.getCanvas();
    if (!canvas || !renderer) return;

    let rafId: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      // No consumer → skip the raycast entirely. Bailing out here rather than
      // inside the rAF matters: raycastAtPixel is the expensive half of the
      // hover pipeline, and hosts that hide the Tooltip pass no onHover at all.
      if (!onHoverRef.current) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        const info = renderer.raycastAtPixel(e.clientX, e.clientY);
        onHoverRef.current?.(info);
        rafId = null;
      });
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      if (info && info.kind === "atom") {
        onAtomRightClickRef.current?.(info.atomIndex);
      }
    };

    const handleMouseLeave = () => {
      onHoverRef.current?.(null);
    };

    const handleDblClick = (e: MouseEvent) => {
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      if (info && info.kind === "atom") {
        const positions = renderer.getCurrentPositionsCopy();
        if (positions) {
          const idx = info.atomIndex;
          renderer.setRotationCenter(
            positions[idx * 3],
            positions[idx * 3 + 1],
            positions[idx * 3 + 2],
          );
        }
      }
    };

    // Inspector left-click pick: a plain click on an atom while the Inspector
    // is active (and not box-selecting) reports it for a "quick expand".
    const handleClick = (e: MouseEvent) => {
      if (!inspectorActiveRef.current || boxSelectActiveRef.current) return;
      if (e.button !== 0) return;
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      if (info && info.kind === "atom") {
        onInspectorPickRef.current?.(info.atomIndex);
      }
    };

    // ── Box (rubber-band) selection ──
    // Active only while `boxSelectActive`; camera rotation is suspended by an
    // effect below so the drag can't also orbit the camera.
    let boxStart: { x: number; y: number } | null = null;
    let boxEl: HTMLDivElement | null = null;

    const clearBoxEl = () => {
      boxEl?.remove();
      boxEl = null;
    };

    const handleBoxDown = (e: PointerEvent) => {
      if (!boxSelectActiveRef.current || e.button !== 0) return;
      boxStart = { x: e.clientX, y: e.clientY };
      boxEl = document.createElement("div");
      boxEl.setAttribute("data-testid", "viewport-box-select");
      Object.assign(boxEl.style, {
        position: "fixed",
        border: "1px dashed #2563eb",
        background: "rgba(37, 99, 235, 0.12)",
        pointerEvents: "none",
        zIndex: "50",
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        width: "0px",
        height: "0px",
      } as CSSStyleDeclaration);
      document.body.appendChild(boxEl);
      (e.target as Element)?.setPointerCapture?.(e.pointerId);
    };

    const handleBoxMove = (e: PointerEvent) => {
      if (!boxStart || !boxEl) return;
      const x = Math.min(boxStart.x, e.clientX);
      const y = Math.min(boxStart.y, e.clientY);
      boxEl.style.left = `${x}px`;
      boxEl.style.top = `${y}px`;
      boxEl.style.width = `${Math.abs(e.clientX - boxStart.x)}px`;
      boxEl.style.height = `${Math.abs(e.clientY - boxStart.y)}px`;
    };

    const handleBoxUp = (e: PointerEvent) => {
      if (!boxStart) return;
      const rect = { x0: boxStart.x, y0: boxStart.y, x1: e.clientX, y1: e.clientY };
      boxStart = null;
      clearBoxEl();
      // Ignore an accidental click (no meaningful drag area).
      if (Math.abs(rect.x1 - rect.x0) < 3 && Math.abs(rect.y1 - rect.y0) < 3) return;
      const indices = renderer.selectAtomsInRect(rect);
      onBoxSelectRef.current?.(indices);
    };

    // ── Builder: click-to-edit and drag-to-move ──
    // A press on an atom with the Move tool becomes a drag; anything else is a
    // click reported on release (when the pointer barely moved). Camera
    // controls are suspended only for the duration of an accepted drag, so
    // the view still orbits when the user drags empty space.
    let buildPress: { x: number; y: number; shiftKey: boolean } | null = null;
    let buildDrag: { atomIndex: number; x: number; y: number } | null = null;
    let buildRaf: number | null = null;

    const handleBuildDown = (e: PointerEvent): boolean => {
      if (!buildActiveRef.current || e.button !== 0) return false;
      const handlers = buildHandlersRef.current;
      if (!handlers) return false;
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      if (info && info.kind === "atom" && handlers.dragStart(info.atomIndex)) {
        buildDrag = { atomIndex: info.atomIndex, x: e.clientX, y: e.clientY };
        renderer.setControlsEnabled(false);
        (e.target as Element)?.setPointerCapture?.(e.pointerId);
        return true;
      }
      buildPress = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      return false;
    };

    const handleBuildMove = (e: PointerEvent) => {
      if (!buildDrag) return;
      const drag = buildDrag;
      if (buildRaf !== null) return;
      buildRaf = requestAnimationFrame(() => {
        buildRaf = null;
        if (!buildDrag) return;
        const delta = renderer.dragDeltaForAtom(
          drag.atomIndex,
          drag.x,
          drag.y,
          e.clientX,
          e.clientY,
        );
        if (delta) buildHandlersRef.current?.dragMove(delta);
      });
    };

    const handleBuildUp = (e: PointerEvent) => {
      if (buildDrag) {
        buildDrag = null;
        if (buildRaf !== null) {
          cancelAnimationFrame(buildRaf);
          buildRaf = null;
        }
        renderer.setControlsEnabled(true);
        buildHandlersRef.current?.dragEnd();
        return;
      }
      if (!buildPress) return;
      const press = buildPress;
      buildPress = null;
      if (!buildActiveRef.current) return;
      if (Math.abs(e.clientX - press.x) >= 3 || Math.abs(e.clientY - press.y) >= 3) return;
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      const atomIndex = info && info.kind === "atom" ? info.atomIndex : null;
      const world = atomIndex === null ? renderer.screenToWorldAtPivot(e.clientX, e.clientY) : null;
      buildHandlersRef.current?.pick({ atomIndex, world, shiftKey: press.shiftKey });
    };

    // ── Axes-inset drag handlers (pointer events for mouse+touch) ──

    const containerEl = containerRef.current!;

    const toCSSCoords = (e: PointerEvent | MouseEvent) => {
      const rect = containerEl.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const handlePointerDown = (e: PointerEvent) => {
      const { x, y } = toCSSCoords(e);
      if (renderer.hitTestAxesInset(x, y)) {
        e.preventDefault();
        renderer.startAxesDrag(x, y);
        (e.target as Element)?.setPointerCapture?.(e.pointerId);
        return;
      }
      if (handleBuildDown(e)) return;
      handleBoxDown(e);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (renderer.isAxesDragging()) {
        const { x, y } = toCSSCoords(e);
        renderer.moveAxesDrag(x, y);
        return;
      }
      handleBuildMove(e);
      handleBoxMove(e);
    };

    const handlePointerUp = (e: PointerEvent) => {
      renderer.endAxesDrag();
      handleBuildUp(e);
      handleBoxUp(e);
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("contextmenu", handleContextMenu);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("dblclick", handleDblClick);
    canvas.addEventListener("click", handleClick);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);

    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      canvas.removeEventListener("dblclick", handleDblClick);
      canvas.removeEventListener("click", handleClick);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      clearBoxEl();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (buildRaf !== null) cancelAnimationFrame(buildRaf);
      if (buildDrag) renderer.setControlsEnabled(true);
    };
  }, []);

  // Live preview highlight of the Inspector's current selection.
  useEffect(() => {
    rendererRef.current?.setPreviewSelection(previewIndices ?? null);
  }, [previewIndices]);

  // Suspend camera rotation while box-select is armed so a drag draws the box
  // instead of orbiting the camera.
  useEffect(() => {
    rendererRef.current?.setControlsEnabled(!boxSelectActive);
    return () => {
      rendererRef.current?.setControlsEnabled(true);
    };
  }, [boxSelectActive]);

  // The previously loaded snapshot, used to detect position-only re-mappings.
  const loadedSnapshotRef = useRef<Snapshot | null>(null);

  // `preserveCameraKey` as last acknowledged by a loadSnapshot (or by the
  // sync effect below when the key moved without a snapshot change). The
  // latest prop value is mirrored through a ref so the snapshot effect can
  // read it without listing it as a dependency.
  const latestPreserveKeyRef = useRef(preserveCameraKey);
  latestPreserveKeyRef.current = preserveCameraKey;
  const seenPreserveKeyRef = useRef(preserveCameraKey);

  // Latest frame prop, readable from the snapshot effect without adding it to
  // that effect's deps (a frame change alone must not re-run loadSnapshot).
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;

  useEffect(() => {
    if (snapshot && rendererRef.current) {
      // A snapshot that shares its topology arrays with the previous one and
      // differs only in `positions` is a coordinate re-mapping of the scene
      // already on screen (the wrap node toggling wrap/unwrap). Skip the
      // camera re-fit so the user's zoom/orbit survives the toggle; a truly
      // new structure (new element/bond arrays or atom count) still re-fits.
      const prev = loadedSnapshotRef.current;
      const positionsOnly =
        prev !== null &&
        prev !== snapshot &&
        prev.nAtoms === snapshot.nAtoms &&
        prev.elements === snapshot.elements &&
        prev.bonds === snapshot.bonds &&
        prev.box === snapshot.box;
      // An edit of the structure on screen (add / delete / move atoms) rebuilds
      // the topology arrays, so it fails the heuristic above even though the
      // user is looking at the same molecule; the key from the pipeline store
      // says so explicitly.
      const editInPlace =
        prev !== null && latestPreserveKeyRef.current !== seenPreserveKeyRef.current;
      seenPreserveKeyRef.current = latestPreserveKeyRef.current;
      rendererRef.current.loadSnapshot(snapshot, { fit: !positionsOnly && !editInPlace });
      loadedSnapshotRef.current = snapshot;
      // Re-apply the current trajectory frame after the snapshot geometry.
      // Snapshot and frame updates can land in separate commits in either
      // order (the pipeline re-executes several times while a trajectory
      // streams in), and a snapshot landing last used to silently replace the
      // frame's positions with the structure file's — the two are different
      // coordinate sets (e.g. a minimized PDB vs its XTC frame), so what the
      // viewer showed at "frame 1/N" was nondeterministic. Applying the frame
      // here pins the ordering: frame data always wins while a trajectory is
      // loaded. Guarded on matching atom counts so a stale frame from a
      // superseded provider can't be applied to a brand-new structure.
      if (frameRef.current && frameRef.current.nAtoms === snapshot.nAtoms) {
        rendererRef.current.updateFrame(frameRef.current);
        onFrameUpdatedRef.current?.();
      }
    }
  }, [snapshot]);

  // Declared after the snapshot effect on purpose: when the key and the
  // snapshot change in the same commit, the snapshot effect sees the moved key
  // first. When only the key moves (an edit that left the rendered structure
  // as it was), this keeps it acknowledged so a later real file load re-fits.
  useEffect(() => {
    seenPreserveKeyRef.current = preserveCameraKey;
  }, [preserveCameraKey]);

  useEffect(() => {
    if (frame && rendererRef.current) {
      rendererRef.current.updateFrame(frame);
      onFrameUpdatedRef.current?.();
    }
  }, [frame]);

  useEffect(() => {
    rendererRef.current?.setLabels(atomLabels ?? null);
  }, [atomLabels]);

  useEffect(() => {
    rendererRef.current?.setVectors(atomVectors ?? null);
  }, [atomVectors]);

  return (
    <div
      ref={containerRef}
      data-testid="viewer-root"
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        background: "#ffffff",
      }}
    />
  );
}
