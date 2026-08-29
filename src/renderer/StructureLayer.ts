/**
 * StructureLayer: manages rendering objects for a single molecular structure.
 * Multiple StructureLayers can coexist in the same Three.js scene,
 * enabling overlay of e.g. all-atom and coarse-grained models.
 */

import * as THREE from "three";
import type { Snapshot, Frame, AtomRenderer, BondRenderer } from "../types";
import { ImpostorAtomMesh } from "./ImpostorAtomMesh";
import { ImpostorBondMesh } from "./ImpostorBondMesh";
import { CellRenderer } from "./CellRenderer";
import { DrawingBoundaryAtomRenderer } from "./CellBoundaryAtomRenderer";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { generateDrawingBoundaryImages } from "../logic/cellBoundaryImages";

export class StructureLayer {
  readonly id: string;
  snapshot: Snapshot | null = null;
  currentPositions: Float32Array | null = null;

  private scene: THREE.Scene;
  private atomRenderer: AtomRenderer | null = null;
  private bondRenderer: BondRenderer | null = null;
  private cellRenderer: CellRenderer | null = null;
  private drawingBoundaryAtomRenderer: DrawingBoundaryAtomRenderer | null = null;
  private drawingBoundary: DrawingBoundaryData | null = null;
  private bondPeriodicAtomRenderer: DrawingBoundaryAtomRenderer | null = null;
  private bondPeriodicImages: PeriodicAtomImageData | null = null;

  private atomScale = 1.0;
  private atomOpacity = 1.0;
  private bondScale = 1.0;
  private bondOpacity = 1.0;
  private currentColorOverrides: Float32Array | null = null;
  private currentScaleOverrides: Float32Array | null = null;
  private currentOpacityOverrides: Float32Array | null = null;

  constructor(id: string, scene: THREE.Scene) {
    this.id = id;
    this.scene = scene;
  }

  loadSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.currentPositions = new Float32Array(snapshot.positions);

    if (!this.atomRenderer) {
      const atoms = new ImpostorAtomMesh();
      this.atomRenderer = atoms;
      this.scene.add(atoms.mesh);
    }
    this.atomRenderer.loadSnapshot(snapshot);
    if (this.currentColorOverrides) {
      (this.atomRenderer as ImpostorAtomMesh).applyColorOverrides(this.currentColorOverrides);
    }

    if (this.atomScale !== 1.0 && this.atomRenderer.setScale) {
      this.atomRenderer.setScale(this.atomScale, snapshot);
    }
    if (this.atomOpacity !== 1.0 && this.atomRenderer.setOpacity) {
      this.atomRenderer.setOpacity(this.atomOpacity);
    }

