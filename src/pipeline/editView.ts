/**
 * The edit view: what the 3D view shows while the Build panel is open.
 *
 * Building changes what the structure *is*; the pipeline describes how it is
 * *shown*. While editing, the two must not be mixed — a Replicate makes one
 * loaded atom eight rendered ones, a Filter hides the atom the user wants to
 * click, a Representation turns it into a ribbon. So the Build panel switches
 * the viewer into an edit mode (the Blender "Edit Mode" idea: edit the base
 * mesh, re-apply the modifier stack on the way out): the view shows the
 * primary `load_structure` node's output — the file as loaded plus its edit
 * list — as ball-and-stick with every atom, its bonds and its cell, and the
 * rest of the graph is left alone until the panel closes.
 *
 * Nothing here executes downstream nodes. The graph is still executed for its
 * node errors (the store does that first), only the `ViewportState` is
 * replaced.
 */

import type { Node } from "@xyflow/react";
import type { PipelineNodeData, PipelineExecutionContext } from "./execute";
import { executeLoadStructure } from "./executors/loadStructure";
import { bondDataFromSnapshotBonds } from "./executors/addBond";
import { findPrimaryLoader } from "./editHistory";
import {
  DEFAULT_VIEWPORT_STATE,
  type CellData,
  type LoadStructureParams,
  type ParticleData,
  type ViewportParams,
  type ViewportState,
} from "./types";

/**
 * Build the edit-mode `ViewportState` for `nodes`: the primary loader's
 * edited structure (or the file as loaded while `ctx.editsBypassed` is on),
 * its own bonds, its cell, no trajectory, no overlays, ball-and-stick.
 *
 * Returns the empty default state when there is no loader or no structure in
 * it — the same "nothing to show" the pipeline view would have.
 */
export function buildEditViewportState(
  nodes: Node<PipelineNodeData>[],
  ctx: PipelineExecutionContext,
): ViewportState {
  const loader = findPrimaryLoader(nodes);
  if (!loader) return { ...DEFAULT_VIEWPORT_STATE };
  const snapshot = ctx.nodeSnapshots?.[loader.id]?.snapshot ?? ctx.snapshot ?? null;
  if (!snapshot) return { ...DEFAULT_VIEWPORT_STATE };

  // The loader executor is the one place edits are replayed; reuse it so the
  // edit view and the pipeline view can never disagree about the structure.
  const outputs = executeLoadStructure(
    loader.data.params as LoadStructureParams,
    snapshot,
    null,
    null,
    loader.id,
    null,
    { editsBypassed: ctx.editsBypassed },
  );
  const particle = outputs.get("particle") as ParticleData | undefined;
  if (!particle) return { ...DEFAULT_VIEWPORT_STATE };
  const cell = outputs.get("cell") as CellData | undefined;
  const bond = bondDataFromSnapshotBonds(particle);

  // Keep the user's projection choice; everything else is fixed for editing.
  const viewport = nodes.find((n) => n.type === "viewport" && n.data.enabled !== false);
  const perspective = (viewport?.data.params as ViewportParams | undefined)?.perspective ?? false;

  return {
    ...DEFAULT_VIEWPORT_STATE,
    particles: [particle],
    bonds: bond ? [bond] : [],
    cells: cell ? [cell] : [],
    perspective,
    cellAxesVisible: true,
    pivotMarkerVisible: true,
    representationMode: "atoms",
    representationByAtom: null,
  };
}

/** A structure with no atoms and a cubic cell of edge `edge` Å: the Build panel's blank sheet. */
export function emptyCellSnapshot(edge: number): import("../types").Snapshot {
  const a = Math.max(edge, 0.1);
  return {
    nAtoms: 0,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(0),
    elements: new Uint8Array(0),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: new Float32Array([a, 0, 0, 0, a, 0, 0, 0, a]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}
