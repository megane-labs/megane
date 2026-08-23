import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the WASM-backed parsers so this test exercises only the orchestration
// logic (file classification, graph install, store updates). The actual
// parsing is covered by Rust tests and E2E specs.
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

import { parseStructureFile, parseTopBonds, parsePsfBonds } from "@/parsers/structure";
import { applyTopologyFile } from "@/pipeline/openFile";
import { parseXTCFile, parseLammpstrjFile, parseDCDFile, parseNetCDFFile } from "@/parsers/xtc";
import { usePipelineStore } from "@/pipeline/store";
import type { Snapshot, Frame, TrajectoryMeta } from "@/types";

const mockParseStructureFile = vi.mocked(parseStructureFile);
const mockParseTopBonds = vi.mocked(parseTopBonds);
const mockParsePsfBonds = vi.mocked(parsePsfBonds);
const mockParseXTCFile = vi.mocked(parseXTCFile);
const mockParseLammpstrjFile = vi.mocked(parseLammpstrjFile);
const mockParseDCDFile = vi.mocked(parseDCDFile);
const mockParseNetCDFFile = vi.mocked(parseNetCDFFile);

function makeSnapshot(nAtoms = 3, withBox = false): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms),
    bonds: new Uint32Array(0),
    bondOrders: new Uint8Array(0),
    box: withBox ? new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]) : null,
  };
}

function makeFrame(frameId: number, nAtoms = 3): Frame {
  return {
    frameId,
    nAtoms,
    positions: new Float32Array(nAtoms * 3),
  };
}

function makeMeta(nFrames: number, nAtoms = 3): TrajectoryMeta {
  return { nFrames, timestepPs: 1, nAtoms };
}

beforeEach(() => {
  // Reset store to a clean state for each test. `reset()` reinstalls the
  // host-default pipeline; we then explicitly start each test from a known
  // graph by either calling `reset()` or installing a fresh minimal one via
  // `openFile`.
  usePipelineStore.getState().reset();
  mockParseStructureFile.mockReset();
  mockParseTopBonds.mockReset();
  mockParsePsfBonds.mockReset();
  mockParseXTCFile.mockReset();
  mockParseLammpstrjFile.mockReset();
  mockParseDCDFile.mockReset();
  mockParseNetCDFFile.mockReset();
});

