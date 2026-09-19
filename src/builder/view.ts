/**
 * What the Builder's 3D view draws: the edited structure as ball-and-stick
 * with every atom, exactly the bonds the structure carries (file bonds,
 * parser-inferred bonds and the ones the user drew alike), and its cell. No
 * trajectory, no overlays, no representation choices — those are the
 * viewer's business.
 *
 * Expressed as a `ViewportState` so the renderer is driven through the same
 * `applyViewportState` the viewer uses; the Builder does not fork the renderer.
 */

import { bondDataFromSnapshotBonds } from "../pipeline/executors/addBond";
import { DEFAULT_VIEWPORT_STATE, type ParticleData, type ViewportState } from "../pipeline/types";
import type { Snapshot } from "../types";

/** Source id the Builder's single particle stream carries. */
export const BUILDER_SOURCE_ID = "builder";

export function builderViewportState(shown: Snapshot | null): ViewportState {
  if (!shown) return { ...DEFAULT_VIEWPORT_STATE };
  const particle: ParticleData = {
    type: "particle",
    source: shown,
    sourceNodeId: BUILDER_SOURCE_ID,
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
  const bond = bondDataFromSnapshotBonds(particle);
  const hasCell = !!shown.box && shown.box.some((v) => v !== 0);
  return {
    ...DEFAULT_VIEWPORT_STATE,
    particles: [particle],
    bonds: bond ? [bond] : [],
    cells: hasCell ? [{ type: "cell", sourceNodeId: BUILDER_SOURCE_ID, box: shown.box! }] : [],
    perspective: false,
    cellAxesVisible: true,
    pivotMarkerVisible: true,
    representationMode: "atoms",
    representationByAtom: null,
  };
}
