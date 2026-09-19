import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Snapshot } from "@/types";

const { parseStructureText, parseStructureFile } = vi.hoisted(() => ({
  parseStructureText: vi.fn(),
  parseStructureFile: vi.fn(),
}));
vi.mock("@/parsers/structure", () => ({ parseStructureText, parseStructureFile }));

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
  scalarChannels: [],
  warnings: [],
});

beforeEach(() => {
  parseStructureText.mockReset();
  parseStructureFile.mockReset();
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
  it("parses the molfile through the MOL parser and keeps the text", async () => {
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 1, 0, 0], [8, 1], [0, 1])));
    const d = await draftFromMolfile("\n\n\nmol", "");
    expect(parseStructureText).toHaveBeenCalledWith("\n\n\nmol", "sketch.mol");
    expect(d.molfile).toBe("\n\n\nmol");
    expect(d.origin).toBe("sketch");
    expect(d.formula).toBe("HO");
    await expect(draftFromMolfile("   ", "x")).rejects.toThrow(/empty/);
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