describe("usePipelineStore.openFile — single structure file", () => {
  it("populates the load_structure node fileName and snapshot for .pdb", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(5, true),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });

    const file = new File(["<pdb>"], "water_wrapped.pdb");
    await usePipelineStore.getState().openFile(file, { mode: "replace" });

    const state = usePipelineStore.getState();
    const loader = state.nodes.find((n) => n.type === "load_structure");
    expect(loader).toBeDefined();
    expect((loader!.data.params as { fileName: string }).fileName).toBe("water_wrapped.pdb");
    expect((loader!.data.params as { hasCell: boolean }).hasCell).toBe(true);
    expect((loader!.data.params as { hasTrajectory: boolean }).hasTrajectory).toBe(false);
    expect(state.nodeSnapshots[loader!.id]?.snapshot.nAtoms).toBe(5);
  });

  it.each(["POSCAR", "CONTCAR_relaxed", "XDATCAR", "MgO.vasp"])(
    "classifies the VASP file %s as a structure open",
    async (filename) => {
      mockParseStructureFile.mockResolvedValueOnce({
        snapshot: makeSnapshot(8, true),
        frames: [],
        meta: null,
        labels: null,
        vectorChannels: [],
      });

      const file = new File(["POSCAR"], filename);
      await usePipelineStore.getState().openFile(file, { mode: "replace" });

      const state = usePipelineStore.getState();
      const loader = state.nodes.find((n) => n.type === "load_structure");
      expect(loader).toBeDefined();
      expect((loader!.data.params as { fileName: string }).fileName).toBe(filename);
      expect(state.nodeSnapshots[loader!.id]?.snapshot.nAtoms).toBe(8);
    },
  );

  it("switches the load_trajectory node to its structure source for multi-frame .traj", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(8),
      frames: [makeFrame(1), makeFrame(2), makeFrame(3)],
      meta: makeMeta(4),
      labels: null,
      vectorChannels: [],
    });

    const file = new File([new Uint8Array([0, 1, 2])], "bond_change.traj");
    await usePipelineStore.getState().openFile(file, { mode: "replace" });

    const state = usePipelineStore.getState();
    const loader = state.nodes.find((n) => n.type === "load_structure")!;
    expect((loader.data.params as { fileName: string }).fileName).toBe("bond_change.traj");
    expect((loader.data.params as { hasTrajectory: boolean }).hasTrajectory).toBe(true);
    expect(state.nodeSnapshots[loader.id]?.frames?.length).toBe(3);
    // Multi-frame structure files carry their trajectory in the structure
    // file itself. The seed LoadTrajectory node is kept — the routing
    // decision stays visible on the node — and flipped to forward the
    // structure file's own frames.
    const traj = state.nodes.find((n) => n.type === "load_trajectory")!;
    expect(traj).toBeDefined();
    expect((traj.data.params as { source?: string }).source).toBe("structure");
    expect((traj.data.params as { fileName: string | null }).fileName).toBe("");
    expect(state.fileFrames).toBeNull();
  });

  it("resets the load_trajectory node to its file source for a single-frame structure", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(8),
      frames: [makeFrame(1)],
      meta: makeMeta(2),
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore
      .getState()
      .openFile(new File([new Uint8Array([0])], "a.traj"), { mode: "replace" });
    expect(
      (
        usePipelineStore.getState().nodes.find((n) => n.type === "load_trajectory")!.data
          .params as {
          source?: string;
        }
      ).source,
    ).toBe("structure");

    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(8),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore
      .getState()
      .openFile(new File(["ATOM"], "single.pdb"), { mode: "replace" });
    expect(
      (
        usePipelineStore.getState().nodes.find((n) => n.type === "load_trajectory")!.data
          .params as {
          source?: string;
        }
      ).source,
    ).toBe("file");
  });

  it.each([["dump.lammpstrj"], ["run.dump"], ["md.trj"]])(
    "opens a LAMMPS dump (%s) standalone as a multi-frame structure",
    async (filename) => {
      // A LAMMPS dump classifies as a structure (structure-first), so opening it
      // alone derives the topology from frame 0 and streams the rest — like a
      // multi-frame .traj — instead of requiring a pre-loaded topology.
      mockParseStructureFile.mockResolvedValueOnce({
        snapshot: makeSnapshot(3),
        frames: [makeFrame(1), makeFrame(2)],
        meta: makeMeta(3),
        labels: null,
        vectorChannels: [],
      });

      const file = new File(["<dump>"], filename);
      await usePipelineStore.getState().openFile(file, { mode: "replace" });

      const state = usePipelineStore.getState();
      const loader = state.nodes.find((n) => n.type === "load_structure")!;
      expect((loader.data.params as { fileName: string }).fileName).toBe(filename);
      expect((loader.data.params as { hasTrajectory: boolean }).hasTrajectory).toBe(true);
      expect(state.nodeSnapshots[loader.id]?.frames?.length).toBe(2);
      // Routed through the structure parser, NOT the trajectory-attach parser.
      expect(mockParseStructureFile).toHaveBeenCalled();
      expect(mockParseLammpstrjFile).not.toHaveBeenCalled();
    },
  );

  it("uses an existing load_structure node in merge mode without replacing the graph", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });

    const before = usePipelineStore.getState();
    const beforeNodeIds = before.nodes.map((n) => n.id).sort();

    const file = new File(["<gro>"], "water.gro");
    await usePipelineStore.getState().openFile(file, { mode: "merge" });

    const after = usePipelineStore.getState();
    expect(after.nodes.map((n) => n.id).sort()).toEqual(beforeNodeIds);
    const loader = after.nodes.find((n) => n.type === "load_structure")!;
    expect((loader.data.params as { fileName: string }).fileName).toBe("water.gro");
  });
});

