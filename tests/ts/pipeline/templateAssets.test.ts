import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadTemplateVolumetric,
  loadTemplateStructureInto,
  loadTemplateData,
  type TemplateAssetStore,
  type TemplateDataLoader,
  type TemplateFixtureUrls,
} from "@/pipeline/templateAssets";
import { MemoryFrameProvider } from "@/pipeline/types";
import type { StructureParseResult } from "@/parsers/structure";
import type { Snapshot } from "@/types";

vi.mock("@/parsers/structure", () => ({
  parseStructureText: vi.fn(),
}));
vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
}));

const { parseStructureText } = await import("@/parsers/structure");
const parseStructureTextMock = vi.mocked(parseStructureText);
const { parseXTCFile } = await import("@/parsers/xtc");
const parseXTCFileMock = vi.mocked(parseXTCFile);

const CUBE_PATH = resolve(__dirname, "../../fixtures/caffeine_esp.cube");

function makeStore(nodes: { id: string; type?: string }[]): TemplateAssetStore & {
  setNodeSnapshot: ReturnType<typeof vi.fn>;
  setNodeStreamingData: ReturnType<typeof vi.fn>;
  updateNodeParams: ReturnType<typeof vi.fn>;
} {
  return {
    nodes,
    setNodeSnapshot: vi.fn(),
    setNodeStreamingData: vi.fn(),
    updateNodeParams: vi.fn(),
  };
}

/** A `fetch` stub answering 200 with `body` for every URL. */
function okFetch(body: string) {
  return vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => body,
        blob: async () => new Blob([body]),
      }) as unknown as Response,
  );
}

function makeSnapshot(nAtoms: number, box: Float32Array | null): Snapshot {
  return {
    nAtoms,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms),
    bondIndices: new Uint32Array(0),
    nBonds: 0,
    box,
  } as unknown as Snapshot;
}

function makeParseResult(
  nAtoms: number,
  { box = null, frames = 0 }: { box?: Float32Array | null; frames?: number } = {},
): StructureParseResult {
  return {
    snapshot: makeSnapshot(nAtoms, box),
    frames: Array.from({ length: frames }, (_, i) => ({
      frame: i,
      positions: new Float32Array(nAtoms * 3),
    })) as StructureParseResult["frames"],
    meta: frames > 0 ? ({ nFrames: frames, nAtoms, timestepPs: 1 } as never) : null,
    labels: ["ALA"],
    vectorChannels: [],
    scalarChannels: [],
    warnings: [],
  };
}

describe("loadTemplateVolumetric", () => {
  const cubeText = readFileSync(CUBE_PATH, "utf8");

  beforeEach(() => {
    vi.stubGlobal("fetch", okFetch(cubeText));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the fetched grid into the load_volumetric node's ephemeral param", async () => {
    const store = makeStore([{ id: "volumetric-1", type: "load_volumetric" }]);
    await loadTemplateVolumetric(() => store, "/caffeine_esp.cube", "caffeine_esp.cube");

    expect(fetch).toHaveBeenCalledWith("/caffeine_esp.cube");
    expect(store.updateNodeParams).toHaveBeenCalledTimes(1);
    const [nodeId, params] = store.updateNodeParams.mock.calls[0];
    expect(nodeId).toBe("volumetric-1");
    expect(params.fileName).toBe("caffeine_esp.cube");
    expect(params.parseError).toBeNull();
    const vol = params.volumetricData as { nx: number; data: Float32Array };
    expect(vol.nx).toBeGreaterThan(1);
    expect(vol.data.length).toBeGreaterThan(0);
  });

  it("addresses a load_volumetric node by id when one is given", async () => {
    const store = makeStore([
      { id: "volumetric-1", type: "load_volumetric" },
      { id: "volumetric-esp", type: "load_volumetric" },
    ]);
    await loadTemplateVolumetric(
      () => store,
      "/caffeine_esp.cube",
      "caffeine_esp.cube",
      "volumetric-esp",
    );

    expect(store.updateNodeParams).toHaveBeenCalledTimes(1);
    expect(store.updateNodeParams.mock.calls[0][0]).toBe("volumetric-esp");
  });

  it("is a no-op when the addressed node does not exist", async () => {
    const store = makeStore([{ id: "volumetric-1", type: "load_volumetric" }]);
    await loadTemplateVolumetric(() => store, "/caffeine_esp.cube", "caffeine_esp.cube", "gone");

    expect(fetch).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });

  it("is a no-op when the template has no load_volumetric node", async () => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    await loadTemplateVolumetric(() => store, "/caffeine_esp.cube", "caffeine_esp.cube");

    expect(fetch).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });

  it("drops the result when another template replaced the graph mid-fetch", async () => {
    const before = makeStore([{ id: "volumetric-1", type: "load_volumetric" }]);
    const after = makeStore([{ id: "loader-9", type: "load_structure" }]);
    let calls = 0;
    // First read finds the node; the read after the await sees the new graph.
    const getState = () => (calls++ === 0 ? before : after);

    await loadTemplateVolumetric(getState, "/caffeine_esp.cube", "caffeine_esp.cube");

    expect(before.updateNodeParams).not.toHaveBeenCalled();
    expect(after.updateNodeParams).not.toHaveBeenCalled();
  });

  it("propagates a parse failure instead of writing a broken grid", async () => {
    vi.stubGlobal("fetch", okFetch("not a cube file"));
    const store = makeStore([{ id: "volumetric-1", type: "load_volumetric" }]);

    await expect(
      loadTemplateVolumetric(() => store, "/broken.cube", "broken.cube"),
    ).rejects.toThrow();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });
});

