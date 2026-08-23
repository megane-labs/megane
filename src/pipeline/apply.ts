/**
 * Applies a ViewportState to a MoleculeRenderer instance.
 * Translates the typed data streams into renderer calls.
 *
 * Supports multi-structure overlay: particles/bonds/cells from different
 * load_structure nodes are routed to separate StructureLayers in the renderer.
 * The "primary" structure (first particle source, matching the Viewport's
 * snapshot prop) uses the renderer's built-in atom/bond renderers.
 * Additional structures use StructureLayer instances.
 */

import type {
  ViewportState,
  ParticleData,
  BondData,
  LabelData,
  MeshData,
  VectorData,
} from "./types";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { getVectorsForFrame } from "../logic/vectorSourceLogic";

/**
 * Apply the current ViewportState to the renderer.
 * If previous is null, all properties are applied (initial).
 * atomLabels is required for residue/chain color schemes.
 */
export function applyViewportState(
  renderer: MoleculeRenderer,
  current: ViewportState,
  previous: ViewportState | null,
  primaryNodeId?: string | null,
  _atomLabels?: string[] | null,
): void {
  // ─── Determine which node IDs are primary vs layer ─────────
  const currentNodeIds = collectSourceNodeIds(current);
  const resolvedPrimaryId = primaryNodeId ?? currentNodeIds[0] ?? null;

  // Group data by source node
  const primaryParticles = current.particles.filter((p) => p.sourceNodeId === resolvedPrimaryId);
  const layerParticles = current.particles.filter((p) => p.sourceNodeId !== resolvedPrimaryId);
  const primaryBonds = current.bonds.filter((b) => b.sourceNodeId === resolvedPrimaryId);
  const layerBonds = current.bonds.filter((b) => b.sourceNodeId !== resolvedPrimaryId);
  const primaryCells = current.cells.filter((c) => c.sourceNodeId === resolvedPrimaryId);
  const layerCells = current.cells.filter((c) => c.sourceNodeId !== resolvedPrimaryId);

  // Previous state grouping
  const prevPrimaryParticles =
    previous?.particles.filter((p) => p.sourceNodeId === resolvedPrimaryId) ?? null;
  const prevPrimaryBonds =
    previous?.bonds.filter((b) => b.sourceNodeId === resolvedPrimaryId) ?? null;

  // ─── Primary structure: use renderer's built-in renderers ──
  const hasParticles = primaryParticles.length > 0;
  const hadParticles = (prevPrimaryParticles?.length ?? 0) > 0;
  if (!previous || hasParticles !== hadParticles) {
    renderer.setAtomsVisible(hasParticles);
  }

  const drawingBoundary =
    primaryParticles.find((particle) => particle.drawingBoundary)?.drawingBoundary ?? null;
  const previousDrawingBoundary =
    prevPrimaryParticles?.find((particle) => particle.drawingBoundary)?.drawingBoundary ?? null;
  if (!previous || drawingBoundary !== previousDrawingBoundary) {
    renderer.setDrawingBoundary?.(drawingBoundary);
  }

  applyParticleOverrides(renderer, primaryParticles, prevPrimaryParticles);
  applyBondSettings(renderer, primaryBonds, prevPrimaryBonds);

  // Primary cell visibility: a cell renders whenever the pipeline produced
  // one. Cell data carries geometry only; axes visibility is governed by the
  // Viewport node's `cellAxesVisible` parameter (applied near the bottom of
  // this function).
  const cellVisible = primaryCells.length > 0;
  const prevCellVisible =
    (previous ? previous.cells.filter((c) => c.sourceNodeId === resolvedPrimaryId).length : 0) > 0;
  if (!previous || cellVisible !== prevCellVisible) {
    renderer.setCellVisible(cellVisible);
  }

  // Primary bonds visibility
  const bondsVisible = primaryBonds.length > 0;
  const prevBondsVisible = (prevPrimaryBonds?.length ?? 0) > 0;
  if (!previous || bondsVisible !== prevBondsVisible) {
    renderer.setBondsVisible(bondsVisible);
  }

  // ─── Layer structures: use StructureLayer instances ────────
  const activeLayerIds = new Set<string>();

  // Group layer particles by sourceNodeId
  const layerParticlesByNode = groupBy(layerParticles, (p) => p.sourceNodeId);
  const layerBondsByNode = groupBy(layerBonds, (b) => b.sourceNodeId);
  const layerCellsByNode = groupBy(layerCells, (c) => c.sourceNodeId);

  for (const [nodeId, particles] of layerParticlesByNode) {
    activeLayerIds.add(nodeId);
    const layer = renderer.getOrCreateLayer(nodeId);

    // Load snapshot if the layer doesn't have one yet, or if it changed
    const firstParticle = particles[0];
    if (firstParticle && layer.snapshot !== firstParticle.source) {
      layer.loadSnapshot(firstParticle.source);
    }
    layer.setDrawingBoundary(
      particles.find((particle) => particle.drawingBoundary)?.drawingBoundary ?? null,
    );

    // Apply overrides
    applyLayerParticleOverrides(layer, particles);

    // Apply bonds for this layer
    const bonds = layerBondsByNode.get(nodeId);
    if (bonds && bonds.length > 0) {
      const bond = bonds[0];
      layer.setBondPeriodicImages(bond.periodicImages ?? null);
      layer.updateBondsExt(
        bond.bondIndices,
        bond.bondOrders,
        bond.positions,
        bond.elements,
        bond.nAtoms,
      );
      layer.setBondScale(bond.scale);
      if (bond.bondOpacityOverrides) {
        layer.setBondOpacityOverrides(bond.bondOpacityOverrides);
      } else {
        layer.clearBondOpacityOverrides();
        layer.setBondOpacity(bond.opacity);
      }
      layer.setBondsVisible(true);
    } else {
      layer.setBondPeriodicImages(null);
      layer.setBondsVisible(false);
    }

    // Apply cells for this layer: a cell renders whenever one was produced.
    const cells = layerCellsByNode.get(nodeId);
    layer.setCellVisible((cells?.length ?? 0) > 0);

    layer.setAtomsVisible(true);
  }

  // Remove layers that no longer have particles
  renderer.removeInactiveLayers(activeLayerIds);

  // ─── Display settings (global) ─────────────────────────────
  if (!previous || current.perspective !== previous.perspective) {
    renderer.setPerspective(current.perspective);
  }
  if (!previous || current.cellAxesVisible !== previous.cellAxesVisible) {
    renderer.setCellAxesVisible(current.cellAxesVisible);
  }
  if (!previous || current.pivotMarkerVisible !== previous.pivotMarkerVisible) {
    renderer.setPivotMarkerVisible(current.pivotMarkerVisible);
  }
  if (!previous || current.representationMode !== previous.representationMode) {
    renderer.setRepresentationType(current.representationMode ?? "atoms");
  }
  // Per-atom representation (e.g. "water as lines"). Re-apply whenever the
  // global mode was just (re)set above, since setRepresentationType reloads the
  // line geometry and would otherwise drop the per-atom split.
  if (
    !previous ||
    current.representationMode !== previous.representationMode ||
    !sameRepresentationByAtom(current.representationByAtom, previous.representationByAtom)
  ) {
    renderer.setRepresentationByAtom(current.representationByAtom);
  }

  // ─── Labels (primary structure only for now) ───────────────
  applyLabels(renderer, current.labels, previous?.labels ?? null);

  // ─── Meshes (polyhedra) ────────────────────────────────────
  applyMeshes(renderer, current.meshes, previous?.meshes ?? null);

  // ─── Vectors (arrows, primary structure only for now) ──────
  applyVectors(renderer, current.vectors, previous?.vectors ?? null);
}