describe("usePipelineStore.openFile — AddBond default by file format", () => {
  function bondSourceFor(loaderId: string): string | undefined {
    const state = usePipelineStore.getState();
    // The default pipeline routes loader.particle through a replicate node
    // before reaching AddBond, so follow particle-carrying edges forward.
    const passThrough = new Set([
      "symmetry",
      "wrap",
      "replicate",
      "filter",
      "modify",
      "color",
      "representation",
    ]);
    const visited = new Set<string>([loaderId]);
    const stack: string[] = [loaderId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const e of state.edges) {
        if (e.source !== id) continue;
        const sh = e.sourceHandle ?? "particle";
        if (sh !== "particle" && sh !== "out") continue;
        const node = state.nodes.find((n) => n.id === e.target);
        if (node?.type === "add_bond") {
          return (node.data.params as { bondSource: string }).bondSource;
        }
        if (node && passThrough.has(node.type ?? "") && !visited.has(node.id)) {
          visited.add(node.id);
          stack.push(node.id);
        }
      }
    }
    return undefined;
  }

  const formatsWithBonds: Array<[string, string]> = [
    ["water.pdb", "structure"],
    ["entry.ent", "structure"],
    ["model.pdbx", "structure"],
    ["caffeine.mol", "structure"],
    ["library.sdf", "structure"],
    ["system.data", "structure"],
    ["system.lammps", "structure"],
    // CML carries an explicit <bondArray>, so AddBond should read the file.
    ["ethanol.cml", "structure"],
    // Chem3D XML carries explicit <b> bond elements too.
    ["molecule.c3xml", "structure"],
    // Odyssey carries <bond> elements (XML) / a HESSIAN block (text).
    ["sample.xodydata", "structure"],
    ["sample.odydata", "structure"],
  ];
  const formatsWithoutBonds: Array<[string, string]> = [
    ["water.gro", "distance"],
    ["coords.xyz", "distance"],
    ["entry.cif", "distance"],
    ["frames.traj", "distance"],
  ];

  for (const [filename, expected] of [...formatsWithBonds, ...formatsWithoutBonds]) {
    it(`sets AddBond.bondSource="${expected}" for ${filename}`, async () => {
      mockParseStructureFile.mockResolvedValueOnce({
        snapshot: makeSnapshot(3),
        frames: [],
        meta: null,
        labels: null,
        vectorChannels: [],
      });

      const file = new File(["<data>"], filename);
      await usePipelineStore.getState().openFile(file, { mode: "replace" });

      const loader = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure")!;
      expect(bondSourceFor(loader.id)).toBe(expected);
    });
  }

  it("updates AddBond.bondSource in merge mode too (re-opening a different format)", async () => {
    // First load a .pdb so the seed AddBond is "structure" (matches file).
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<pdb>"], "first.pdb"), {
      mode: "replace",
    });

    // Then merge in a .gro — AddBond should switch to VDW inference.
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<gro>"], "second.gro"), {
      mode: "merge",
    });

    const loader = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure")!;
    expect(bondSourceFor(loader.id)).toBe("distance");
  });
});

