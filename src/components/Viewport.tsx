/**
 * Three.js canvas wrapper component.
 * Manages the lifecycle of MoleculeRenderer.
 */

import { useEffect, useRef } from "react";
import { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import type { MouseScheme } from "../renderer/CameraControls";
import type { Snapshot, Frame, HoverInfo } from "../types";
import type { BuildHandlers, BuildModifiers, BuildPressAction } from "../builder/types";

/** Pointer travel (px) under which a press still counts as a click. */
const CLICK_SLOP = 3;

function modifiersOf(e: MouseEvent): BuildModifiers {
  return { shiftKey: e.shiftKey, mod: e.ctrlKey || e.metaKey, altKey: e.altKey };
}

/** The dashed rubber band a box selection draws, in client pixels. */
function createBoxElement(x: number, y: number): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "viewport-box-select");
  Object.assign(el.style, {
    position: "fixed",
    border: "1px dashed var(--megane-primary-text)",
    background: "rgba(37, 99, 235, 0.12)",
    pointerEvents: "none",
    zIndex: "50",
    left: `${x}px`,
    top: `${y}px`,
    width: "0px",
    height: "0px",
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  return el;
}

function sizeBoxElement(el: HTMLDivElement, x0: number, y0: number, x1: number, y1: number) {
  el.style.left = `${Math.min(x0, x1)}px`;
  el.style.top = `${Math.min(y0, y1)}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
}

interface ViewportProps {
  snapshot: Snapshot | null;
  frame: Frame | null;
  atomLabels?: string[] | null;
  atomVectors?: Float32Array | null;
  onRendererReady?: (renderer: MoleculeRenderer) => void;
  onHover?: (info: HoverInfo) => void;
  /** A right-click on an atom, with the pointer's client position. */
  onAtomRightClick?: (atomIndex: number, clientX: number, clientY: number) => void;
  onFrameUpdated?: () => void;
  /** Atom indices to highlight live as the Inspector's current selection. */
  previewIndices?: number[] | null;
  /** When true, left-drag draws a rubber-band box instead of rotating. */
  boxSelectActive?: boolean;
  /**
   * Called with the atom indices inside a completed box drag; `additive` is
   * true when Shift was held (add to the selection instead of replacing it).
   */
  onBoxSelect?: (indices: number[], options: { additive: boolean }) => void;
  /** Called when an atom is left-clicked while the Inspector is active. */
  onInspectorPick?: (atomIndex: number) => void;
  /** True while the Selection Inspector tab is the active editing surface. */
  inspectorActive?: boolean;
  /**
   * True while a structure editor (megane Builder) owns the view: a left
   * click reports the atom (or empty-space point) to `buildHandlers.pick`, a
   * left drag moves atoms or draws a rubber band as `buildHandlers.pressAction`
   * says (camera rotation is suspended for that drag only), a double-click on
   * an atom goes to `buildHandlers.doubleClick`, and a right-click opens the
   * atom menu on release, so a right drag can turn the camera.
   */
  buildActive?: boolean;
  buildHandlers?: BuildHandlers | null;
  /** Which mouse buttons move the camera; the viewer's when omitted. */
  mouseScheme?: MouseScheme;
  /** Builder: atoms a click would act on, drawn in `hoverColor`. */
  hoverIndices?: number[] | null;
  hoverColor?: number;
  /** Builder: atoms in a close contact, drawn red. */
  warningIndices?: number[] | null;
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
  mouseScheme,
  hoverIndices,
  hoverColor,
  warningIndices,
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
      // While building, the menu opens on the right button's release instead
      // (handleBuildUp), so a right drag can rotate the camera.
      if (buildActiveRef.current) return;
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      if (info && info.kind === "atom") {
        onAtomRightClickRef.current?.(info.atomIndex, e.clientX, e.clientY);
      }
    };

    const handleMouseLeave = () => {
      onHoverRef.current?.(null);
    };

    // Double-click sets the orbit center as in OVITO: on an atom (the drawn
    // copy that was hit, which may be a periodic image) or a bond midpoint;
    // on empty space it resets to the model center.
    const handleDblClick = (e: MouseEvent) => {
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      // The Builder may take a double-click on an atom (select its molecule).
      if (
        info?.kind === "atom" &&
        buildActiveRef.current &&
        buildHandlersRef.current?.doubleClick(info.atomIndex, modifiersOf(e))
      ) {
        return;
      }
      if (info?.kind === "atom") {
        renderer.setRotationCenter(...info.position);
      } else if (info?.kind === "bond") {
        const positions = renderer.getCurrentPositionsCopy();
        if (positions) {
          const a = info.atomA * 3;
          const b = info.atomB * 3;
          renderer.setRotationCenter(
            (positions[a] + positions[b]) / 2,
            (positions[a + 1] + positions[b + 1]) / 2,
            (positions[a + 2] + positions[b + 2]) / 2,
          );
        }
      } else {
        renderer.resetRotationCenter();
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
    let boxStart: { x: number; y: number; shiftKey: boolean } | null = null;
    let boxEl: HTMLDivElement | null = null;

    const clearBoxEl = () => {
      boxEl?.remove();
      boxEl = null;
    };

    const handleBoxDown = (e: PointerEvent) => {
      if (!boxSelectActiveRef.current || e.button !== 0) return;
      boxStart = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      boxEl = createBoxElement(e.clientX, e.clientY);
      (e.target as Element)?.setPointerCapture?.(e.pointerId);
    };

    const handleBoxMove = (e: PointerEvent) => {
      if (!boxStart || !boxEl) return;
      sizeBoxElement(boxEl, boxStart.x, boxStart.y, e.clientX, e.clientY);
    };

    const handleBoxUp = (e: PointerEvent) => {
      if (!boxStart) return;
      const rect = { x0: boxStart.x, y0: boxStart.y, x1: e.clientX, y1: e.clientY };
      const additive = boxStart.shiftKey || e.shiftKey;
      boxStart = null;
      clearBoxEl();
      // Ignore an accidental click (no meaningful drag area).
      if (Math.abs(rect.x1 - rect.x0) < 3 && Math.abs(rect.y1 - rect.y0) < 3) return;
      const indices = renderer.selectAtomsInRect(rect);
      onBoxSelectRef.current?.(indices, { additive });
    };

    // ── Builder: the left button edits, the right one turns the camera ──
    // A left press asks the Builder what a drag from there does
    // (`pressAction`): move atoms, draw a rubber band, or leave it to the
    // camera (Alt always leaves it, for trackpads without a right drag). It is
    // decided in the capture phase, before the camera controls see the press,
    // so an editing drag never also rotates the view. A press released within
    // `CLICK_SLOP` px is a click (`pick`), whatever the press would have done.
    interface BuildPress {
      x: number;
      y: number;
      lastX: number;
      lastY: number;
      mods: BuildModifiers;
      atomIndex: number | null;
      action: BuildPressAction;
      /** What the press became once the pointer moved; null while still a click. */
      started: "move" | "box" | "none" | null;
    }
    let buildPress: BuildPress | null = null;
    let buildBox: HTMLDivElement | null = null;
    let buildRaf: number | null = null;
    let rightPress: { x: number; y: number } | null = null;

    const moved = (x0: number, y0: number, x1: number, y1: number) =>
      Math.abs(x1 - x0) >= CLICK_SLOP || Math.abs(y1 - y0) >= CLICK_SLOP;

    const clearBuildBox = () => {
      buildBox?.remove();
      buildBox = null;
    };

    const handleBuildPressCapture = (e: PointerEvent) => {
      if (!buildActiveRef.current) return;
      const handlers = buildHandlersRef.current;
      if (!handlers) return;
      if (e.button === 2) {
        rightPress = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0 || e.target !== canvas) return;
      const { x, y } = toCSSCoords(e);
      if (renderer.hitTestAxesInset(x, y)) return;
      const mods = modifiersOf(e);
      const info = renderer.raycastAtPixel(e.clientX, e.clientY);
      const atomIndex = info && info.kind === "atom" ? info.atomIndex : null;
      const action = mods.altKey ? "camera" : handlers.pressAction(atomIndex, mods);
      buildPress = {
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        mods,
        atomIndex,
        action,
        started: null,
      };
      if (action !== "camera") {
        renderer.setControlsEnabled(false);
        canvas.setPointerCapture?.(e.pointerId);
      }
    };

    const handleBuildMove = (e: PointerEvent) => {
      const press = buildPress;
      if (!press || press.action === "camera") return;
      press.lastX = e.clientX;
      press.lastY = e.clientY;
      const handlers = buildHandlersRef.current;
      if (press.started === null) {
        if (!moved(press.x, press.y, e.clientX, e.clientY)) return;
        if (press.action === "move" && press.atomIndex !== null) {
          press.started = handlers?.dragStart(press.atomIndex, press.mods) ? "move" : "none";
        } else if (press.action === "box") {
          press.started = "box";
          buildBox = createBoxElement(press.x, press.y);
        } else {
          press.started = "none";
        }
      }
      if (press.started === "box" && buildBox) {
        sizeBoxElement(buildBox, press.x, press.y, e.clientX, e.clientY);
      } else if (press.started === "move" && buildRaf === null) {
        buildRaf = requestAnimationFrame(() => {
          buildRaf = null;
          if (buildPress !== press || press.atomIndex === null) return;
          const gesture = renderer.dragGesture(
            press.atomIndex,
            press.x,
            press.y,
            press.lastX,
            press.lastY,
          );
          if (gesture) buildHandlersRef.current?.dragMove(gesture);
        });
      }
    };

    const handleBuildUp = (e: PointerEvent, cancelled = false) => {
      if (e.button === 2 && rightPress) {
        const r = rightPress;
        rightPress = null;
        if (cancelled || !buildActiveRef.current || moved(r.x, r.y, e.clientX, e.clientY)) return;
        const info = renderer.raycastAtPixel(e.clientX, e.clientY);
        if (info && info.kind === "atom") {
          onAtomRightClickRef.current?.(info.atomIndex, e.clientX, e.clientY);
        }
        return;
      }
      const press = buildPress;
      if (!press || (e.button !== 0 && !cancelled)) return;
      buildPress = null;
      if (buildRaf !== null) {
        cancelAnimationFrame(buildRaf);
        buildRaf = null;
      }
      const handlers = buildHandlersRef.current;
      if (press.started === "move" && press.atomIndex !== null) {
        // The last move may still be waiting for its frame: apply it first.
        const gesture = cancelled
          ? null
          : renderer.dragGesture(press.atomIndex, press.x, press.y, e.clientX, e.clientY);
        if (gesture) handlers?.dragMove(gesture);
        handlers?.dragEnd();
      } else if (press.started === "box") {
        clearBuildBox();
        if (!cancelled) {
          const indices = renderer.selectAtomsInRect({
            x0: press.x,
            y0: press.y,
            x1: e.clientX,
            y1: e.clientY,
          });
          handlers?.boxSelect(
            indices,
            press.mods.shiftKey ? "add" : press.mods.mod ? "subtract" : "replace",
          );
        }
      } else if (
        press.started === null &&
        !cancelled &&
        buildActiveRef.current &&
        !moved(press.x, press.y, e.clientX, e.clientY)
      ) {
        const info = renderer.raycastAtPixel(e.clientX, e.clientY);
        const atomIndex = info && info.kind === "atom" ? info.atomIndex : null;
        const world =
          atomIndex === null ? renderer.screenToWorldAtPivot(e.clientX, e.clientY) : null;
        handlers?.pick({ atomIndex, world, shiftKey: press.mods.shiftKey, mod: press.mods.mod });
      }
      if (press.action !== "camera") renderer.setControlsEnabled(true);
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

    const handlePointerCancel = (e: PointerEvent) => {
      renderer.endAxesDrag();
      handleBuildUp(e, true);
      handleBoxUp(e);
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("contextmenu", handleContextMenu);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("dblclick", handleDblClick);
    canvas.addEventListener("click", handleClick);
    containerEl.addEventListener("pointerdown", handleBuildPressCapture, { capture: true });
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      canvas.removeEventListener("dblclick", handleDblClick);
      canvas.removeEventListener("click", handleClick);
      containerEl.removeEventListener("pointerdown", handleBuildPressCapture, { capture: true });
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      clearBoxEl();
      clearBuildBox();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (buildRaf !== null) cancelAnimationFrame(buildRaf);
      if (buildPress && buildPress.action !== "camera") renderer.setControlsEnabled(true);
    };
  }, []);

  // Live preview highlight of the Inspector's current selection.
  useEffect(() => {
    rendererRef.current?.setPreviewSelection(previewIndices ?? null);
  }, [previewIndices]);

  // The Builder's camera buttons, hover and warning highlights; the viewer
  // never sets them.
  useEffect(() => {
    if (mouseScheme) rendererRef.current?.setMouseScheme(mouseScheme);
  }, [mouseScheme]);
  useEffect(() => {
    if (buildActive) rendererRef.current?.setHoverHighlight(hoverIndices ?? null, hoverColor);
  }, [buildActive, hoverIndices, hoverColor]);
  useEffect(() => {
    if (buildActive) rendererRef.current?.setWarningHighlight(warningIndices ?? null);
  }, [buildActive, warningIndices]);

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
        background: "var(--megane-surface-raised)",
      }}
    />
  );
}
