/**
 * SelectionController: screen-space picking against the primary structure and
 * the atom selection drawn on top of it.
 *
 * Picking is CPU screen-space projection (`Picking.ts`), not Three.js
 * raycasting: the impostor spheres have no triangle geometry to hit. This class
 * binds those pure helpers to the live view — camera, container, current
 * trajectory positions, the representation's radius scale and the per-atom
 * scale / opacity a Modify node applied — so a pick only lands on atoms that
 * are actually drawn, at the size they are drawn.
 *
 * It also owns the two selection overlays:
 *
 * - the measurement selection (up to four atoms, blue highlight spheres joined
 *   by a line) behind `toggleAtomSelection` / `getMeasurement`;
 * - the Selection Inspector's preview highlight (any number of atoms, green,
 *   independent of the measurement selection).
 *
 * The renderer adds {@link selectionGroup} and {@link previewSelectionGroup} to
 * its scene and supplies the view through {@link SelectionView}, read lazily.
 */

import * as THREE from "three";
import type { HoverInfo, Measurement, SelectionState, Snapshot } from "../types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import type { AtomLayerState } from "./AtomLayerGroup";
import { getRadius, BALL_STICK_ATOM_SCALE } from "../constants";
import {
  pickAtPixel,
  projectToScreen,
  atomsInRect,
  screenDragToWorldDelta,
  type ClientRect,
} from "./Picking";
import { computeMeasurement } from "./Selection";

/** Maximum number of atoms in the measurement selection (a dihedral). */
export const MAX_SELECTED_ATOMS = 4;

/** An atom of the primary structure projected to viewer-space pixels. */
export interface MeganeProjectedAtom {
  index: number;
  sx: number;
  sy: number;
  depth: number;
  element: number;
}

/** What picking and the selection overlays read from the renderer. */
export interface SelectionView {
  /** The active camera (unset before mount). */
  getCamera(): THREE.OrthographicCamera | THREE.PerspectiveCamera;
  /** The element the viewer is mounted in (null before mount). */
  getContainer(): HTMLElement | null;
  /** The loaded primary structure, if any. */
  getSnapshot(): Snapshot | null;
  /** The current atom positions (trajectory frame); only read with a snapshot. */
  getCurrentPositions(): Float32Array;
  /** The atom appearance (global and per-atom scale / opacity) last applied. */
  getAtomState(): Readonly<AtomLayerState>;
  /** The Drawing Boundary copies on screen, if any. */
  getDrawingBoundary(): DrawingBoundaryData | null;
  /** The bond stream's periodic neighbour images on screen, if any. */
  getBondPeriodicImages(): PeriodicAtomImageData | null;
  /** Fraction of the vdW radius atoms are drawn at (see `representationFlags`). */
  getAtomRadiusScale(): number;
}

/** Remove and dispose every child of a THREE.Group (meshes and lines). */
function clearGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  }
}

/**
 * Draw translucent highlight spheres (1.6× atom radius) over the given atoms.
 * `radiusScale` must match the fraction of the vdW radius the atoms are drawn
 * at, or the highlight ends up buried inside a spacefill sphere.
 */