describe("usePipelineStore.openFile — trajectory files", () => {
  it("rejects when no load_structure snapshot has been loaded yet", async () => {
    // Reset clears nodeSnapshots, so even though the default graph has a
    // load_structure node, opening a trajectory should fail.
    const file = new File(["<xtc>"], "trajectory.xtc");
    await expect(usePipelineStore.getState().openFile(file)).rejects.toThrow(
      /load a structure file first/i,
    );
  });

  it("attaches frames to fileFrames and updates the load_trajectory fileName", async () => {
    // First load a structure so the trajectory has a known atom count.
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(4),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<gro>"], "water.gro"), {
      mode: "replace",
    });

    mockParseXTCFile.mockResolvedValueOnce({
      frames: [makeFrame(1, 4), makeFrame(2, 4)],
      meta: makeMeta(2, 4),
      vectorChannels: null,
    });

    const xtc = new File([new Uint8Array([9, 9])], "vibration.xtc");
    await usePipelineStore.getState().openFile(xtc);

    const state = usePipelineStore.getState();
    const traj = state.nodes.find((n) => n.type === "load_trajectory")!;
    expect((traj.data.params as { fileName: string }).fileName).toBe("vibration.xtc");
    expect(state.fileFrames?.length).toBe(2);
    expect(mockParseXTCFile).toHaveBeenCalled();
  });

  it("uses the DCD parser for .dcd", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<pdb>"], "water.pdb"), {
      mode: "replace",
    });

    mockParseDCDFile.mockResolvedValueOnce({
      frames: [makeFrame(1, 3), makeFrame(2, 3)],
      meta: makeMeta(2, 3),
      vectorChannels: null,
    });

    const dcd = new File([new Uint8Array([0x54, 0x00, 0x00, 0x00])], "trajectory.dcd");
    await usePipelineStore.getState().openFile(dcd);

    expect(mockParseDCDFile).toHaveBeenCalled();
    expect(mockParseXTCFile).not.toHaveBeenCalled();
    expect(mockParseLammpstrjFile).not.toHaveBeenCalled();
    expect(mockParseNetCDFFile).not.toHaveBeenCalled();

    const state = usePipelineStore.getState();
    const traj = state.nodes.find((n) => n.type === "load_trajectory")!;
    expect((traj.data.params as { fileName: string }).fileName).toBe("trajectory.dcd");
    expect(state.fileFrames?.length).toBe(2);
  });

  it("uses the NetCDF parser for .nc", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<pdb>"], "water.pdb"), {
      mode: "replace",
    });

    mockParseNetCDFFile.mockResolvedValueOnce({
      frames: [makeFrame(1, 3)],
      meta: makeMeta(1, 3),
      vectorChannels: null,
    });

    const nc = new File([new Uint8Array([0x43, 0x44, 0x46, 0x01])], "trajectory.nc");
    await usePipelineStore.getState().openFile(nc);

    expect(mockParseNetCDFFile).toHaveBeenCalled();
    expect(mockParseDCDFile).not.toHaveBeenCalled();
    expect(mockParseXTCFile).not.toHaveBeenCalled();
    expect(mockParseLammpstrjFile).not.toHaveBeenCalled();
  });
});

describe("usePipelineStore.openFile — pipeline files", () => {
  it("deserializes a .megane.json with no companions", async () => {
    const pipeline = {
      version: 3 as const,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "water.pdb",
          hasTrajectory: false,
          hasCell: false,
          position: { x: 0, y: 0 },
          enabled: true,
        },
        {
          id: "viewport-1",
          type: "viewport",
          perspective: false,
          cellAxesVisible: false,
          pivotMarkerVisible: false,
          position: { x: 400, y: 0 },
          enabled: true,
        },
      ],
      edges: [
        {
          source: "load-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    };

    const file = new File([JSON.stringify(pipeline)], "test.megane.json");
    await usePipelineStore.getState().openFile(file);

    const state = usePipelineStore.getState();
    // The pipeline JSON only wires LoadStructure → Viewport (no AddBond).
    // deserializePipeline now normalizes that into the canonical
    // LoadStructure → AddBond → Viewport scaffold, so we expect a
    // synthesized add_bond node alongside the originals.
    const ids = state.nodes.map((n) => n.id).sort();
    expect(ids).toContain("load-1");
    expect(ids).toContain("viewport-1");
    expect(state.nodes.some((n) => n.type === "add_bond")).toBe(true);

    // Viewport guide settings (cellAxesVisible / pivotMarkerVisible) saved
    // in the pipeline JSON must propagate through executePipeline to the
    // viewportState the renderer reads. Regression: previously deserialize
    // overwrote viewportState with DEFAULTS and only post-load executes
    // restored it, leaving a window where guides flicker back on.
    const viewportNode = state.nodes.find((n) => n.id === "viewport-1")!;
    expect((viewportNode.data.params as any).cellAxesVisible).toBe(false);
    expect((viewportNode.data.params as any).pivotMarkerVisible).toBe(false);
    expect(state.viewportState.cellAxesVisible).toBe(false);
    expect(state.viewportState.pivotMarkerVisible).toBe(false);
  });

  it("attaches companion structure files by basename and applies per-node snapshots", async () => {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(7),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });

    const pipeline = {
      version: 3 as const,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "water.pdb",
          hasTrajectory: false,
          hasCell: false,
          position: { x: 0, y: 0 },
          enabled: true,
        },
      ],
      edges: [],
    };

    const meganeFile = new File([JSON.stringify(pipeline)], "deck.megane.json");
    const companion = new File(["<pdb>"], "water.pdb");

    await usePipelineStore.getState().openFile(meganeFile, { companions: [companion] });

    const state = usePipelineStore.getState();
    expect(state.nodeSnapshots["load-1"]?.snapshot.nAtoms).toBe(7);
    expect(
      (state.nodes.find((n) => n.id === "load-1")!.data.params as { fileName: string }).fileName,
    ).toBe("water.pdb");
  });

  it("rejects pipeline files with unsupported version", async () => {
    const pipeline = { version: 99, nodes: [], edges: [] };
    const file = new File([JSON.stringify(pipeline)], "old.megane.json");
    await expect(usePipelineStore.getState().openFile(file)).rejects.toThrow(/version 3/i);
  });
});

