import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadTemplateVolumetric,
  loadTemplateStructureInto,
  loadMultiFileTemplate,
  type TemplateAssetStore,
  type TemplateAssetSources,
} from "@/pipeline/templateAssets";
import type { StructureParseResult } from "@/parsers/structure";
import type { Snapshot } from "@/types";

vi.mock("@/parsers/structure", () => ({
  parseStructureText: vi.fn(),
}));

const { parseStructureText } = await import("@/parsers/structure");
const parseStructureTextMock = vi.mocked(parseStructureText);

const CUBE_PATH = resolve(__dirname, "../../fixtures/caffeine_esp.cube");

function makeStore(nodes: { id: string; type?: string }[]): TemplateAssetStore & {
  setNodeSnapshot: ReturnType<typeof vi.fn>;
  updateNodeParams: ReturnType<typeof vi.fn>;
} {
  return {
    nodes,
    setNodeSnapshot: vi.fn(),
    updateNodeParams: vi.fn(),
  };
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => cubeText }) as unknown as Response),
    );
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => "not a cube file" }) as unknown as Response),
    );
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

describe("loadMultiFileTemplate", () => {
  const cubeText = readFileSync(CUBE_PATH, "utf8");

  const sources: TemplateAssetSources = {
    caffeineSdf: "SDF TEXT",
    caffeineEspCubeUrl: "/caffeine_esp.cube",
    ubiquitinPdb: "AA PDB TEXT",
    ubiquitinCgPdb: "CG PDB TEXT",
  };

  beforeEach(() => {
    parseStructureTextMock.mockReset();
    parseStructureTextMock.mockResolvedValue(makeParseResult(76));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => cubeText }) as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads caffeine through the host and the ESP grid into the volumetric node", async () => {
    const store = makeStore([
      { id: "loader-1", type: "load_structure" },
      { id: "volumetric-1", type: "load_volumetric" },
    ]);
    const loadPrimary = vi.fn(async () => undefined);

    const handled = await loadMultiFileTemplate("esp", sources, () => store, loadPrimary);

    expect(handled).toBe(true);
    expect(loadPrimary).toHaveBeenCalledWith("SDF TEXT", "caffeine.sdf");
    expect(store.updateNodeParams.mock.calls[0][0]).toBe("volumetric-1");
    expect(store.updateNodeParams.mock.calls[0][1].fileName).toBe("caffeine_esp.cube");
  });

  it("loads the all-atom structure through the host and the beads into loader-cg", async () => {
    const store = makeStore([
      { id: "loader-aa", type: "load_structure" },
      { id: "loader-cg", type: "load_structure" },
    ]);
    const loadPrimary = vi.fn(async () => undefined);

    const handled = await loadMultiFileTemplate(
      "coarse_grained",
      sources,
      () => store,
      loadPrimary,
    );

    expect(handled).toBe(true);
    // The host fills the first loader; only the second needs addressing by id.
    expect(loadPrimary).toHaveBeenCalledWith("AA PDB TEXT", "1ubq.pdb");
    expect(parseStructureTextMock).toHaveBeenCalledWith("CG PDB TEXT", "1ubq_cg.pdb");
    expect(store.setNodeSnapshot.mock.calls[0][0]).toBe("loader-cg");
  });

  it("ignores a single-file template and touches nothing", async () => {
    const store = makeStore([{ id: "loader-1", type: "load_structure" }]);
    const loadPrimary = vi.fn(async () => undefined);

    const handled = await loadMultiFileTemplate("molecule", sources, () => store, loadPrimary);

    expect(handled).toBe(false);
    expect(loadPrimary).not.toHaveBeenCalled();
    expect(store.setNodeSnapshot).not.toHaveBeenCalled();
    expect(store.updateNodeParams).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
