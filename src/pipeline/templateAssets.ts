/**
 * Loading a template's bundled demo files into the nodes it just created.
 *
 * A template describes a graph, not the data flowing through it: `create()`
 * writes fixture *names* into the loader nodes and the host supplies the bytes
 * when the template is applied. The webapp's usual route for that is
 * `ds.local.loadText`, but it only ever targets the first `load_structure`
 * node and knows nothing about `load_volumetric`. These two helpers cover the
 * rest — a grid for an Isosurface branch, and a second structure for a
 * template that overlays two of them.
 *
 * Both re-read the store after their await and bail if the target node is
 * gone: applying another template mid-load replaces the whole graph, and
 * writing into the old node's slot would leave the new one holding data from
 * the template the user just navigated away from.
 */

import { parseStructureText } from "../parsers/structure";
import { parseVolumetric } from "./executors/parseVolumetric";
import type { NodeSnapshotData } from "./execute";

/** The slice of the pipeline store these helpers read and write. */
export interface TemplateAssetStore {
  nodes: { id: string; type?: string }[];
  setNodeSnapshot: (nodeId: string, data: NodeSnapshotData) => void;
  updateNodeParams: (id: string, params: Record<string, unknown>) => void;
}

/**
 * Fetch `url` and hand the parsed grid to the template's `load_volumetric`
 * node.
 *
 * The grid lands in the node's ephemeral `volumetricData` param — the same
 * slot `LoadVolumetricNode` writes when a user drops a file on it — so the
 * Isosurface node downstream sees it exactly as if it had been opened by hand.
 */
export async function loadTemplateVolumetric(
  getState: () => TemplateAssetStore,
  url: string,
  fileName: string,
): Promise<void> {
  const nodeId = getState().nodes.find((n) => n.type === "load_volumetric")?.id;
  if (!nodeId) return;
  const text = await (await fetch(url)).text();
  const store = getState();
  if (!store.nodes.some((n) => n.id === nodeId)) return;
  store.updateNodeParams(nodeId, {
    fileName,
    volumetricData: parseVolumetric(fileName, text),
    parseError: null,
  });
}

/**
 * Parse `text` and load it into the `load_structure` node with id `nodeId`.
 *
 * Addressing the node by id is the point: `ds.local.loadText` always fills the
 * *first* loader, so a template overlaying two structures needs this to reach
 * the second. Writing the snapshot and the params separately mirrors what the
 * interactive load path (`useNodeLoadHandlers`) does for a non-primary loader.
 */
export async function loadTemplateStructureInto(
  getState: () => TemplateAssetStore,
  nodeId: string,
  text: string,
  fileName: string,
): Promise<void> {
  if (!getState().nodes.some((n) => n.id === nodeId)) return;
  const result = await parseStructureText(text, fileName);
  const store = getState();
  if (!store.nodes.some((n) => n.id === nodeId)) return;
  store.setNodeSnapshot(nodeId, {
    snapshot: result.snapshot,
    frames: result.frames.length > 0 ? result.frames : null,
    meta: result.meta,
    labels: result.labels,
  });
  store.updateNodeParams(nodeId, {
    fileName,
    hasTrajectory: result.frames.length > 0,
    hasCell: !!result.snapshot.box,
  });
}

/**
 * The bundled fixtures the multi-file templates need, as the host's bundler
 * resolves them: structures inline as text, the ESP grid as a URL (~150 kB of
 * text belongs in an emitted asset, not the entry bundle).
 */
export interface TemplateAssetSources {
  /** Raw text of `caffeine.sdf`. */
  caffeineSdf: string;
  /** URL of `caffeine_esp.cube`. */
  caffeineEspCubeUrl: string;
  /** Raw text of `1ubq.pdb`. */
  ubiquitinPdb: string;
  /** Raw text of `1ubq_cg.pdb`. */
  ubiquitinCgPdb: string;
}

/**
 * Load every file a template needs beyond the single structure most of them
 * take, and report whether `templateId` was one of those templates.
 *
 * `loadPrimary` is the host's normal structure-load entry (`ds.local.loadText`
 * in the webapp), which fills the graph's *first* `load_structure` node and
 * the global snapshot channels. Anything past that — a volumetric grid, a
 * second structure — is this function's job.
 */
export async function loadMultiFileTemplate(
  templateId: string,
  sources: TemplateAssetSources,
  getState: () => TemplateAssetStore,
  loadPrimary: (text: string, fileName: string) => Promise<unknown>,
): Promise<boolean> {
  if (templateId === "esp") {
    await loadPrimary(sources.caffeineSdf, "caffeine.sdf");
    await loadTemplateVolumetric(getState, sources.caffeineEspCubeUrl, "caffeine_esp.cube");
    return true;
  }
  if (templateId === "coarse_grained") {
    // `loadPrimary` fills the first load_structure node (the all-atom one);
    // the coarse-grained beads are a second, independent structure, so they go
    // straight into their own loader's snapshot slot.
    await loadPrimary(sources.ubiquitinPdb, "1ubq.pdb");
    await loadTemplateStructureInto(getState, "loader-cg", sources.ubiquitinCgPdb, "1ubq_cg.pdb");
    return true;
  }
  return false;
}