describe("usePipelineStore.openFile — error cases", () => {
  it("rejects unsupported extensions", async () => {
    const file = new File(["random"], "notes.txt");
    await expect(usePipelineStore.getState().openFile(file)).rejects.toThrow(
      /unsupported file type/i,
    );
  });
});

describe("applyTopologyFile", () => {
  function findAddBondParams(loaderId: string): Record<string, unknown> | undefined {
    const state = usePipelineStore.getState();
    const passThrough = new Set([
      "symmetry",
      "wrap",
      "replicate",
      "filter",
      "modify",
      "color",
      "representation",
    ]);
    const visited = new Set<string>([loaderId]);
    const stack: string[] = [loaderId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const e of state.edges) {
        if (e.source !== id) continue;
        const sh = e.sourceHandle ?? "particle";
        if (sh !== "particle" && sh !== "out") continue;
        const node = state.nodes.find((n) => n.id === e.target);
        if (node?.type === "add_bond") {
          return node.data.params as Record<string, unknown>;
        }
        if (node && passThrough.has(node.type ?? "") && !visited.has(node.id)) {
          visited.add(node.id);
          stack.push(node.id);
        }
      }
    }
    return undefined;
  }

  async function openGro(): Promise<string> {
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(3),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<gro>"], "water.gro"), {
      mode: "replace",
    });
    const loader = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure")!;
    return loader.id;
  }

  it("sets bondSource:'file' and bondFileName on AddBond when topFile is .top", async () => {
    const mockBonds = new Uint32Array([0, 1, 1, 2]);
    mockParseTopBonds.mockResolvedValueOnce(mockBonds);

    const loaderId = await openGro();

    const topFile = new File(["[ bonds ]\n0 1\n1 2\n"], "water.top");
    await applyTopologyFile(usePipelineStore.getState(), loaderId, topFile);

    const params = findAddBondParams(loaderId);
    expect(params?.bondSource).toBe("file");
    expect(params?.bondFileName).toBe("water.top");
    expect(params?.bondFileData).toEqual(mockBonds);
    expect(mockParseTopBonds).toHaveBeenCalledWith(expect.any(String), 0xffffffff);
    expect(mockParsePsfBonds).not.toHaveBeenCalled();
  });

  it("sets bondSource:'file' and calls parsePsfBonds for .psf file", async () => {
    const mockBonds = new Uint32Array([0, 1]);
    mockParsePsfBonds.mockResolvedValueOnce(mockBonds);

    const loaderId = await openGro();

    const psfFile = new File(["PSF content"], "water.psf");
    await applyTopologyFile(usePipelineStore.getState(), loaderId, psfFile);

    const params = findAddBondParams(loaderId);
    expect(params?.bondSource).toBe("file");
    expect(params?.bondFileName).toBe("water.psf");
    expect(params?.bondFileData).toEqual(mockBonds);
    expect(mockParsePsfBonds).toHaveBeenCalledWith(expect.any(String), 0xffffffff);
    expect(mockParseTopBonds).not.toHaveBeenCalled();
  });

  it("overwrites the 'distance' default set by syncAddBondSourceForLoader", async () => {
    // syncAddBondSourceForLoader sets "distance" for .gro; applyTopologyFile must override it.
    const mockBonds = new Uint32Array([0, 1]);
    mockParseTopBonds.mockResolvedValueOnce(mockBonds);

    const loaderId = await openGro();

    // Confirm the default is "distance" before applying topology
    expect(findAddBondParams(loaderId)?.bondSource).toBe("distance");

    const topFile = new File(["[ bonds ]\n0 1\n"], "water.top");
    await applyTopologyFile(usePipelineStore.getState(), loaderId, topFile);

    expect(findAddBondParams(loaderId)?.bondSource).toBe("file");
  });
});

