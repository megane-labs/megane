/**
 * Default pipeline configuration.
 */

import { edges, exactNode, node, type PipelineGraph } from "./graphFactory";

/**
 * LoadStructure → Symmetry → Wrap → Replicate → AddBond → Viewport
 *              → LoadTrajectory → Symmetry → Wrap → Replicate → Viewport
 * with the given file names, shared by the default and minimal pipelines.
 */
function structureWithTrajectory(
  structureFile: string,
  trajectoryFile: string,
  hasCell: boolean,
): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: structureFile, hasCell }),
      exactNode("traj-1", { type: "load_trajectory", fileName: trajectoryFile }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("replicate-1", "replicate"),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["loader-1", "replicate-1", "cell"],
      ["loader-1", "traj-1", "particle"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "replicate-1", "particle"],
      ["replicate-1", "addbond-1", "particle"],
      ["replicate-1", "viewport-1", "particle"],
      ["replicate-1", "viewport-1", "cell"],
      ["addbond-1", "viewport-1", "bond"],
      ["traj-1", "symmetry-1", "trajectory"],
      ["symmetry-1", "wrap-1", "trajectory"],
      ["wrap-1", "replicate-1", "trajectory"],
      ["replicate-1", "viewport-1", "trajectory"],
    ),
  };
}

/**
 * Create the default pipeline: caffeine with bonds and trajectory.
 * LoadStructure → Symmetry → Wrap → Replicate → AddBond → Viewport
 *              → LoadTrajectory → Symmetry → Wrap → Replicate → Viewport
 * The Symmetry node defaults to mode "expand" (a no-op for structures without
 * space-group operations) so a loaded CIF fills its unit cell; the Wrap node
 * defaults to mode "none" (pass-through) so wrap/unwrap is a one-click toggle
 * without changing what renders by default.
 */
export function createDefaultPipeline(): PipelineGraph {
  return structureWithTrajectory("caffeine_water.pdb", "caffeine_water_vibration.xtc", true);
}

/**
 * Create a minimal pipeline for hosting an externally-loaded structure file.
 *
 * The shape mirrors `createDefaultPipeline` (LoadStructure → Symmetry → Wrap
 * → Replicate → AddBond → Viewport with a LoadTrajectory branch), but every
 * `fileName` is left empty so that
 * `usePipelineStore.openFile` (or another caller) can populate it from the
 * actually-clicked file. Used as the seed graph by `openFile` whenever the
 * current pipeline has no `load_structure` node or `mode: "replace"` is
 * requested.
 */
export function createMinimalStructurePipeline(): PipelineGraph {
  return structureWithTrajectory("", "", false);
}

/**
 * Create a basic pipeline with LoadStructure → Symmetry → Wrap → Replicate →
 * AddBond → Viewport.
 * Used as the default in the VSCode extension where files are loaded externally.
 * The LoadStructure node reads from the pipeline store's snapshot (set by the
 * webview after parsing), so the molecule renders with bonds automatically.
 * The Symmetry node defaults to mode "expand" (a no-op for structures without
 * space-group operations) so a loaded CIF fills its unit cell; the Wrap node
 * defaults to mode "none" (pass-through) so wrap/unwrap is a one-click toggle
 * without changing what renders by default.
 */
export function createEmptyPipeline(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "" }),
      node("symmetry-1", "symmetry"),
      node("wrap-1", "wrap"),
      node("replicate-1", "replicate"),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "symmetry-1", "particle"],
      ["loader-1", "replicate-1", "cell"],
      ["symmetry-1", "wrap-1", "particle"],
      ["wrap-1", "replicate-1", "particle"],
      ["replicate-1", "addbond-1", "particle"],
      ["addbond-1", "viewport-1", "bond"],
      ["replicate-1", "viewport-1", "particle"],
      ["replicate-1", "viewport-1", "cell"],
      ["loader-1", "symmetry-1", "trajectory"],
      ["symmetry-1", "wrap-1", "trajectory"],
      ["wrap-1", "replicate-1", "trajectory"],
      ["replicate-1", "viewport-1", "trajectory"],
    ),
  };
}

/**
 * Create a demo pipeline showcasing filter and modify nodes.
 */
export function createDemoPipeline(): PipelineGraph {
  return {
    nodes: [
      node("loader-1", "load_structure", { fileName: "protein.pdb" }),
      node("addbond-1", "add_bond", { bondSource: "structure" }),
      exactNode("filter-1", { type: "filter", query: 'element == "C"' }),
      node("modify-1", "modify", { scale: 1.5, opacity: 0.8 }),
      exactNode("filter-2", { type: "filter", query: 'element == "N"' }),
      node("modify-2", "modify", { scale: 0.5, opacity: 0.6 }),
      node("viewport-1", "viewport"),
    ],
    edges: edges(
      ["loader-1", "filter-1", "particle", "in"],
      ["filter-1", "modify-1", "out", "in"],
      ["loader-1", "filter-2", "particle", "in"],
      ["filter-2", "modify-2", "out", "in"],
      ["modify-1", "viewport-1", "out", "particle"],
      ["modify-2", "viewport-1", "out", "particle"],
      ["loader-1", "addbond-1", "particle"],
      ["addbond-1", "viewport-1", "bond"],
    ),
  };
}