describe("loadTemplateStructureInto", () => {
  beforeEach(() => {
    parseStructureTextMock.mockReset();
  });

  it("writes the snapshot and params of the loader addressed by id", async () => {
    parseStructureTextMock.mockResolvedValue(makeParseResult(76));
    const store = makeStore([
      { id: "loader-aa", type: "load_structure" },
      { id: "loader-cg", type: "load_structure" },
    ]);

    await loadTemplateStructureInto(() => store, "loader-cg", "PDB TEXT", "1ubq_cg.pdb");

    expect(parseStructureTextMock).toHaveBeenCalledWith("PDB TEXT", "1ubq_cg.pdb");
    // The second loader, not the first one `ds.local.loadText` would have hit.
    expect(store.setNodeSnapshot.mock.calls[0][0]).toBe("loader-cg");
    expect(store.setNodeSnapshot.mock.calls[0][1]).toMatchObject({
      frames: null,
      meta: null,
      labels: ["ALA"],
    });
    expect(store.updateNodeParams).toHaveBeenCalledWith("loader-cg", {
      fileName: "1ubq_cg.pdb",
      hasTrajectory: false,
      hasCell: false,
    });
  });

  it("reports a trajectory and a cell when the parsed file carries them", async () => {
    parseStructureTextMock.mockResolvedValue(
      makeParseResult(3, { box: new Float32Array(9), frames: 4 }),
    );
    const store = makeStore([{ id: "loader-cg", type: "load_structure" }]);

    await loadTemplateStructureInto(() => store, "loader-cg", "TEXT", "multi.pdb");

    expect(store.setNodeSnapshot.mock.calls[0][1].frames).toHaveLength(4);
    expect(store.updateNodeParams).toHaveBeenCalledWith("loader-cg", {
      fileName: "multi.pdb",
      hasTrajectory: true,
      hasCell: true,
    });
  });

  it("is a no-op — and never parses — when the node id is absent", async () => {
    const store = makeStore([{ id: "loader-aa", type: "load_structure" }]);

    await loadTemplateStructureInto(() => store, "loader-cg", "TEXT", "1ubq_cg.pdb");

    expect(parseStructureTextMock).not.toHaveBeenCalled();
    expect(store.setNodeSnapshot).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });

  it("drops the result when another template replaced the graph mid-parse", async () => {
    parseStructureTextMock.mockResolvedValue(makeParseResult(76));
    const before = makeStore([{ id: "loader-cg", type: "load_structure" }]);
    const after = makeStore([{ id: "loader-1", type: "load_structure" }]);
    let calls = 0;
    const getState = () => (calls++ === 0 ? before : after);

    await loadTemplateStructureInto(getState, "loader-cg", "TEXT", "1ubq_cg.pdb");

    expect(before.setNodeSnapshot).not.toHaveBeenCalled();
    expect(after.setNodeSnapshot).not.toHaveBeenCalled();
  });
});

