/**
 * `.megane.json` companions beyond Load Structure / Load Trajectory: the
 * topology of an Add Bond node, a Load Volumetric grid, a Load Spectrum file
 * and a Load Vector file. A saved pipeline only names these files, so before
 * `openPipeline` attached them they were fetched by no host and silently lost.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: vi.fn(),
  parseTopBonds: vi.fn(),
  parsePsfBonds: vi.fn(),
}));
vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
  parseLammpstrjFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
}));
vi.mock("@/parsers/spectrum", () => ({ parseSpectrum: vi.fn() }));
vi.mock("@/pipeline/executors/parseVolumetric", () => ({ parseVolumetric: vi.fn() }));
vi.mock("@/logic/vectorSourceLogic", () => ({ loadVectorFileData: vi.fn() }));

import { parseStructureFile, parseTopBonds, parsePsfBonds } from "@/parsers/structure";
import { parseSpectrum } from "@/parsers/spectrum";
import { parseVolumetric } from "@/pipeline/executors/parseVolumetric";
import { loadVectorFileData } from "@/logic/vectorSourceLogic";
import { usePipelineStore } from "@/pipeline/store";
import type { Snapshot } from "@/types";

const mockParseStructureFile = vi.mocked(parseStructureFile);
const mockParseTopBonds = vi.mocked(parseTopBonds);
const mockParsePsfBonds = vi.mocked(parsePsfBonds);
const mockParseSpectrum = vi.mocked(parseSpectrum);
const mockParseVolumetric = vi.mocked(parseVolumetric);
const mockLoadVectorFileData = vi.mocked(loadVectorFileData);

function makeSnapshot(nAtoms = 3): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms),
    bonds: new Uint32Array(0),
    bondOrders: new Uint8Array(0),
    box: null,
  };
}

const at = { x: 0, y: 0 };

function pipelineFile(nodes: Array<Record<string, unknown>>, edges: unknown[] = []): File {
  return new File(
    [
      JSON.stringify({
        version: 3,
        nodes: nodes.map((n) => ({ position: at, enabled: true, ...n })),
        edges,
      }),
    ],
    "deck.megane.json",
  );
}

const structureNode = {
  id: "load-1",
  type: "load_structure",
  fileName: "conf.gro",
  hasTrajectory: false,
  hasCell: false,
};
const bondNode = { id: "bond-1", type: "add_bond", bondSource: "file", bondFileName: "topol.top" };
const viewportNode = {
  id: "viewport-1",
  type: "viewport",
  perspective: false,
  cellAxesVisible: true,
  pivotMarkerVisible: true,
};
const structureEdges = [
  { source: "load-1", target: "bond-1", sourceHandle: "particle", targetHandle: "particle" },
  { source: "load-1", target: "viewport-1", sourceHandle: "particle", targetHandle: "particle" },
  { source: "bond-1", target: "viewport-1", sourceHandle: "bond", targetHandle: "bond" },
];

function params(id: string): Record<string, unknown> {
  const node = usePipelineStore.getState().nodes.find((n) => n.id === id);
  expect(node).toBeDefined();
  return node!.data.params as unknown as Record<string, unknown>;
}

function structureResult() {
  return { snapshot: makeSnapshot(3), frames: [], meta: null, labels: null, vectorChannels: [] };
}

beforeEach(() => {
  usePipelineStore.getState().reset();
  vi.mocked(parseStructureFile).mockReset();
  mockParseTopBonds.mockReset();
  mockParsePsfBonds.mockReset();
  mockParseSpectrum.mockReset();
  mockParseVolumetric.mockReset();
  mockLoadVectorFileData.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("openFile(.megane.json) — Add Bond topology companion", () => {
  it("parses a .top companion into the add_bond node's bond list, keeping its bondSource", async () => {
    mockParseStructureFile.mockResolvedValueOnce(structureResult());
    const bonds = new Uint32Array([0, 1, 1, 2]);
    mockParseTopBonds.mockResolvedValueOnce(bonds);
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([structureNode, bondNode, viewportNode], structureEdges), {
        companions: [new File(["gro"], "conf.gro"), new File(["[ bonds ]"], "topol.top")],
      });
    expect(mockParseTopBonds).toHaveBeenCalledWith("[ bonds ]", 0xffffffff);
    expect(params("bond-1")).toMatchObject({
      bondSource: "file",
      bondFileName: "topol.top",
      bondFileData: bonds,
    });
  });

  it("routes a .psf companion through the PSF parser", async () => {
    const bonds = new Uint32Array([0, 2]);
    mockParsePsfBonds.mockResolvedValueOnce(bonds);
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ ...bondNode, bondSource: "distance", bondFileName: "sys.psf" }]), {
        companions: [new File(["PSF"], "sys.psf")],
      });
    expect(mockParsePsfBonds).toHaveBeenCalledWith("PSF", 0xffffffff);
    expect(params("bond-1")).toMatchObject({ bondSource: "distance", bondFileData: bonds });
  });

  it("ignores a companion that is not a topology", async () => {
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ ...bondNode, bondFileName: "notes.txt" }]), {
        companions: [new File(["x"], "notes.txt")],
      });
    expect(mockParseTopBonds).not.toHaveBeenCalled();
    expect(mockParsePsfBonds).not.toHaveBeenCalled();
    expect(params("bond-1").bondFileData).toBeUndefined();
  });

  it("logs and carries on when the topology fails to parse", async () => {
    mockParseTopBonds.mockRejectedValueOnce(new Error("bad top"));
    await expect(
      usePipelineStore.getState().openFile(pipelineFile([bondNode]), {
        companions: [new File(["?"], "topol.top")],
      }),
    ).resolves.toBeUndefined();
    expect(params("bond-1").bondFileData).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("openFile(.megane.json) — Load Volumetric companion", () => {
  it("parses the grid into the node's volumetricData, matched by basename", async () => {
    const grid = { nx: 1 } as unknown as ReturnType<typeof parseVolumetric>;
    mockParseVolumetric.mockReturnValueOnce(grid);
    await usePipelineStore
      .getState()
      .openFile(
        pipelineFile([{ id: "vol-1", type: "load_volumetric", fileName: "grids/density.cube" }]),
        { companions: [new File(["cube text"], "density.cube")] },
      );
    expect(mockParseVolumetric).toHaveBeenCalledWith("density.cube", "cube text");
    expect(params("vol-1")).toMatchObject({
      fileName: "density.cube",
      volumetricData: grid,
      parseError: null,
    });
  });

  it("reports a parse failure on the node instead of rejecting", async () => {
    mockParseVolumetric.mockImplementationOnce(() => {
      throw new Error("not a cube");
    });
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ id: "vol-1", type: "load_volumetric", fileName: "x.dx" }]), {
        companions: [new File(["#"], "x.dx")],
      });
    expect(params("vol-1")).toMatchObject({ volumetricData: null, parseError: "not a cube" });
  });

  it("stringifies a non-Error throw", async () => {
    mockParseVolumetric.mockImplementationOnce(() => {
      throw "boom";
    });
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ id: "vol-1", type: "load_volumetric", fileName: "x.cube" }]), {
        companions: [new File(["#"], "x.cube")],
      });
    expect(params("vol-1").parseError).toBe("boom");
  });
});

describe("openFile(.megane.json) — Load Spectrum companion", () => {
  it("decodes the spectrum into the node's spectrumData", async () => {
    const spectrum = { x: new Float64Array(1) } as unknown as Awaited<
      ReturnType<typeof parseSpectrum>
    >;
    mockParseSpectrum.mockResolvedValueOnce(spectrum);
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ id: "sp-1", type: "load_spectrum", fileName: "ir.jdx" }]), {
        companions: [new File(["##TITLE=ir"], "ir.jdx")],
      });
    expect(mockParseSpectrum).toHaveBeenCalledWith("##TITLE=ir");
    expect(params("sp-1")).toMatchObject({
      fileName: "ir.jdx",
      spectrumData: spectrum,
      parseError: null,
    });
  });

  it("reports a decode failure on the node", async () => {
    mockParseSpectrum.mockRejectedValueOnce(new Error("not JCAMP-DX"));
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ id: "sp-1", type: "load_spectrum", fileName: "grid.dx" }]), {
        companions: [new File(["object 1"], "grid.dx")],
      });
    expect(params("sp-1")).toMatchObject({ spectrumData: null, parseError: "not JCAMP-DX" });
  });

  it("stringifies a non-Error rejection", async () => {
    mockParseSpectrum.mockRejectedValueOnce("nope");
    await usePipelineStore
      .getState()
      .openFile(pipelineFile([{ id: "sp-1", type: "load_spectrum", fileName: "a.jdx" }]), {
        companions: [new File(["?"], "a.jdx")],
      });
    expect(params("sp-1").parseError).toBe("nope");
  });
});

describe("openFile(.megane.json) — Load Vector companion", () => {
  const vecNode = { id: "vec-1", type: "load_vector", fileName: "forces.vec" };

  it("loads the vectors for the first structure's atom count into fileVectors", async () => {
    mockParseStructureFile.mockResolvedValueOnce(structureResult());
    const vectors = [{ frame: 0, vectors: new Float32Array(9) }];
    mockLoadVectorFileData.mockResolvedValueOnce({ vectors, fileName: "forces.vec" });
    await usePipelineStore.getState().openFile(pipelineFile([structureNode, vecNode]), {
      companions: [new File(["gro"], "conf.gro"), new File(["{}"], "forces.vec")],
    });
    expect(mockLoadVectorFileData).toHaveBeenCalledTimes(1);
    expect(mockLoadVectorFileData.mock.calls[0][1]).toBe(3);
    expect(usePipelineStore.getState().fileVectors).toBe(vectors);
    expect(params("vec-1").fileName).toBe("forces.vec");
  });

  it("needs a structure for the atom count", async () => {
    await usePipelineStore.getState().openFile(pipelineFile([vecNode]), {
      companions: [new File(["{}"], "forces.vec")],
    });
    expect(mockLoadVectorFileData).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().fileVectors).toBeNull();
  });

  it("attaches only the first vector file (single global channel)", async () => {
    mockParseStructureFile.mockResolvedValueOnce(structureResult());
    mockLoadVectorFileData.mockResolvedValueOnce({ vectors: [], fileName: "forces.vec" });
    await usePipelineStore
      .getState()
      .openFile(
        pipelineFile([
          structureNode,
          vecNode,
          { id: "vec-2", type: "load_vector", fileName: "other.vec" },
        ]),
        {
          companions: [
            new File(["gro"], "conf.gro"),
            new File(["{}"], "forces.vec"),
            new File(["{}"], "other.vec"),
          ],
        },
      );
    expect(mockLoadVectorFileData).toHaveBeenCalledTimes(1);
  });

  it("logs and carries on when the vector file is malformed", async () => {
    mockParseStructureFile.mockResolvedValueOnce(structureResult());
    mockLoadVectorFileData.mockRejectedValueOnce(new SyntaxError("bad json"));
    await usePipelineStore.getState().openFile(pipelineFile([structureNode, vecNode]), {
      companions: [new File(["gro"], "conf.gro"), new File(["{"], "forces.vec")],
    });
    expect(usePipelineStore.getState().fileVectors).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("openFile(.megane.json) — companion matching", () => {
  it("leaves a node alone when its companion was not supplied", async () => {
    await usePipelineStore.getState().openFile(
      pipelineFile([
        { id: "vol-1", type: "load_volumetric", fileName: "density.cube" },
        { id: "sp-1", type: "load_spectrum", fileName: null },
      ]),
      { companions: [new File(["x"], "unrelated.cube")] },
    );
    expect(mockParseVolumetric).not.toHaveBeenCalled();
    expect(mockParseSpectrum).not.toHaveBeenCalled();
  });
});
