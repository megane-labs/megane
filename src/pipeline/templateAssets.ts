/**
 * Loading a template's bundled demo files into the nodes it just created.
 *
 * A template describes a graph, not the data flowing through it: `create()`
 * writes fixture *names* into the loader nodes and the host supplies the bytes
 * when the template is applied. `loadTemplateData` is that step for every
 * template, shared by every host that mounts the pipeline editor (through
 * `useTemplateData`), so applying one in the JupyterLab or VSCode viewer loads
 * the same scene the webapp does rather than leaving the file the user opened
 * on screen under a graph that names something else.
 *
 * The host's structure loader (`useMeganeLocal`'s `loadText` / `loadXtc`)
 * fills the graph's first `load_structure` node and the global snapshot
 * channels, exactly as opening a file does. It only ever targets that first
 * loader and knows nothing about `load_volumetric`, so two helpers cover the
 * rest — a grid for an Isosurface branch, and a second structure for a
 * template that overlays two of them.
 *
 * Both helpers re-read the store after their await and bail if the target
 * node is gone: applying another template mid-load replaces the whole graph,
 * and writing into the old node's slot would leave the new one holding data
 * from the template the user just navigated away from.
 */

import { parseStructureText, type StructureParseResult } from "../parsers/structure";
import { parseXTCFile } from "../parsers/xtc";
import { parseVolumetric } from "./executors/parseVolumetric";
import type { NodeStreamingData } from "./executors/streaming";
import type { NodeSnapshotData } from "./execute";
import { MemoryFrameProvider } from "./types";

/** The slice of the pipeline store these helpers read and write. */
export interface TemplateAssetStore {
  nodes: { id: string; type?: string }[];
  setNodeSnapshot: (nodeId: string, data: NodeSnapshotData) => void;
  setNodeStreamingData: (nodeId: string, data: NodeStreamingData) => void;
  updateNodeParams: (id: string, params: Record<string, unknown>) => void;
}

/**
 * The host's own structure and trajectory loader — `useMeganeLocal`'s, the
 * one its file opens go through — so a template's primary structure lands
 * wherever an opened file would and a trajectory loaded afterwards is checked
 * against the template's atom count, not the file the user had open before.
 */
export interface TemplateDataLoader {
  loadText: (text: string, fileName: string) => Promise<StructureParseResult>;
  loadXtc: (file: File) => Promise<void>;
}

async function fetchOk(url: string): Promise<Response> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  return resp;
}

async function fetchText(url: string): Promise<string> {
  return (await fetchOk(url)).text();
}

async function fetchFile(url: string, fileName: string): Promise<File> {
  return new File([await (await fetchOk(url)).blob()], fileName);
}

/**
 * Fetch `url` and hand the parsed grid to a `load_volumetric` node of the
 * template: the one with id `nodeId`, or the graph's first one when omitted.
 *
 * The grid lands in the node's ephemeral `volumetricData` param — the same
 * slot `LoadVolumetricNode` writes when a user drops a file on it — so the
 * Isosurface node downstream sees it exactly as if it had been opened by hand.
 * Addressing by id is what lets a template feed two grids, e.g. a density to
 * contour and a potential to color it by.
 */