    if (!this.drawingBoundaryAtomRenderer) {
      this.drawingBoundaryAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.drawingBoundaryAtomRenderer.group);
    }
    this.drawingBoundaryAtomRenderer.loadSnapshot(snapshot, this.drawingBoundary);
    this.drawingBoundaryAtomRenderer.setScale(this.atomScale);
    this.drawingBoundaryAtomRenderer.setOpacity(this.atomOpacity);
    this.drawingBoundaryAtomRenderer.setScaleOverrides(this.currentScaleOverrides);
    this.drawingBoundaryAtomRenderer.setOpacityOverrides(this.currentOpacityOverrides);
    this.drawingBoundaryAtomRenderer.applyColorOverrides(this.currentColorOverrides);

    if (!this.bondPeriodicAtomRenderer) {
      this.bondPeriodicAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.bondPeriodicAtomRenderer.group);
    }
    this.bondPeriodicAtomRenderer.loadImages(snapshot, this.bondPeriodicImages);
    this.bondPeriodicAtomRenderer.setScale(this.atomScale);
    this.bondPeriodicAtomRenderer.setOpacity(this.atomOpacity);
    this.bondPeriodicAtomRenderer.setScaleOverrides(this.currentScaleOverrides);
    this.bondPeriodicAtomRenderer.setOpacityOverrides(this.currentOpacityOverrides);
    this.bondPeriodicAtomRenderer.applyColorOverrides(this.currentColorOverrides);

    if (!this.bondRenderer) {
      const bonds = new ImpostorBondMesh();
      this.bondRenderer = bonds;
      this.scene.add(bonds.mesh);
      // Mirror the ball sizes into the bond shader so sticks are trimmed at the
      // ball surface; the sink fires immediately and on every later restyle.
      this.atomRenderer?.setRadiusSink?.((radii, scale) => {
        if (radii) bonds.setAtomRadii(radii);
        bonds.setAtomRadiusScale(scale);
      });
    }

    // Cell
    if (snapshot.box) {
      const hasNonZero = snapshot.box.some((v) => v !== 0);
      if (hasNonZero) {
        if (!this.cellRenderer) {
          this.cellRenderer = new CellRenderer();
          this.scene.add(this.cellRenderer.mesh);
        }
        this.cellRenderer.loadBox(snapshot.box, snapshot.boxOrigin);
      }
    }
  }

  /**
   * Apply per-atom RGB color overrides on this layer's atom mesh. Null reverts
   * the layer to base CPK colors. Bond colors are re-derived from the atom
   * buffer in the same call.
   */
  applyAtomColorOverrides(overrides: Float32Array | null): void {
    if (overrides === this.currentColorOverrides) return;
    this.currentColorOverrides = overrides;
    if (!this.snapshot || !this.atomRenderer) return;

    this.atomRenderer.loadSnapshot(this.snapshot);
    if (this.atomScale !== 1.0 && this.atomRenderer.setScale) {
      this.atomRenderer.setScale(this.atomScale, this.snapshot);
    }
    if (overrides) {
      (this.atomRenderer as ImpostorAtomMesh).applyColorOverrides(overrides);
    }
    this.drawingBoundaryAtomRenderer?.applyColorOverrides(overrides);
    this.bondPeriodicAtomRenderer?.applyColorOverrides(overrides);
    this.syncBondColorsToAtoms();
  }

  private syncBondColorsToAtoms(snapshot?: Snapshot): void {
    const snap = snapshot ?? this.snapshot;
    if (!snap || !this.atomRenderer || !this.bondRenderer || snap.nBonds === 0) return;
    const atom = this.atomRenderer as ImpostorAtomMesh;
    const bond = this.bondRenderer as ImpostorBondMesh;
    bond.recomputeColorsFromAtomBuffer(atom.getColorBuffer(), snap);
  }

  updateFrame(frame: Frame): void {
    if (!this.snapshot || !this.atomRenderer || !this.bondRenderer) return;
    if (!this.currentPositions || this.currentPositions.length < frame.positions.length) {
      this.currentPositions = new Float32Array(frame.positions.length);
    }
    this.currentPositions.set(frame.positions);
    this.atomRenderer.updatePositions(frame.positions);
    if (this.drawingBoundary) {
      const frameSnapshot: Snapshot = {
        ...this.snapshot,
        nAtoms: frame.nAtoms,
        positions: frame.positions,
        elements: frame.elements ?? this.snapshot.elements,
        box: frame.box ?? this.snapshot.box,
        boxOrigin: frame.boxOrigin ?? this.snapshot.boxOrigin,
      };
      this.drawingBoundary = generateDrawingBoundaryImages(
        frameSnapshot,
        this.drawingBoundary.min,
        this.drawingBoundary.max,
      );
      this.drawingBoundaryAtomRenderer?.loadSnapshot(frameSnapshot, this.drawingBoundary);
    }
    this.bondRenderer.updatePositions(frame.positions, this.snapshot.bonds, this.snapshot.nBonds);
  }

  updateBondsExt(
    bonds: Uint32Array,
    bondOrders: Uint8Array | null,
    positions: Float32Array | null,
    elements: Uint8Array | null,
    nAtoms: number,
  ): void {
    if (!this.snapshot || !this.bondRenderer) return;
    const pos = positions ?? this.currentPositions ?? this.snapshot.positions;
    const elems = elements ?? this.snapshot.elements;
    const atomCount = nAtoms || this.snapshot.nAtoms;
    const extSnap = {
      ...this.snapshot,
      nAtoms: atomCount,
      nBonds: bonds.length / 2,
      bonds,
      bondOrders,
      positions: pos,
      elements: elems,
    };
    this.bondRenderer.loadSnapshot(extSnap);
    if (this.bondScale !== 1.0 && this.bondRenderer.setScale) {
      this.bondRenderer.setScale(this.bondScale, this.snapshot);
    }
    this.syncBondColorsToAtoms(extSnap);
  }

  setDrawingBoundary(boundary: DrawingBoundaryData | null): void {
    this.drawingBoundary = boundary;
    if (!this.snapshot) return;
    if (!this.drawingBoundaryAtomRenderer) {
      this.drawingBoundaryAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.drawingBoundaryAtomRenderer.group);
    }
    this.drawingBoundaryAtomRenderer.loadSnapshot(this.snapshot, boundary);
    if (boundary) {
      const hidden = new Uint8Array(this.snapshot.nAtoms);
      for (let atom = 0; atom < hidden.length; atom++) {
        hidden[atom] = boundary.sourceVisibleMask[atom] ? 0 : 1;
      }
      this.atomRenderer?.setHiddenMask?.(hidden);
    } else {
      this.atomRenderer?.setHiddenMask?.(null);
    }
  }

  setBondPeriodicImages(images: PeriodicAtomImageData | null): void {
    this.bondPeriodicImages = images;
    if (!this.snapshot) return;
    if (!this.bondPeriodicAtomRenderer) {
      this.bondPeriodicAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.bondPeriodicAtomRenderer.group);
    }
    this.bondPeriodicAtomRenderer.loadImages(this.snapshot, images);
    this.bondPeriodicAtomRenderer.setScale(this.atomScale);
    this.bondPeriodicAtomRenderer.setOpacity(this.atomOpacity);
    this.bondPeriodicAtomRenderer.setScaleOverrides(this.currentScaleOverrides);
    this.bondPeriodicAtomRenderer.setOpacityOverrides(this.currentOpacityOverrides);
    this.bondPeriodicAtomRenderer.applyColorOverrides(this.currentColorOverrides);
  }

  setAtomScale(scale: number): void {
    this.atomScale = scale;
    if (this.atomRenderer?.setScale && this.snapshot) {
      this.atomRenderer.setScale(scale, this.snapshot);
    }
    this.drawingBoundaryAtomRenderer?.setScale(scale);
    this.bondPeriodicAtomRenderer?.setScale(scale);
  }

  setAtomOpacity(opacity: number): void {
    this.atomOpacity = opacity;
    this.atomRenderer?.setOpacity?.(opacity);
    this.drawingBoundaryAtomRenderer?.setOpacity(opacity);
    this.bondPeriodicAtomRenderer?.setOpacity(opacity);
  }

  setAtomScaleOverrides(overrides: Float32Array): void {
    this.currentScaleOverrides = overrides;
    this.atomRenderer?.setScaleOverrides?.(overrides);
    this.drawingBoundaryAtomRenderer?.setScaleOverrides(overrides);
    this.bondPeriodicAtomRenderer?.setScaleOverrides(overrides);
  }

  setAtomOpacityOverrides(overrides: Float32Array): void {
    this.currentOpacityOverrides = overrides;
    this.atomRenderer?.setOpacityOverrides?.(overrides);
    this.drawingBoundaryAtomRenderer?.setOpacityOverrides(overrides);
    this.bondPeriodicAtomRenderer?.setOpacityOverrides(overrides);
  }

  clearAtomOverrides(): void {
    this.currentScaleOverrides = null;
    this.currentOpacityOverrides = null;
    this.atomRenderer?.clearOverrides?.();
    this.drawingBoundaryAtomRenderer?.clearOverrides();
    this.bondPeriodicAtomRenderer?.clearOverrides();
  }

  setBondScale(scale: number): void {
    this.bondScale = scale;
    if (this.bondRenderer?.setScale && this.snapshot) {
      this.bondRenderer.setScale(scale, this.snapshot);
    }
  }

  setBondOpacity(opacity: number): void {
    this.bondOpacity = opacity;
    this.bondRenderer?.setOpacity?.(opacity);
  }

  setBondOpacityOverrides(overrides: Float32Array): void {
    this.bondRenderer?.setBondOpacityOverrides?.(overrides);
  }

  clearBondOpacityOverrides(): void {
    this.bondRenderer?.clearBondOpacityOverrides?.();
  }

  setAtomsVisible(visible: boolean): void {
    if (this.atomRenderer) {
      this.atomRenderer.mesh.visible = visible;
    }
    this.drawingBoundaryAtomRenderer?.setVisible(visible);
    this.bondPeriodicAtomRenderer?.setVisible(visible);
  }

  setBondsVisible(visible: boolean): void {
    if (this.bondRenderer) {
      this.bondRenderer.mesh.visible = visible;
    }
  }

  setCellVisible(visible: boolean): void {
    if (this.cellRenderer) {
      this.cellRenderer.setVisible(visible);
    }
  }

  isAtomsVisible(): boolean {
    return this.atomRenderer?.mesh.visible ?? false;
  }

  isBondsVisible(): boolean {
    return this.bondRenderer?.mesh.visible ?? false;
  }

  isCellVisible(): boolean {
    return this.cellRenderer?.mesh.visible ?? false;
  }

  getPositions(): Float32Array | null {
    return this.currentPositions ?? this.snapshot?.positions ?? null;
  }

  dispose(): void {
    if (this.atomRenderer) {
      this.scene.remove(this.atomRenderer.mesh);
      this.atomRenderer.dispose();
      this.atomRenderer = null;
    }
    if (this.drawingBoundaryAtomRenderer) {
      this.scene.remove(this.drawingBoundaryAtomRenderer.group);
      this.drawingBoundaryAtomRenderer.dispose();
      this.drawingBoundaryAtomRenderer = null;
    }
    if (this.bondPeriodicAtomRenderer) {
      this.scene.remove(this.bondPeriodicAtomRenderer.group);
      this.bondPeriodicAtomRenderer.dispose();
      this.bondPeriodicAtomRenderer = null;
    }
    if (this.bondRenderer) {
      this.scene.remove(this.bondRenderer.mesh);
      this.bondRenderer.dispose();
      this.bondRenderer = null;
    }
    if (this.cellRenderer) {
      this.scene.remove(this.cellRenderer.mesh);
      this.cellRenderer.dispose();
      this.cellRenderer = null;
    }
    this.snapshot = null;
    this.currentPositions = null;
  }
}
