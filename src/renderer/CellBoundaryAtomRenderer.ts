import * as THREE from "three";
import type { Snapshot } from "../types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { ImpostorAtomMesh } from "./ImpostorAtomMesh";
import { BALL_STICK_ATOM_SCALE } from "../constants";

/**
 * Visual layer for periodic atom images. Images mirror their structural
 * source atom's color, size, opacity, and representation mask while retaining
 * stable source-index provenance for external picking and labels.
 */
export class DrawingBoundaryAtomRenderer {
  readonly group = new THREE.Group();

  private atoms = new ImpostorAtomMesh(1);
  private imageSnapshot: Snapshot | null = null;
  private sourceIndices: Uint32Array = new Uint32Array();
  private scale = 1;
  private opacity = 1;
  private uniformRadius: number | null = null;
  private radiusScale = BALL_STICK_ATOM_SCALE;
  private illustrative = false;
  private scaleOverrides: Float32Array | null = null;
  private opacityOverrides: Float32Array | null = null;
  private colorOverrides: Float32Array | null = null;
  private hiddenMask: Uint8Array | null = null;

  constructor() {
    this.group.name = "cell-boundary-atoms";
    this.atoms.mesh.name = "cell-boundary-atom-impostors";
    this.group.add(this.atoms.mesh);
  }

  loadSnapshot(source: Snapshot, boundary: DrawingBoundaryData | null): void {
    this.loadImages(source, boundary?.images ?? null);
  }

  loadImages(source: Snapshot, value: PeriodicAtomImageData | null): void {
    const images = value ?? {
      positions: new Float32Array(),
      elements: new Uint8Array(),
      sourceIndices: new Uint32Array(),
      latticeShifts: new Int32Array(),
    };
    this.sourceIndices = images.sourceIndices;
    this.imageSnapshot = {
      ...source,
      nAtoms: images.elements.length,
      nBonds: 0,
      nFileBonds: 0,
      positions: images.positions,
      elements: images.elements,
      bonds: new Uint32Array(),
      bondOrders: null,
      box: null,
      boxOrigin: null,
    };
    this.reapplyAppearance();
  }

  setScale(scale: number): void {
    this.scale = scale;
    if (this.imageSnapshot) this.atoms.setScale(scale, this.imageSnapshot);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.atoms.setOpacity(opacity);
  }

  setUniformRadius(radius: number | null): void {
    this.uniformRadius = radius;
    if (this.imageSnapshot) this.atoms.setUniformRadius(radius, this.imageSnapshot);
  }

  /** Mirror the structural atoms' vdW radius fraction (spacefill vs ball-and-stick). */
  setRadiusScale(scale: number): void {
    this.radiusScale = scale;
    if (this.imageSnapshot) this.atoms.setRadiusScale(scale, this.imageSnapshot);
  }

  /** Mirror the structural atoms' illustrative (flat + outline) shading. */
  setIllustrative(enabled: boolean): void {
    this.illustrative = enabled;
    this.atoms.setIllustrative(enabled);
  }

  setScaleOverrides(overrides: Float32Array | null): void {
    this.scaleOverrides = overrides;
    if (overrides) this.atoms.setScaleOverrides(this.mapScalar(overrides, 1));
    else this.atoms.clearOverrides();
  }

  setOpacityOverrides(overrides: Float32Array | null): void {
    this.opacityOverrides = overrides;
    if (overrides) this.atoms.setOpacityOverrides(this.mapScalar(overrides, 1));
    else this.reapplyAppearance();
  }

  applyColorOverrides(overrides: Float32Array | null): void {
    this.colorOverrides = overrides;
    this.reapplyAppearance();
  }

  clearOverrides(): void {
    this.scaleOverrides = null;
    this.opacityOverrides = null;
    this.atoms.clearOverrides();
  }

  setHiddenMask(mask: Uint8Array | null): void {
    this.hiddenMask = mask;
    this.atoms.setHiddenMask(mask ? this.mapMask(mask) : null);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  get count(): number {
    return this.sourceIndices.length;
  }

  get positions(): Float32Array | null {
    return this.imageSnapshot?.positions ?? null;
  }

  dispose(): void {
    this.atoms.dispose();
    this.group.clear();
  }

  private reapplyAppearance(): void {
    if (!this.imageSnapshot) return;
    this.atoms.loadSnapshot(this.imageSnapshot);
    this.atoms.setScale(this.scale, this.imageSnapshot);
    this.atoms.setOpacity(this.opacity);
    this.atoms.setRadiusScale(this.radiusScale, this.imageSnapshot);
    this.atoms.setUniformRadius(this.uniformRadius, this.imageSnapshot);
    this.atoms.setIllustrative(this.illustrative);
    if (this.scaleOverrides) {
      this.atoms.setScaleOverrides(this.mapScalar(this.scaleOverrides, 1));
    }
    if (this.opacityOverrides) {
      this.atoms.setOpacityOverrides(this.mapScalar(this.opacityOverrides, 1));
    }
    if (this.colorOverrides) {
      this.atoms.applyColorOverrides(this.mapColor(this.colorOverrides));
    }
    if (this.hiddenMask) {
      this.atoms.setHiddenMask(this.mapMask(this.hiddenMask));
    }
  }

  private mapScalar(source: Float32Array, fallback: number): Float32Array {
    const mapped = new Float32Array(this.sourceIndices.length);
    for (let i = 0; i < mapped.length; i++) {
      mapped[i] = source[this.sourceIndices[i]] ?? fallback;
    }
    return mapped;
  }

  private mapMask(source: Uint8Array): Uint8Array {
    const mapped = new Uint8Array(this.sourceIndices.length);
    for (let i = 0; i < mapped.length; i++) {
      mapped[i] = source[this.sourceIndices[i]] ?? 0;
    }
    return mapped;
  }

  private mapColor(source: Float32Array): Float32Array {
    const mapped = new Float32Array(this.sourceIndices.length * 3).fill(Number.NaN);
    for (let i = 0; i < this.sourceIndices.length; i++) {
      const src3 = this.sourceIndices[i] * 3;
      const dst3 = i * 3;
      if (src3 + 2 >= source.length) continue;
      mapped[dst3] = source[src3];
      mapped[dst3 + 1] = source[src3 + 1];
      mapped[dst3 + 2] = source[src3 + 2];
    }
    return mapped;
  }
}
