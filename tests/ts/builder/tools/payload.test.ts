import { describe, it, expect } from "vitest";
import {
  insertOps,
  moleculeArgument,
  moleculeToMolblock,
  residueLabels,
  snapshotToStructure,
  structureToSnapshot,
} from "@/builder/tools/payload";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import { parseResult, type StructurePayload } from "@/builder/tools/contract";
import { CALLS } from "./fixtures";

const water: StructurePayload = {
  elements: [8, 1, 1],
  positions: [0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0],
  cell: [10, 0, 0, 0, 10, 0, 0, 0, 10],
  bonds: [
    [0, 1],
    [0, 2],
  ],
};

describe("result → Snapshot", () => {
  it("keeps every channel the Snapshot has", () => {
    const snap = structureToSnapshot({ ...water, bondOrders: [1, 2], chainIds: ["A", "A", "B"] });
    expect(snap.nAtoms).toBe(3);
    expect(snap.nBonds).toBe(2);
    expect(snap.nFileBonds).toBe(2);
    expect(Array.from(snap.bonds)).toEqual([0, 1, 0, 2]);
    expect(Array.from(snap.bondOrders!)).toEqual([1, 2]);
    expect(Array.from(snap.box!)).toEqual(water.cell);
    expect(Array.from(snap.atomChainIds!)).toEqual([65, 65, 66]);
    const plain = structureToSnapshot({ ...water, cell: null });
    expect(plain.box).toBeNull();
    expect(plain.bondOrders).toBeNull();
    expect(plain.atomChainIds).toBeNull();
  });

  it("labels residues in the writers' form", () => {
    expect(residueLabels(water)).toBeNull();
    expect(residueLabels({ ...water, residueNames: ["WAT", "WAT", "WAT"] })).toEqual([
      "WAT",
      "WAT",
      "WAT",
    ]);
    expect(
      residueLabels({ ...water, residueNames: ["WAT", "WAT", "WAT"], residueIds: [7, 7, 7] }),
    ).toEqual(["WAT7", "WAT7", "WAT7"]);
    const box = parseResult(CALLS.liquid_box.result.structuredContent).structure;
    expect(residueLabels(box)![0]).toMatch(/^WATE\d+$/);
  });
});

describe("Snapshot → document argument", () => {
  it("round-trips through structureToSnapshot", () => {
    const back = snapshotToStructure(structureToSnapshot({ ...water, bondOrders: [2, 1] }));
    expect(back.elements).toEqual(water.elements);
    expect(back.bonds).toEqual(water.bonds);
    expect(back.bondOrders).toEqual([2, 1]);
    expect(back.cell).toEqual(water.cell);
    expect(back.positions[3]).toBeCloseTo(0.96, 5);
    const single = snapshotToStructure(
      structureToSnapshot({ ...water, cell: null, bondOrders: [1, 1] }),
    );
    expect(single.bondOrders).toBeUndefined();
    expect(single.cell).toBeNull();
  });
});

describe("library molecule → mol block", () => {
  it("writes V2000 with the 3D dimension code", () => {
    const benzene = PRESET_MOLECULES.find((m) => m.id === "preset:benzene")!;
    const block = moleculeToMolblock(benzene);
    const lines = block.split("\n");
    expect(lines[0]).toBe("Benzene");
    expect(lines[1].slice(20, 22)).toBe("3D");
    expect(lines[3]).toMatch(/^ 12 12  0/);
    expect(lines[4]).toMatch(/^\s+-?\d+\.\d{4}\s+-?\d+\.\d{4}\s+-?\d+\.\d{4} C /);
    expect(lines.some((l) => /^ {2}1 {2}2 {2}2 {2}0$/.test(l))).toBe(true);
    expect(block.trimEnd().endsWith("M  END")).toBe(true);
    expect(moleculeArgument(benzene)).toEqual({ name: "Benzene", molblock: block });
  });

  it("marks planar molecules 2D and defaults bond orders to single", () => {
    const flat = { ...PRESET_MOLECULES[0], name: "a\nb", planar: true, bondOrders: undefined };
    const lines = moleculeToMolblock(flat).split("\n");
    expect(lines[0]).toBe("a b");
    expect(lines[1].slice(20, 22)).toBe("2D");
    expect(lines.filter((l) => / {2}1 {2}0$/.test(l)).length).toBe(flat.bonds.length);
  });
});

describe("insert ops", () => {
  it("adds one fragment and a set_cell only when the cell changes", () => {
    const same = insertOps(water, "frag-1", new Float32Array(water.cell!));
    expect(same.map((o) => o.op)).toEqual(["add_fragment"]);
    expect(same[0]).toMatchObject({
      id: "frag-1",
      elements: water.elements,
      positions: water.positions,
    });
    expect("bondOrders" in same[0]).toBe(false);

    const grown = insertOps(
      { ...water, bondOrders: [1, 1] },
      "f",
      new Float32Array([9, 0, 0, 0, 9, 0, 0, 0, 9]),
    );
    expect(grown.map((o) => o.op)).toEqual(["set_cell", "add_fragment"]);
    expect(grown[0]).toEqual({ op: "set_cell", box: water.cell, scaleAtoms: false });
    expect(grown[1]).toMatchObject({ bondOrders: [1, 1] });

    expect(insertOps(water, "f", null).map((o) => o.op)).toEqual(["set_cell", "add_fragment"]);
    expect(insertOps({ ...water, cell: null }, "f", null).map((o) => o.op)).toEqual([
      "add_fragment",
    ]);
  });
});