/** Value-equality for the per-atom representation arrays (cheap diff). */
function sameRepresentationByAtom(
  a: ViewportState["representationByAtom"],
  b: ViewportState["representationByAtom"],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Collect unique source node IDs from all data in a ViewportState. */
function collectSourceNodeIds(state: ViewportState): string[] {
  const ids = new Set<string>();
  for (const p of state.particles) ids.add(p.sourceNodeId);
  for (const b of state.bonds) ids.add(b.sourceNodeId);
  for (const c of state.cells) ids.add(c.sourceNodeId);
  return Array.from(ids);
}

/** Group items by a key function. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(item);
  }
  return map;
}

function applyParticleOverrides(
  renderer: MoleculeRenderer,
  particles: ParticleData[],
  _prevParticles: ParticleData[] | null,
): void {
  if (particles.length === 0) {
    // Idempotent reset: callers may pass `previous=null`, so we cannot rely
    // on prev to detect a prior non-empty state when scrubbing overrides.
    renderer.clearAtomOverrides();
    renderer.setAtomScale(1.0);
    renderer.setAtomOpacity(1.0);
    renderer.applyAtomColorOverrides(null);
    return;
  }

  const merged = mergeParticleOverrides(particles);

  if (merged.scale) {
    renderer.setAtomScale(1.0);
    renderer.setAtomScaleOverrides(merged.scale);
  } else {
    renderer.clearAtomOverrides();
    renderer.setAtomScale(1.0);
  }

  if (merged.opacity) {
    renderer.setAtomOpacity(1.0);
    renderer.setAtomOpacityOverrides(merged.opacity);
  } else {
    renderer.setAtomOpacity(1.0);
  }

  renderer.applyAtomColorOverrides(merged.color);
}

/** Apply overrides to a StructureLayer. */
function applyLayerParticleOverrides(
  layer: {
    setAtomScale: (s: number) => void;
    setAtomOpacity: (o: number) => void;
    setAtomScaleOverrides: (o: Float32Array) => void;
    setAtomOpacityOverrides: (o: Float32Array) => void;
    clearAtomOverrides: () => void;
    applyAtomColorOverrides: (overrides: Float32Array | null) => void;
  },
  particles: ParticleData[],
): void {
  const merged = mergeParticleOverrides(particles);

  if (merged.scale) {
    layer.setAtomScale(1.0);
    layer.setAtomScaleOverrides(merged.scale);
  } else {
    layer.clearAtomOverrides();
    layer.setAtomScale(1.0);
  }

  if (merged.opacity) {
    layer.setAtomOpacity(1.0);
    layer.setAtomOpacityOverrides(merged.opacity);
  } else {
    layer.setAtomOpacity(1.0);
  }

  layer.applyAtomColorOverrides(merged.color);
}

/**
 * Merge per-atom overrides across multiple particle streams targeting the
 * same structure. Scale / opacity collapse to "any non-1.0 wins"; color
 * collapses to "any non-NaN wins" (last-write semantics in stream order).
 */
function mergeParticleOverrides(particles: ParticleData[]): {
  scale: Float32Array | null;
  opacity: Float32Array | null;
  color: Float32Array | null;
} {
  let scale: Float32Array | null = null;
  let opacity: Float32Array | null = null;
  let color: Float32Array | null = null;

  for (const p of particles) {
    if (p.scaleOverrides) {
      if (!scale) {
        scale = new Float32Array(p.scaleOverrides);
      } else {
        for (let i = 0; i < scale.length; i++) {
          if (p.scaleOverrides[i] !== 1.0) {
            scale[i] = p.scaleOverrides[i];
          }
        }
      }
    }
    if (p.opacityOverrides) {
      if (!opacity) {
        opacity = new Float32Array(p.opacityOverrides);
      } else {
        for (let i = 0; i < opacity.length; i++) {
          if (p.opacityOverrides[i] !== 1.0) {
            opacity[i] = p.opacityOverrides[i];
          }
        }
      }
    }
    if (p.colorOverrides) {
      if (!color) {
        color = new Float32Array(p.colorOverrides);
      } else {
        for (let i = 0; i < color.length; i += 3) {
          if (!Number.isNaN(p.colorOverrides[i])) {
            color[i] = p.colorOverrides[i];
            color[i + 1] = p.colorOverrides[i + 1];
            color[i + 2] = p.colorOverrides[i + 2];
          }
        }
      }
    }
  }

  return { scale, opacity, color };
}

function applyBondSettings(
  renderer: MoleculeRenderer,
  bonds: BondData[],
  prevBonds: BondData[] | null,
): void {
  if (bonds.length === 0) {
    renderer.setBondPeriodicImages?.(null);
    return;
  }

  const bond = bonds[0];
  const prevBond = prevBonds?.[0];

  if (!prevBond || bond.periodicImages !== prevBond.periodicImages) {
    renderer.setBondPeriodicImages?.(bond.periodicImages ?? null);
  }

  if (!prevBond || bond.bondIndices !== prevBond.bondIndices) {
    renderer.updateBondsExt(
      bond.bondIndices,
      bond.bondOrders,
      bond.positions,
      bond.elements,
      bond.nAtoms,
    );
  }

  if (!prevBond || bond.scale !== prevBond.scale) {
    renderer.setBondScale(bond.scale);
  }
  if (!prevBond || bond.bondOpacityOverrides !== prevBond?.bondOpacityOverrides) {
    if (bond.bondOpacityOverrides) {
      renderer.setBondOpacityOverrides(bond.bondOpacityOverrides);
    } else {
      renderer.clearBondOpacityOverrides();
      if (!prevBond || bond.opacity !== prevBond.opacity) {
        renderer.setBondOpacity(bond.opacity);
      }
    }
  } else if (!prevBond || bond.opacity !== prevBond.opacity) {
    renderer.setBondOpacity(bond.opacity);
  }
}

function applyLabels(
  renderer: MoleculeRenderer,
  labels: LabelData[],
  _prevLabels: LabelData[] | null,
): void {
  if (labels.length > 0) {
    renderer.setLabels(labels[0].labels);
  } else {
    // Idempotent: callers may pass `previous=null`, so always clear.
    renderer.setLabels(null);
  }
}

function applyMeshes(
  renderer: MoleculeRenderer,
  meshes: MeshData[],
  _prevMeshes: MeshData[] | null,
): void {
  if (meshes.length > 0) {
    renderer.loadPolyhedra(meshes[0]);
  } else {
    // Idempotent: callers may pass `previous=null`, so always clear.
    renderer.clearPolyhedra();
  }
}

function applyVectors(
  renderer: MoleculeRenderer,
  vectors: VectorData[],
  _prevVectors: VectorData[] | null,
): void {
  if (vectors.length > 0) {
    const vd = vectors[0];
    const frameVectors = getVectorsForFrame({ fileVectors: vd.frames }, 0);
    renderer.setVectors(frameVectors);
    renderer.setVectorScale(vd.scale);
  } else {
    // Idempotent: callers may pass `previous=null`, so always clear.
    renderer.setVectors(null);
  }
}

/**
 * Update vector arrows for the given frame index.
 * Called on each frame change when vector data is in the viewport state.
 */
export function applyVectorsForFrame(
  renderer: MoleculeRenderer,
  vectors: VectorData[],
  frameIndex: number,
): void {
  if (vectors.length === 0) return;
  const vd = vectors[0];
  const frameVectors = getVectorsForFrame({ fileVectors: vd.frames }, frameIndex);
  renderer.setVectors(frameVectors);
  renderer.setVectorScale(vd.scale);
}