describe("loadTemplateData", () => {
  const cubeText = readFileSync(CUBE_PATH, "utf8");

  const urls: TemplateFixtureUrls = {
    caffeineWaterPdb: "/caffeine_water.pdb",
    caffeineWaterXtc: "/caffeine_water_vibration.xtc",
    perovskiteXyz: "/perovskite_srtio3_3x3x3.xyz",
    glycineCif: "/glycine_csd.cif",
    auNanoparticleXyz: "/au_nanoparticle.xyz",
    proteasePdb: "/1hsg.pdb",
    caffeineB3lypSdf: "/caffeine_b3lyp.sdf",
    caffeineDensityCube: "/caffeine_b3lyp_density.cube",
    caffeineEspCube: "/caffeine_b3lyp_esp.cube",
    ubiquitinPdb: "/1ubq.pdb",
    ubiquitinCgPdb: "/1ubq_cg.pdb",
  };

  /** Every URL answers with its own path as the body, the cubes with a real grid. */
  function fixtureFetch() {
    return vi.fn(async (url: string) => {
      const body = url.endsWith(".cube") ? cubeText : `TEXT OF ${url}`;
      return {
        ok: true,
        status: 200,
        text: async () => body,
        blob: async () => new Blob([body]),
      } as unknown as Response;
    });
  }

  function makeLoader(nAtoms = 24) {
    return {
      loadText: vi.fn(async () => makeParseResult(nAtoms)),
      loadXtc: vi.fn(async () => undefined),
    } satisfies TemplateDataLoader;
  }

  beforeEach(() => {
    parseStructureTextMock.mockReset();
    parseStructureTextMock.mockResolvedValue(makeParseResult(76));
    parseXTCFileMock.mockReset();
    vi.stubGlobal("fetch", fixtureFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["solid", "/perovskite_srtio3_3x3x3.xyz", "perovskite_srtio3_3x3x3.xyz"],
    ["molecular_crystal", "/glycine_csd.cif", "glycine_csd.cif"],
    ["surface_mesh", "/au_nanoparticle.xyz", "au_nanoparticle.xyz"],
    ["protein", "/1hsg.pdb", "1hsg.pdb"],
  ])("loads the %s template's one structure through the host loader", async (id, url, name) => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    const loader = makeLoader();

    expect(await loadTemplateData(id, urls, () => store, loader)).toBe(true);

    expect(fetch).toHaveBeenCalledWith(url);
    expect(loader.loadText).toHaveBeenCalledWith(`TEXT OF ${url}`, name);
    expect(loader.loadXtc).not.toHaveBeenCalled();
    expect(store.setNodeSnapshot).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });

  it("loads Molecule's structure and then its trajectory as a named file", async () => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    const loader = makeLoader();

    expect(await loadTemplateData("molecule", urls, () => store, loader)).toBe(true);

    expect(loader.loadText).toHaveBeenCalledWith(
      "TEXT OF /caffeine_water.pdb",
      "caffeine_water.pdb",
    );
    expect(loader.loadXtc).toHaveBeenCalledTimes(1);
    const xtc = (loader.loadXtc.mock.calls[0] as unknown as [File])[0];
    expect(xtc).toBeInstanceOf(File);
    expect(xtc.name).toBe("caffeine_water_vibration.xtc");
    expect(xtc.size).toBe("TEXT OF /caffeine_water_vibration.xtc".length);
    // Structure first: a trajectory is checked against the loaded atom count.
    expect(loader.loadText.mock.invocationCallOrder[0]).toBeLessThan(
      loader.loadXtc.mock.invocationCallOrder[0],
    );
  });

  it("feeds Streaming's node a frame provider over the template's own structure", async () => {
    const store = makeStore([
      { id: "streaming-1", type: "streaming" },
      { id: "viewport-1", type: "viewport" },
    ]);
    const loader = makeLoader(24);
    const frames = [{ frameId: 1, nAtoms: 24, positions: new Float32Array(72) }];
    parseXTCFileMock.mockResolvedValue({
      frames,
      meta: { nFrames: 2, nAtoms: 24, timestepPs: 1 },
    } as never);

    expect(await loadTemplateData("streaming", urls, () => store, loader)).toBe(true);

    expect(loader.loadText).toHaveBeenCalledWith(
      "TEXT OF /caffeine_water.pdb",
      "caffeine_water.pdb",
    );
    // The frames go to the Streaming node, never through the host's trajectory path.
    expect(loader.loadXtc).not.toHaveBeenCalled();
    const [xtc, nAtoms] = parseXTCFileMock.mock.calls[0];
    expect(xtc.name).toBe("caffeine_water_vibration.xtc");
    expect(nAtoms).toBe(24);
    const [nodeId, data] = store.setNodeStreamingData.mock.calls[0];
    expect(nodeId).toBe("streaming-1");
    expect(data.snapshot.nAtoms).toBe(24);
    expect(data.streamProvider).toBeInstanceOf(MemoryFrameProvider);
    expect(data.streamProvider.meta.nFrames).toBe(2);
    expect(store.updateNodeParams).toHaveBeenCalledWith("streaming-1", { connected: true });
  });

  it("gives Streaming no provider when the trajectory has no metadata", async () => {
    const store = makeStore([{ id: "streaming-1", type: "streaming" }]);
    parseXTCFileMock.mockResolvedValue({ frames: [], meta: null } as never);

    await loadTemplateData("streaming", urls, () => store, makeLoader());

    expect(store.setNodeStreamingData.mock.calls[0][1].streamProvider).toBeNull();
  });

  it("writes nothing for Streaming once its node is gone", async () => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    parseXTCFileMock.mockResolvedValue({ frames: [], meta: null } as never);

    expect(await loadTemplateData("streaming", urls, () => store, makeLoader())).toBe(true);

    expect(store.setNodeStreamingData).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
  });

  it("loads caffeine through the host, the density and the potential into their own nodes", async () => {
    const store = makeStore([
      { id: "loader-1", type: "load_structure" },
      { id: "volumetric-1", type: "load_volumetric" },
      { id: "volumetric-esp", type: "load_volumetric" },
    ]);
    const loader = makeLoader();

    expect(await loadTemplateData("esp", urls, () => store, loader)).toBe(true);

    expect(loader.loadText).toHaveBeenCalledWith(
      "TEXT OF /caffeine_b3lyp.sdf",
      "caffeine_b3lyp.sdf",
    );
    expect(fetch).toHaveBeenCalledWith("/caffeine_b3lyp_density.cube");
    expect(fetch).toHaveBeenCalledWith("/caffeine_b3lyp_esp.cube");
    const writes = store.updateNodeParams.mock.calls.map(([id, params]) => [id, params.fileName]);
    expect(writes).toEqual([
      ["volumetric-1", "caffeine_b3lyp_density.cube"],
      ["volumetric-esp", "caffeine_b3lyp_esp.cube"],
    ]);
  });

  it("loads the all-atom structure through the host and the beads into loader-cg", async () => {
    const store = makeStore([
      { id: "loader-aa", type: "load_structure" },
      { id: "loader-cg", type: "load_structure" },
    ]);
    const loader = makeLoader();

    expect(await loadTemplateData("coarse_grained", urls, () => store, loader)).toBe(true);

    // The host fills the first loader; only the second needs addressing by id.
    expect(loader.loadText).toHaveBeenCalledWith("TEXT OF /1ubq.pdb", "1ubq.pdb");
    expect(parseStructureTextMock).toHaveBeenCalledWith("TEXT OF /1ubq_cg.pdb", "1ubq_cg.pdb");
    expect(store.setNodeSnapshot.mock.calls[0][0]).toBe("loader-cg");
  });

  it("reports an unknown template and touches nothing", async () => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    const loader = makeLoader();

    expect(await loadTemplateData("no_such_template", urls, () => store, loader)).toBe(false);

    expect(loader.loadText).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails on a missing fixture instead of parsing the error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    const loader = makeLoader();

    await expect(loadTemplateData("solid", urls, () => store, loader)).rejects.toThrow(
      "Failed to fetch /perovskite_srtio3_3x3x3.xyz: HTTP 404",
    );
    expect(loader.loadText).not.toHaveBeenCalled();
  });
});