describe("usePipelineStore — cross-document state isolation", () => {
  it("deserialize clears stale node snapshots from a previous open", async () => {
    // Simulate: user opens a structure file (populates load_structure
    // snapshot), then opens a .megane.json with a different pipeline.
    // The previous pipeline's per-node data must NOT leak into the new
    // execution context — JupyterLab and VSCode share this singleton
    // store across documents.
    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(11),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<pdb>"], "first.pdb"), {
      mode: "replace",
    });
    expect(Object.keys(usePipelineStore.getState().nodeSnapshots).length).toBeGreaterThan(0);

    const pipeline = {
      version: 3 as const,
      nodes: [
        {
          id: "fresh-loader",
          type: "load_structure",
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          position: { x: 0, y: 0 },
          enabled: true,
        },
      ],
      edges: [],
    };
    const meganeFile = new File([JSON.stringify(pipeline)], "second.megane.json");
    await usePipelineStore.getState().openFile(meganeFile);

    const after = usePipelineStore.getState();
    expect(after.nodeSnapshots).toEqual({});
    expect(after.snapshot).toBeNull();
    expect(after.structureFrames).toBeNull();
    expect(after.fileFrames).toBeNull();
  });

  it("opens a structure file even when the current graph has no load_structure node", async () => {
    // Simulate the JupyterLab failure mode: a previous .megane.json
    // installed a graph without a load_structure node (or a broken
    // one). Opening a regular .pdb in the same session must still
    // render — the canonical openFile path installs a minimal
    // pipeline and injects the parsed result.
    const pipeline = {
      version: 3 as const,
      nodes: [
        {
          id: "viewport-1",
          type: "viewport",
          perspective: false,
          cellAxesVisible: false,
          pivotMarkerVisible: false,
          position: { x: 0, y: 0 },
          enabled: true,
        },
      ],
      edges: [],
    };
    await usePipelineStore
      .getState()
      .openFile(new File([JSON.stringify(pipeline)], "loaderless.megane.json"));
    expect(
      usePipelineStore.getState().nodes.find((n) => n.type === "load_structure"),
    ).toBeUndefined();

    mockParseStructureFile.mockResolvedValueOnce({
      snapshot: makeSnapshot(5),
      frames: [],
      meta: null,
      labels: null,
      vectorChannels: [],
    });
    await usePipelineStore.getState().openFile(new File(["<pdb>"], "rescue.pdb"));

    const state = usePipelineStore.getState();
    const loader = state.nodes.find((n) => n.type === "load_structure");
    expect(loader).toBeDefined();
    expect((loader!.data.params as { fileName: string }).fileName).toBe("rescue.pdb");
    expect(state.nodeSnapshots[loader!.id]?.snapshot.nAtoms).toBe(5);
  });
});