function drawHighlightSpheres(
  group: THREE.Group,
  atomIndices: number[],
  positions: Float32Array,
  elements: Uint8Array,
  color: number,
  opacity: number,
  radiusScale: number = BALL_STICK_ATOM_SCALE,
): void {
  for (const atomIdx of atomIndices) {
    // A selection made on an earlier structure may name atoms this one lacks.
    if (atomIdx < 0 || atomIdx >= elements.length) continue;
    const r = getRadius(elements[atomIdx]) * radiusScale * 1.6;
    const geo = new THREE.SphereGeometry(r, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(
      positions[atomIdx * 3],
      positions[atomIdx * 3 + 1],
      positions[atomIdx * 3 + 2],
    );
    group.add(sphere);
  }
}

export class SelectionController {
  /** Measurement selection overlay (highlight spheres + connecting line). */
  readonly selectionGroup = new THREE.Group();
  /**
   * Inspector preview highlight — an arbitrary-size, uncapped set drawn in a
   * distinct color, independent of the measurement selection.
   */
  readonly previewSelectionGroup = new THREE.Group();

  private selectedAtoms: number[] = [];
  private previewAtoms: number[] | null = null;

  constructor(private readonly view: SelectionView) {}

  /** Whether any atom is in the measurement selection. */
  get hasSelection(): boolean {
    return this.selectedAtoms.length > 0;
  }

  // ---- Picking ----

  /** Perform a pick at the given screen coordinates using CPU screen-space projection. */
  pickAtPixel(clientX: number, clientY: number): HoverInfo {
    const container = this.view.getContainer();
    const snapshot = this.view.getSnapshot();
    if (!container || !snapshot) return null;
    const atomState = this.view.getAtomState();
    return pickAtPixel(
      this.view.getCamera(),
      container,
      snapshot,
      this.view.getCurrentPositions(),
      atomState.scale,
      clientX,
      clientY,
      this.view.getDrawingBoundary(),
      this.view.getBondPeriodicImages(),
      this.view.getAtomRadiusScale(),
      {
        globalOpacity: atomState.opacity,
        opacity: atomState.opacityOverrides,
        scale: atomState.scaleOverrides,
      },
    );
  }

  /** Return the indices of atoms whose centers fall inside a screen rectangle. */
  atomsInRect(rect: ClientRect): number[] {
    const container = this.view.getContainer();
    const snapshot = this.view.getSnapshot();
    if (!container || !snapshot) return [];
    return atomsInRect(
      this.view.getCamera(),
      container,
      snapshot,
      this.view.getCurrentPositions(),
      rect,
      this.view.getDrawingBoundary(),
      this.view.getBondPeriodicImages(),
    );
  }

  /**
   * World displacement of a screen drag in the camera-facing plane through
   * atom `atomIndex` (at its current position). Null when nothing is loaded.
   */
  dragDeltaForAtom(
    atomIndex: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): [number, number, number] | null {
    const container = this.view.getContainer();
    const snapshot = this.view.getSnapshot();
    if (!container || !snapshot || atomIndex < 0 || atomIndex >= snapshot.nAtoms) {
      return null;
    }
    const pos = this.view.getCurrentPositions();
    const anchor: [number, number, number] = [
      pos[atomIndex * 3],
      pos[atomIndex * 3 + 1],
      pos[atomIndex * 3 + 2],
    ];
    return screenDragToWorldDelta(this.view.getCamera(), container, anchor, fromX, fromY, toX, toY);
  }

  /** Project every atom of the primary snapshot to viewer-space pixels. */
  projectAtoms(): MeganeProjectedAtom[] {
    const container = this.view.getContainer();
    const snapshot = this.view.getSnapshot();
    if (!snapshot || !container) return [];
    const camera = this.view.getCamera();
    const positions = this.view.getCurrentPositions();
    const elements = snapshot.elements;
    const n = snapshot.nAtoms;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const out: MeganeProjectedAtom[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const { sx, sy, depth } = projectToScreen(
        camera,
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
        w,
        h,
      );
      out[i] = { index: i, sx, sy, depth, element: elements[i] };
    }
    return out;
  }

  // ---- Selection & Measurement ----

  /** Toggle atom selection (right-click). Returns new selection state. */
  toggle(atomIndex: number): SelectionState {
    const idx = this.selectedAtoms.indexOf(atomIndex);
    if (idx >= 0) {
      this.selectedAtoms.splice(idx, 1);
    } else {
      if (this.selectedAtoms.length >= MAX_SELECTED_ATOMS) {
        this.selectedAtoms.shift();
      }
      this.selectedAtoms.push(atomIndex);
    }
    this.refresh();
    return { atoms: [...this.selectedAtoms] };
  }

  /** Set selected atoms directly (for external triggers). Returns new selection state. */
  set(atomIndices: number[]): SelectionState {
    this.selectedAtoms = atomIndices.slice(0, MAX_SELECTED_ATOMS);
    this.refresh();
    return { atoms: [...this.selectedAtoms] };
  }

  /** Clear all selected atoms. */
  clear(): void {
    this.selectedAtoms = [];
    this.refresh();
  }

  /**
   * Highlight an arbitrary set of atoms as a live "preview" of the Selection
   * Inspector's current selection (green, translucent). Independent of the
   * measurement selection. Pass `null` or `[]` to clear. The set is kept, so
   * {@link refreshPreview} redraws it where the atoms are now.
   */
  setPreview(atomIndices: number[] | null): void {
    this.previewAtoms = atomIndices && atomIndices.length > 0 ? [...atomIndices] : null;
    this.refreshPreview();
  }

  /**
   * Redraw the preview highlight at the current positions: after a new
   * snapshot (an atom moved in the Builder) or a trajectory frame, so the
   * highlight stays on the atoms it marks.
   */
  refreshPreview(): void {
    clearGroup(this.previewSelectionGroup);
    const snapshot = this.view.getSnapshot();
    if (!snapshot || !this.previewAtoms) return;
    drawHighlightSpheres(
      this.previewSelectionGroup,
      this.previewAtoms,
      this.view.getCurrentPositions(),
      snapshot.elements,
      0x22c55e,
      0.3,
      this.view.getAtomRadiusScale(),
    );
  }

  /** Compute the current geometric measurement based on selected atoms. */
  getMeasurement(): Measurement | null {
    if (!this.view.getSnapshot() || this.selectedAtoms.length < 2) return null;
    return computeMeasurement(this.view.getCurrentPositions(), this.selectedAtoms);
  }

  /** Redraw the measurement overlay at the current positions. */
  refresh(): void {
    clearGroup(this.selectionGroup);

    const snapshot = this.view.getSnapshot();
    if (!snapshot || this.selectedAtoms.length === 0) return;

    const pos = this.view.getCurrentPositions();
    const elements = snapshot.elements;

    // Highlight spheres
    drawHighlightSpheres(
      this.selectionGroup,
      this.selectedAtoms,
      pos,
      elements,
      0x4285f4,
      0.35,
      this.view.getAtomRadiusScale(),
    );

    // Connecting lines
    if (this.selectedAtoms.length >= 2) {
      const points = this.selectedAtoms.map(
        (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]),
      );
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x4285f4,
        depthTest: false,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 999;
      this.selectionGroup.add(line);
    }
  }
}