export async function loadTemplateVolumetric(
  getState: () => TemplateAssetStore,
  url: string,
  fileName: string,
  nodeId?: string,
): Promise<void> {
  const targetId = nodeId ?? getState().nodes.find((n) => n.type === "load_volumetric")?.id;
  if (!targetId || !getState().nodes.some((n) => n.id === targetId)) return;
  const text = await fetchText(url);
  const store = getState();
  if (!store.nodes.some((n) => n.id === targetId)) return;
  store.updateNodeParams(targetId, {
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
 * Every fixture a template loads, as URLs the host's bundler emits
 * (`templateFixtures.ts`). Fetched on demand rather than inlined: together
 * they are ~3 MB, which no host should pay for before a template is applied.
 */
export interface TemplateFixtureUrls {
  /** `caffeine_water.pdb`, the Molecule and Streaming templates' structure. */
  caffeineWaterPdb: string;
  /** `caffeine_water_vibration.xtc`, its trajectory. */
  caffeineWaterXtc: string;
  /** `perovskite_srtio3_3x3x3.xyz` (Solid). */
  perovskiteXyz: string;
  /** `glycine_csd.cif` (Molecular Crystal). */
  glycineCif: string;
  /** `au_nanoparticle.xyz` (Surface Mesh). */
  auNanoparticleXyz: string;
  /** `1hsg.pdb` (Protein). */
  proteasePdb: string;
  /** `caffeine_b3lyp.sdf`, the frame the two ESP Map grids share. */
  caffeineB3lypSdf: string;
  /** `caffeine_b3lyp_density.cube`. */
  caffeineDensityCube: string;
  /** `caffeine_b3lyp_esp.cube`. */
  caffeineEspCube: string;
  /** `1ubq.pdb` (Coarse-Grained Overlay, all-atom). */
  ubiquitinPdb: string;
  /** `1ubq_cg.pdb` (Coarse-Grained Overlay, beads). */
  ubiquitinCgPdb: string;
}

/** Templates whose only data is one structure, by fixture key and file name. */
const SINGLE_STRUCTURE_TEMPLATES: Record<string, [keyof TemplateFixtureUrls, string]> = {
  solid: ["perovskiteXyz", "perovskite_srtio3_3x3x3.xyz"],
  molecular_crystal: ["glycineCif", "glycine_csd.cif"],
  surface_mesh: ["auNanoparticleXyz", "au_nanoparticle.xyz"],
  protein: ["proteasePdb", "1hsg.pdb"],
};

/**
 * Load every file the template `templateId` needs into the graph `applyTemplate`
 * just installed, and report whether `templateId` names a template with data.
 *
 * `loader` fills the graph's *first* `load_structure` node (and a trajectory
 * into its `load_trajectory`); anything past that — a volumetric grid, a
 * second structure, the Streaming node's frame provider — is written here.
 */
export async function loadTemplateData(
  templateId: string,
  urls: TemplateFixtureUrls,
  getState: () => TemplateAssetStore,
  loader: TemplateDataLoader,
): Promise<boolean> {
  const single = SINGLE_STRUCTURE_TEMPLATES[templateId];
  if (single) {
    const [key, fileName] = single;
    await loader.loadText(await fetchText(urls[key]), fileName);
    return true;
  }
  if (templateId === "molecule") {
    await loader.loadText(await fetchText(urls.caffeineWaterPdb), "caffeine_water.pdb");
    await loader.loadXtc(await fetchFile(urls.caffeineWaterXtc, "caffeine_water_vibration.xtc"));
    return true;
  }
  if (templateId === "streaming") {
    // The structure goes through the host loader so the global snapshot (the
    // Viewport's base) is caffeine; the frames feed the Streaming node's
    // provider, standing in for a live WebSocket.
    const result = await loader.loadText(
      await fetchText(urls.caffeineWaterPdb),
      "caffeine_water.pdb",
    );
    const xtcFile = await fetchFile(urls.caffeineWaterXtc, "caffeine_water_vibration.xtc");
    const { frames, meta } = await parseXTCFile(xtcFile, result.snapshot.nAtoms);
    const store = getState();
    const streamNode = store.nodes.find((n) => n.type === "streaming");
    if (streamNode) {
      const provider = meta
        ? new MemoryFrameProvider(frames, meta, result.snapshot.positions)
        : null;
      store.setNodeStreamingData(streamNode.id, {
        snapshot: result.snapshot,
        streamProvider: provider,
      });
      store.updateNodeParams(streamNode.id, { connected: true });
    }
    return true;
  }
  if (templateId === "esp") {
    // The density is contoured; the potential only colors the contour, so it
    // goes into the second loader, the one wired to `colorVolumetric`.
    await loader.loadText(await fetchText(urls.caffeineB3lypSdf), "caffeine_b3lyp.sdf");
    await loadTemplateVolumetric(
      getState,
      urls.caffeineDensityCube,
      "caffeine_b3lyp_density.cube",
      "volumetric-1",
    );
    await loadTemplateVolumetric(
      getState,
      urls.caffeineEspCube,
      "caffeine_b3lyp_esp.cube",
      "volumetric-esp",
    );
    return true;
  }
  if (templateId === "coarse_grained") {
    // The loader fills the first load_structure node (the all-atom one); the
    // coarse-grained beads are a second, independent structure, so they go
    // straight into their own loader's snapshot slot.
    await loader.loadText(await fetchText(urls.ubiquitinPdb), "1ubq.pdb");
    await loadTemplateStructureInto(
      getState,
      "loader-cg",
      await fetchText(urls.ubiquitinCgPdb),
      "1ubq_cg.pdb",
    );
    return true;
  }
  return false;
}
