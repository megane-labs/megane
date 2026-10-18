/**
 * AtomLayerGroup: the primary structural atom renderer plus the display-only
 * atom layers that mirror it, kept in lock-step.
 *
 * The primary renderer draws the structure's own atoms; it is pickable and its
 * instance index is the atom index. Two secondary layers draw periodic copies
 * of those atoms without changing topology:
 *
 * - `"drawingBoundary"` — copies on the inclusive faces of a Drawing Boundary
 *   range (an atom on x = 0 is also drawn at x = 1);
 * - `"bondPeriodic"` — neighbour images a coordination / bond stream adds
 *   outside the range to complete a visible centre.
 *
 * Every appearance setter goes through this group, which records the value and
 * fans it out to every layer that exists. Secondary layers are created lazily
 * (the scene only exists once the viewer mounts, and they need a snapshot to
 * map onto); a layer created later is replayed the full recorded state, so it
 * can never come up at a stale radius, shading, visibility or override set.
 * Each `DrawingBoundaryAtomRenderer` keeps its own copy of the state and
 * re-applies it whenever it reloads, so later loads need no replay.
 *
 * Ownership: the group disposes every renderer it holds. The caller still
 * creates the primary (it is paired with the bond renderer) and adds it to the
 * scene; secondary layers are attached through the `attach` callback.
 *
 * What stays with the caller: loading the primary (`loadSnapshot` resets its
 * per-atom buffers, so the caller restores them in a specific order), the
 * primary's colour repaint (it reloads the mesh and re-syncs bond colours), and
 * the primary's hidden mask (combined with the Drawing Boundary source mask,
 * which secondary layers must not see because their copies are already
 * range-filtered).
 */

import type * as THREE from "three";
import type { AtomRenderer, Snapshot } from "../types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { DrawingBoundaryAtomRenderer } from "./CellBoundaryAtomRenderer";
import { representationFlags, type RepresentationType } from "./representation";

/** Which display-only atom layer. */
export type SecondaryAtomLayerKind = "drawingBoundary" | "bondPeriodic";

/** The appearance state the group last applied, replayed onto new layers. */
export interface AtomLayerState {
  /** Global atom radius multiplier. */
  scale: number;
  /** Global atom opacity. */
  opacity: number;
  /** Per-atom scale multipliers (source-atom indexed), or null. */
  scaleOverrides: Float32Array | null;
  /** Per-atom opacities (source-atom indexed), or null. */
  opacityOverrides: Float32Array | null;
  /** Per-atom RGB (source-atom indexed, NaN = keep palette), or null. */
  colorOverrides: Float32Array | null;
  /** Fraction of the vdW radius atoms are drawn at. */
  radiusScale: number;
  /** Licorice radius shared by every atom, or null for per-element radii. */
  uniformRadius: number | null;
  /** Flat, unlit shading with a silhouette outline. */
  illustrative: boolean;
  /** Whether atom spheres are drawn at all. */
  visible: boolean;
  /**
   * Source-atom mask hiding atoms another renderer draws (per-atom "line"
   * representation). Applied to the secondary layers only; see the class note.
   */
  secondaryHiddenMask: Uint8Array | null;
}

const SECONDARY_KINDS: readonly SecondaryAtomLayerKind[] = ["drawingBoundary", "bondPeriodic"];

/**
 * @typeParam P the primary renderer's concrete type, so a caller that always
 *   creates the same mesh class gets it back from {@link primary} without a cast.
 */
export class AtomLayerGroup<P extends AtomRenderer = AtomRenderer> {
  private primaryRenderer: P | null = null;
  private readonly secondaries = new Map<SecondaryAtomLayerKind, DrawingBoundaryAtomRenderer>();
  private readonly current: AtomLayerState = {
    scale: 1,
    opacity: 1,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    radiusScale: representationFlags("atoms").atomRadiusScale,
    uniformRadius: null,
    illustrative: false,
    visible: true,
    secondaryHiddenMask: null,
  };

  /**
   * @param attach adds a newly created secondary layer's object to the scene.
   *   Called lazily, so it may read a scene that did not exist at construction.
   */
  constructor(private readonly attach: (object: THREE.Object3D) => void) {}

  /** The primary (pickable, topology-owning) atom renderer, if created. */
  get primary(): P | null {
    return this.primaryRenderer;
  }

  /**
   * Adopt a newly created primary renderer (the previous one is the caller's
   * to remove and dispose). No state is replayed onto it; see the class note.
   */
  setPrimary(renderer: P | null): void {
    this.primaryRenderer = renderer;
  }

  /** A secondary layer if it has been created, without creating it. */
  peekSecondary(kind: SecondaryAtomLayerKind): DrawingBoundaryAtomRenderer | null {
    return this.secondaries.get(kind) ?? null;
  }

  /** The last applied appearance state (read-only view; mutate via the setters). */
  get state(): Readonly<AtomLayerState> {
    return this.current;
  }

  /** Load the Drawing Boundary copies of `source`, creating the layer if needed. */
  loadDrawingBoundary(source: Snapshot, boundary: DrawingBoundaryData | null): void {
    this.ensureSecondary("drawingBoundary", (layer) => layer.loadSnapshot(source, boundary));
  }

  /** Load the bond stream's periodic neighbour images, creating the layer if needed. */
  loadBondPeriodicImages(source: Snapshot, images: PeriodicAtomImageData | null): void {
    this.ensureSecondary("bondPeriodic", (layer) => layer.loadImages(source, images));
  }

