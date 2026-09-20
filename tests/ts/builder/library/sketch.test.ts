import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Snapshot } from "@/types";

const { parseStructureText, parseStructureFile } = vi.hoisted(() => ({
  parseStructureText: vi.fn(),
  parseStructureFile: vi.fn(),
}));
vi.mock("@/parsers/structure", () => ({ parseStructureText, parseStructureFile }));
const { embedSketch } = vi.hoisted(() => ({ embedSketch: vi.fn() }));
vi.mock("@/builder/library/embed", () => ({ embedSketch, canEmbed: () => true }));

import {
  draftFromMolfile,
  draftFromFile,
  draftFromSnapshot,
  defaultName,
} from "@/builder/library/sketch";
import { getCovalentRadius } from "@/constants";

function snapshot(positions: number[], elements: number[], bonds: number[]): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: bonds.length / 2,
    nFileBonds: bonds.length / 2,
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(bonds),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}
const parsed = (s: Snapshot) => ({
  snapshot: s,
  labels: null,
  frames: [],
  meta: null,
  vectorChannels: [],
  scalarChannels: [] as { name: string; frames: { frame: number; values: Float32Array }[] }[],
  warnings: [],
});

beforeEach(() => {
  parseStructureText.mockReset();
  parseStructureFile.mockReset();
  embedSketch.mockReset();
});

describe("draftFromSnapshot", () => {
  it("centres a 3D structure as-is and names it after the formula when blank", () => {
    const d = draftFromSnapshot(snapshot([0, 0, 0, 0, 0, 2], [6, 8], [0, 1]), "  ", "file");
    expect(d.name).toBe("CO");
    expect(d.formula).toBe("CO");
    expect(d.origin).toBe("file");
    expect(d.positions).toEqual([0, 0, -1, 0, 0, 1]);
    expect(d.planar).toBeUndefined();
    expect(defaultName("")).toBe("Molecule");
  });

  it("rescales a flat sketch to Å and marks it planar", () => {
    const d = draftFromSnapshot(
      snapshot([0, 0, 0, 1, 0, 0], [6, 6], [0, 1]),
      "Ethane-ish",
      "sketch",
    );
    expect(d.planar).toBe(true);
    expect(d.positions[3] - d.positions[0]).toBeCloseTo(2 * getCovalentRadius(6));
    expect(d.name).toBe("Ethane-ish");
  });

  it("takes a subset and rejects an empty one", () => {
    const d = draftFromSnapshot(
      snapshot([0, 0, 0, 0, 0, 2, 5, 5, 5], [6, 8, 1], [0, 1]),
      "s",
      "selection",
      [1, 0],
    );
    expect(d.elements).toEqual([6, 8]);
    expect(d.bonds).toEqual([[0, 1]]);
    expect(() => draftFromSnapshot(snapshot([], [], []), "x", "file")).toThrow(/no atoms/);
  });
});

describe("draftFromMolfile / draftFromFile", () => {
  const embedded = {
    molblock: "MOLBLOCK-3D",
    energy: -1,
    converged: true,
    forceField: "MMFF94s" as const,
    warnings: [],
    rdkitVersion: "2026.03.6",
  };

  it("embeds through RDKit, parses its mol block, centres it and keeps the sketch as drawn", async () => {
    // RDKit hands back ethanol in 3D with every hydrogen; nothing is rescaled or added.
    embedSketch.mockResolvedValue(embedded);
    parseStructureText.mockResolvedValue(
      parsed(
        snapshot(
          [0, 0, 0, 1.52, 0, 0, 2.0, 1.35, 0, -0.4, 1.0, 0.3, -0.4, -0.5, -0.9, 1.9, -0.5, -0.9],
          [6, 6, 8, 1, 1, 1],
          [0, 1, 1, 2, 0, 3, 0, 4, 1, 5],
        ),
      ),
    );
    const d = await draftFromMolfile("KETCHER-MOL", "Ethanol");
    expect(embedSketch).toHaveBeenCalledWith("KETCHER-MOL", {
      addHydrogens: true,
      forceField: undefined,
    });
    expect(parseStructureText).toHaveBeenCalledWith("MOLBLOCK-3D", "sketch.mol");
    expect(d.molfile).toBe("KETCHER-MOL");
    expect(d.origin).toBe("sketch");
    expect(d.name).toBe("Ethanol");
    expect(d.planar).toBeUndefined();
    expect(d.elements).toEqual([6, 6, 8, 1, 1, 1]);
    expect(d.bonds).toHaveLength(5);
    // Centred, with the C–C distance exactly as RDKit placed it.
    expect(d.positions[3] - d.positions[0]).toBeCloseTo(1.52, 6);
    const zs = d.positions.filter((_, k) => k % 3 === 2);
    expect(zs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(0.5);
  });

  it("forwards Add hydrogens off and the force field to RDKit, and names the draft after the formula", async () => {
    embedSketch.mockResolvedValue(embedded);
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 0, 0, 1.1], [6, 8], [0, 1])));
    const d = await draftFromMolfile("mol", "  ", { addHydrogens: false, forceField: "UFF" });
    expect(embedSketch).toHaveBeenCalledWith("mol", { addHydrogens: false, forceField: "UFF" });
    expect(d.formula).toBe("CO");
    expect(d.name).toBe("CO");
  });

  it("takes an injected embedder, surfaces RDKit's error and rejects an empty sketch first", async () => {
    embedSketch.mockRejectedValue(new Error("Could not sanitize"));
    await expect(draftFromMolfile("bad", "")).rejects.toThrow("Could not sanitize");
    expect(parseStructureText).not.toHaveBeenCalled();

    const custom = vi.fn(async () => ({ ...embedded, molblock: "CUSTOM" }));
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 0, 0, 1.1], [6, 8], [0, 1])));
    const d = await draftFromMolfile("mol", "", { embed: custom });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(embedSketch).toHaveBeenCalledTimes(1);
    expect(parseStructureText).toHaveBeenLastCalledWith("CUSTOM", "sketch.mol");
    expect(d.formula).toBe("CO");
    await expect(draftFromMolfile(" \n ", "x", { embed: custom })).rejects.toThrow(/empty/);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("names a file import after the file", async () => {
    parseStructureFile.mockResolvedValue(parsed(snapshot([0, 0, 0], [6], [])));
    const file = new File(["x"], "methane.xyz");
    const d = await draftFromFile(file);
    expect(parseStructureFile).toHaveBeenCalledWith(file);
    expect(d.name).toBe("methane");
    expect((await draftFromFile(file, "Given")).name).toBe("Given");
  });
});
