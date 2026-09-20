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
  it("parses the molfile through the MOL parser, adds the implicit hydrogens and keeps the text", async () => {
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 1, 0, 0], [8, 1], [0, 1])));
    const d = await draftFromMolfile("\n\n\nmol", "");
    expect(parseStructureText).toHaveBeenCalledWith("\n\n\nmol", "sketch.mol");
    expect(d.molfile).toBe("\n\n\nmol");
    expect(d.origin).toBe("sketch");
    // O–H drawn: the oxygen gets its second hydrogen, the sketch stays marked flat.
    expect(d.formula).toBe("H2O");
    expect(d.elements).toEqual([8, 1, 1]);
    expect(d.bonds).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(d.planar).toBe(true);
    await expect(draftFromMolfile("   ", "x")).rejects.toThrow(/empty/);
  });

  it("completes a flat ethanol sketch to C2H6O, centred, with the skeleton untouched", async () => {
    parseStructureText.mockResolvedValue(
      parsed(snapshot([0, 0, 0, 0.866, 0.5, 0, 1.732, 0, 0], [6, 6, 8], [0, 1, 1, 2])),
    );
    const d = await draftFromMolfile("mol", "");
    expect(d.formula).toBe("C2H6O");
    expect(d.elements).toEqual([6, 6, 8, 1, 1, 1, 1, 1, 1]);
    expect(d.bonds).toHaveLength(8);
    // Heavy atoms keep z = 0 (rescaled and centred only); the CH2 pair leaves the plane.
    for (let i = 0; i < 3; i++) expect(d.positions[i * 3 + 2]).toBeCloseTo(0, 6);
    expect(d.positions.some((v, k) => k % 3 === 2 && Math.abs(v) > 0.5)).toBe(true);
    const [cx, cy, cz] = [0, 1, 2].map(
      (k) => d.positions.filter((_, i) => i % 3 === k).reduce((a, b) => a + b, 0) / 9,
    );
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
    expect(cz).toBeCloseTo(0, 6);
    expect(d.positions[3] - d.positions[0]).toBeCloseTo((2 * getCovalentRadius(6) * 0.866) / 1, 1);
  });

  it("can leave the sketch as drawn, and reads formal charges from the parser", async () => {
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 1, 0, 0], [6, 8], [0, 1])));
    const bare = await draftFromMolfile("mol", "", { addHydrogens: false });
    expect(bare.formula).toBe("CO");
    expect(bare.elements).toEqual([6, 8]);

    const charged = parsed(snapshot([0, 0, 0, 1, 0, 0], [6, 8], [0, 1]));
    charged.scalarChannels = [
      { name: "formal_charge", frames: [{ frame: 0, values: new Float32Array([0, -1]) }] },
    ];
    parseStructureText.mockResolvedValue(charged);
    const alkoxide = await draftFromMolfile("mol", "");
    // Methoxide: the O⁻ takes no hydrogen, the carbon its three.
    expect(alkoxide.formula).toBe("CH3O");
  });

  it("maps formal charges through a selection subset", () => {
    const s = snapshot([0, 0, 0, 5, 0, 0, 9, 0, 0], [6, 8, 6], []);
    const d = draftFromSnapshot(s, "", "selection", [2, 1], {
      addHydrogens: true,
      formalCharges: [0, -1, 1],
    });
    // Atom 1 (O⁻, one H) and atom 2 (C⁺, three H).
    expect(d.formula).toBe("CH4O");
  });

  it("embeds through RDKit when asked, parses its mol block and keeps the sketch as drawn", async () => {
    // RDKit hands back ethanol in 3D with every hydrogen; nothing is rescaled or added.
    const embedded = snapshot(
      [0, 0, 0, 1.52, 0, 0, 2.0, 1.35, 0, -0.4, 1.0, 0.3, -0.4, -0.5, -0.9, 1.9, -0.5, -0.9],
      [6, 6, 8, 1, 1, 1],
      [0, 1, 1, 2, 0, 3, 0, 4, 1, 5],
    );
    embedSketch.mockResolvedValue({
      molblock: "MOLBLOCK-3D",
      energy: -1,
      converged: true,
      forceField: "MMFF94s",
      warnings: [],
      rdkitVersion: "2026.03.6",
    });
    parseStructureText.mockResolvedValue(parsed(embedded));
    const d = await draftFromMolfile("KETCHER-MOL", "Ethanol", {
      embed3D: true,
      addHydrogens: false,
      forceField: "UFF",
    });
    expect(embedSketch).toHaveBeenCalledWith("KETCHER-MOL", {
      addHydrogens: false,
      forceField: "UFF",
    });
    expect(parseStructureText).toHaveBeenCalledWith("MOLBLOCK-3D", "sketch.mol");
    expect(d.molfile).toBe("KETCHER-MOL");
    expect(d.origin).toBe("sketch");
    expect(d.planar).toBeUndefined();
    expect(d.elements).toEqual([6, 6, 8, 1, 1, 1]);
    expect(d.bonds).toHaveLength(5);
    // Centred, with the C–C distance exactly as RDKit placed it.
    expect(d.positions[3] - d.positions[0]).toBeCloseTo(1.52, 6);
    const zs = d.positions.filter((_, k) => k % 3 === 2);
    expect(zs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(0.5);
  });

  it("passes hydrogens on to RDKit by default, takes an injected embedder and surfaces its error", async () => {
    embedSketch.mockRejectedValue(new Error("Could not sanitize"));
    await expect(draftFromMolfile("bad", "", { embed3D: true })).rejects.toThrow(
      "Could not sanitize",
    );
    expect(embedSketch).toHaveBeenCalledWith("bad", { addHydrogens: true, forceField: undefined });
    expect(parseStructureText).not.toHaveBeenCalled();

    const custom = vi.fn(async () => ({
      molblock: "CUSTOM",
      energy: null,
      converged: false,
      forceField: "none" as const,
      warnings: [],
      rdkitVersion: "v",
    }));
    parseStructureText.mockResolvedValue(parsed(snapshot([0, 0, 0, 0, 0, 1.1], [6, 8], [0, 1])));
    const d = await draftFromMolfile("mol", "", { embed3D: true, embed: custom });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(embedSketch).toHaveBeenCalledTimes(1);
    expect(parseStructureText).toHaveBeenLastCalledWith("CUSTOM", "sketch.mol");
    expect(d.formula).toBe("CO");
    // An empty sketch is rejected before RDKit is asked.
    await expect(draftFromMolfile(" \n ", "x", { embed3D: true })).rejects.toThrow(/empty/);
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