  /**
   * Global atom radius multiplier. The primary is only rescaled when a
   * snapshot is supplied (its radius buffer is per element).
   */
  setScale(scale: number, snapshot: Snapshot | null): void {
    this.current.scale = scale;
    if (this.primaryRenderer?.setScale && snapshot) {
      this.primaryRenderer.setScale(scale, snapshot);
    }
    this.forEachSecondary((layer) => layer.setScale(scale));
  }

  /** Global atom opacity. */
  setOpacity(opacity: number): void {
    this.current.opacity = opacity;
    this.primaryRenderer?.setOpacity?.(opacity);
    this.forEachSecondary((layer) => layer.setOpacity(opacity));
  }

  /** Per-atom scale multipliers (e.g. from a Modify node). */
  setScaleOverrides(overrides: Float32Array): void {
    this.current.scaleOverrides = overrides;
    this.primaryRenderer?.setScaleOverrides?.(overrides);
    this.forEachSecondary((layer) => layer.setScaleOverrides(overrides));
  }

  /** Per-atom opacities (e.g. from a Modify node). */
  setOpacityOverrides(overrides: Float32Array): void {
    this.current.opacityOverrides = overrides;
    this.primaryRenderer?.setOpacityOverrides?.(overrides);
    this.forEachSecondary((layer) => layer.setOpacityOverrides(overrides));
  }

  /** Drop per-atom scale and opacity overrides, reverting to the globals. */
  clearOverrides(): void {
    this.current.scaleOverrides = null;
    this.current.opacityOverrides = null;
    this.primaryRenderer?.clearOverrides?.();
    this.forEachSecondary((layer) => layer.clearOverrides());
  }

  /**
   * Record per-atom colours and repaint the secondary layers. The caller
   * repaints the primary itself (see the class note).
   */
  setColorOverrides(overrides: Float32Array | null): void {
    this.current.colorOverrides = overrides;
    this.forEachSecondary((layer) => layer.applyColorOverrides(overrides));
  }

  /** Hide source atoms in the secondary layers (the caller masks the primary). */
  setSecondaryHiddenMask(mask: Uint8Array | null): void {
    this.current.secondaryHiddenMask = mask;
    this.forEachSecondary((layer) => layer.setHiddenMask(mask));
  }

  /**
   * Apply a representation mode's atom radius, shading and visibility to every
   * layer. The primary's radii are only rewritten when a snapshot is supplied.
   */
  setRepresentation(type: RepresentationType, snapshot: Snapshot | null): void {
    const flags = representationFlags(type);
    this.current.radiusScale = flags.atomRadiusScale;
    this.current.uniformRadius = flags.uniformRadius;
    this.current.illustrative = flags.illustrative;
    if (snapshot) {
      this.primaryRenderer?.setRadiusScale?.(flags.atomRadiusScale, snapshot);
      this.primaryRenderer?.setUniformRadius?.(flags.uniformRadius, snapshot);
    }
    this.forEachSecondary((layer) => {
      layer.setRadiusScale(flags.atomRadiusScale);
      layer.setUniformRadius(flags.uniformRadius);
    });
    this.primaryRenderer?.setIllustrative?.(flags.illustrative);
    this.forEachSecondary((layer) => layer.setIllustrative(flags.illustrative));
    this.setVisible(flags.showAtoms);
  }

  /** Show or hide every atom layer together. */
  setVisible(visible: boolean): void {
    this.current.visible = visible;
    if (this.primaryRenderer) this.primaryRenderer.mesh.visible = visible;
    this.forEachSecondary((layer) => layer.setVisible(visible));
  }

  /** Dispose every renderer the group holds. */
  dispose(): void {
    this.primaryRenderer?.dispose();
    this.primaryRenderer = null;
    this.forEachSecondary((layer) => layer.dispose());
    this.secondaries.clear();
  }

  private forEachSecondary(fn: (layer: DrawingBoundaryAtomRenderer) => void): void {
    for (const kind of SECONDARY_KINDS) {
      const layer = this.secondaries.get(kind);
      if (layer) fn(layer);
    }
  }

  /**
   * Run `load` on the layer, creating it first when missing. A new layer is
   * loaded before the state replay so the per-atom overrides map onto real
   * image atoms rather than an empty mesh.
   */
  private ensureSecondary(
    kind: SecondaryAtomLayerKind,
    load: (layer: DrawingBoundaryAtomRenderer) => void,
  ): void {
    const existing = this.secondaries.get(kind);
    if (existing) {
      load(existing);
      return;
    }
    const layer = new DrawingBoundaryAtomRenderer();
    this.secondaries.set(kind, layer);
    this.attach(layer.group);
    load(layer);
    this.replay(layer);
  }

  private replay(layer: DrawingBoundaryAtomRenderer): void {
    const s = this.current;
    layer.setScale(s.scale);
    layer.setOpacity(s.opacity);
    layer.setRadiusScale(s.radiusScale);
    layer.setUniformRadius(s.uniformRadius);
    layer.setIllustrative(s.illustrative);
    layer.setScaleOverrides(s.scaleOverrides);
    layer.setOpacityOverrides(s.opacityOverrides);
    layer.applyColorOverrides(s.colorOverrides);
    layer.setHiddenMask(s.secondaryHiddenMask);
    layer.setVisible(s.visible);
  }
}
