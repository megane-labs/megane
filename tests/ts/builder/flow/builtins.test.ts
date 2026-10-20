/**
 * Flow mode's built-in blocks: a bulk crystal, a supercell, a slab, a polymer
 * chain and molecules placed on a surface, run in the browser on the same
 * code as Manual mode's crystal tools.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BUILTIN_PORTS,
  CANCELLED,
  abortable,
  builtinProblem,
  crystalSpec,
  defaultBuiltinParams,
  isBuiltin,
  placeOnSurface,
  runBuiltin,
  type BuiltinParams,
  type BuiltinType,
} from "@/builder/flow/builtins";
import { bulkSnapshot } from "@/crystal/bulk";
import { buildSlab, makeSupercell } from "@/crystal/transform";
import type { CrystalParams, FlowData } from "@/builder/flow/types";
import type { Snapshot } from "@/types";
import { water, waterData } from "./helpers";

const TYPES: BuiltinType[] = ["crystal", "polymer", "supercell", "slab", "adsorb"];

const cu = (): CrystalParams => defaultBuiltinParams("crystal") as CrystalParams;

function deps(embedded: Snapshot = water()) {
  return { embedSmiles: vi.fn(async () => embedded) };
}

async function crystalData(params: CrystalParams = cu()): Promise<FlowData> {
  return (await runBuiltin(params, {}, {}, deps())).data;
}

/** A 2-carbon chain "*C*" × 2 as RDKit would embed it: carbons first, then hydrogens. */
function ethane(): Snapshot {
  return {
    ...water(),
    nAtoms: 8,
    nBonds: 7,
    nFileBonds: 7,
    positions: new Float32Array(24),
    elements: new Uint8Array([6, 6, 1, 1, 1, 1, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4, 1, 5, 1, 6, 1, 7]),
  };
}

describe("built-in block settings", () => {
  it("knows which params are built in and starts each with usable settings", () => {
    for (const type of TYPES) {
      const params = defaultBuiltinParams(type);
      expect(params.type).toBe(type);
      expect(isBuiltin(params)).toBe(true);
    }
    expect(isBuiltin({ type: "document" })).toBe(false);
  });

  it("gives the blocks that change a structure their inputs", () => {
    expect(BUILTIN_PORTS.crystal).toEqual([]);
    expect(BUILTIN_PORTS.polymer).toEqual([]);
    expect(BUILTIN_PORTS.supercell.map((p) => p.key)).toEqual(["structure"]);
    expect(BUILTIN_PORTS.slab.map((p) => p.key)).toEqual(["bulk"]);
    expect(BUILTIN_PORTS.adsorb.map((p) => [p.key, p.kind])).toEqual([
      ["surface", "document"],
      ["molecule", "molecule"],
    ]);
  });
});

describe("crystal block", () => {
  it("builds Manual mode's bulk crystal", async () => {
    const data = await crystalData();
    expect(data.name).toBe("Cu-fcc");
    expect(data.snapshot).toEqual(
      bulkSnapshot({ structure: "fcc", elements: [29], a: 3.61, cubic: true }),
    );
  });

  it("reads only the prototype's species and its own options", () => {
    const spec = crystalSpec({
      ...cu(),
      structure: "hcp",
      elements: ["mg", "Zz", ""],
      a: 3.21,
      covera: 1.62,
    });
    expect(spec).toEqual({ structure: "hcp", elements: [12], a: 3.21, covera: 1.62 });
    expect(
      crystalSpec({ ...cu(), structure: "rocksalt", elements: ["Na", "Cl"], cubic: false }),
    ).toEqual({ structure: "rocksalt", elements: [11, 17], a: 3.61, cubic: false });
  });

  it("names a species that is not an element", async () => {
    await expect(crystalData({ ...cu(), elements: ["Xx", "", ""] })).rejects.toThrow(
      /Species A: "Xx"/,
    );
    await expect(crystalData({ ...cu(), structure: "rocksalt", elements: ["Na"] })).rejects.toThrow(
      /Species B: ""/,
    );
    await expect(crystalData({ ...cu(), a: 0 })).rejects.toThrow(/positive/);
  });
});

describe("supercell block", () => {
  it("repeats its input along a, b and c, labels and all", async () => {
    const bulk = await crystalData();
    const labelled = { ...bulk, labels: ["CU1", "CU1", "CU1", "CU1"] };
    const { data } = await runBuiltin(
      { type: "supercell", repeat: [2, 1, 3] },
      { structure: ["b"] },
      { b: labelled },
      deps(),
    );
    expect(data.snapshot).toEqual(makeSupercell(bulk.snapshot, [2, 0, 0, 0, 1, 0, 0, 0, 3]));
    expect(data.labels).toHaveLength(24);
    expect(data.name).toBe("Cu-fcc");
    const plain = await runBuiltin(
      { type: "supercell", repeat: [1, 1, 2] },
      { structure: ["b"] },
      { b: bulk },
      deps(),
    );
    expect(plain.data.labels).toBeNull();
  });

  it("asks for its input, whole repeats, and a cell", async () => {
    const params = { type: "supercell", repeat: [2, 2, 2] } as BuiltinParams;
    await expect(runBuiltin(params, {}, {}, deps())).rejects.toThrow(
      "Connect a block to Structure.",
    );
    const bulk = await crystalData();
    await expect(
      runBuiltin(
        { type: "supercell", repeat: [0, 1, 1] },
        { structure: ["b"] },
        { b: bulk },
        deps(),
      ),
    ).rejects.toThrow(/whole numbers from 1 to 20/);
    await expect(
      runBuiltin(params, { structure: ["w"] }, { w: waterData() }, deps()),
    ).rejects.toThrow(/unit cell/);
  });
});

describe("slab block", () => {
  it("cuts the slab Manual mode cuts, then repeats it in plane", async () => {
    const bulk = await crystalData();
    const { data } = await runBuiltin(
      { type: "slab", miller: [1, 0, 0], layers: 2, vacuum: 5, repeat: [2, 3] },
      { bulk: ["b"] },
      { b: bulk },
      deps(),
    );
    const slab = buildSlab(bulk.snapshot, { miller: [1, 0, 0], layers: 2, vacuum: 5 })!;
    expect(data.snapshot).toEqual(makeSupercell(slab, [2, 0, 0, 0, 3, 0, 0, 0, 1]));
    expect(data.snapshot.nAtoms).toBe(slab.nAtoms * 6);
    expect(data.name).toBe("Cu-fcc(100)");
    const single = await runBuiltin(
      { type: "slab", miller: [1, 1, 1], layers: 1, vacuum: 0, repeat: [1, 1] },
      { bulk: ["b"] },
      { b: bulk },
      deps(),
    );
    expect(single.data.snapshot).toEqual(
      buildSlab(bulk.snapshot, { miller: [1, 1, 1], layers: 1, vacuum: 0 }),
    );
  });

  it("refuses bad settings and a structure without a cell", async () => {
    const bulk = await crystalData();
    const slab = (patch: object, input: FlowData = bulk) =>
      runBuiltin(
        { ...(defaultBuiltinParams("slab") as BuiltinParams), ...patch } as BuiltinParams,
        { bulk: ["b"] },
        { b: input },
        deps(),
      );
    await expect(slab({ miller: [0, 0, 0] })).rejects.toThrow(/not all zero/);
    await expect(slab({ miller: [1, 0.5, 0] })).rejects.toThrow(/not all zero/);
    await expect(slab({ layers: 0 })).rejects.toThrow(/Layers/);
    await expect(slab({ repeat: [1, 21] })).rejects.toThrow(/Repeats/);
    await expect(slab({ vacuum: -1 })).rejects.toThrow(/Vacuum/);
    await expect(slab({}, waterData())).rejects.toThrow(/bulk crystal/);
  });
});

describe("polymer block", () => {
  it("embeds the chain's SMILES and labels its repeat units", async () => {
    const d = deps(ethane());
    const { data } = await runBuiltin(
      { type: "polymer", repeatUnit: "*C*", length: 2, name: "PE" },
      {},
      {},
      d,
    );
    expect(d.embedSmiles).toHaveBeenCalledWith("CC");
    expect(data.name).toBe("PE");
    expect(data.labels?.slice(0, 2)).toEqual(["PE1", "PE2"]);
  });

  it("names an unnamed chain by its repeat unit, and reports a bad unit before embedding", async () => {
    const d = deps(water());
    const { data } = await runBuiltin(
      { type: "polymer", repeatUnit: "*CC*", length: 2, name: " " },
      {},
      {},
      d,
    );
    expect(data.name).toBe("*CC*");
    expect(data.labels).toBeNull();
    await expect(
      runBuiltin({ type: "polymer", repeatUnit: "CC", length: 2, name: "" }, {}, {}, d),
    ).rejects.toThrow(/one \* at the start/);
    expect(d.embedSmiles).toHaveBeenCalledTimes(1);
  });
});

describe("placeOnSurface", () => {
  async function slab(): Promise<Snapshot> {
    const bulk = await crystalData();
    return buildSlab(bulk.snapshot, { miller: [1, 0, 0], layers: 2, vacuum: 8 })!;
  }

  function zRange(s: Snapshot, from: number, to = s.nAtoms) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i++) {
      lo = Math.min(lo, s.positions[i * 3 + 2]);
      hi = Math.max(hi, s.positions[i * 3 + 2]);
    }
    return { lo, hi };
  }

  it("lays a grid of copies the given height above the top atom", async () => {
    const surface = await slab();
    const { snapshot, warnings } = placeOnSurface(surface, water(), { height: 2, grid: [2, 2] });
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(surface.nAtoms + 12);
    expect(snapshot.nBonds).toBe(surface.nBonds + 8);
    const top = zRange(surface, 0).hi;
    expect(zRange(snapshot, surface.nAtoms).lo).toBeCloseTo(top + 2, 4);
    // Water's centroid is at x = 0 with its oxygen, so the four oxygens sit
    // at the centres of the four quarters of the (square) cell.
    const a = surface.box![0];
    const at = (k: number, axis: number) => snapshot.positions[(surface.nAtoms + k * 3) * 3 + axis];
    expect([0, 1, 2, 3].map((k) => at(k, 0))).toEqual(
      [a / 4, a / 4, (3 * a) / 4, (3 * a) / 4].map((v) => expect.closeTo(v, 4)),
    );
  });

  it("warns when the molecules stick out of the cell", async () => {
    const surface = await slab();
    const { warnings } = placeOnSurface(surface, water(), { height: 20, grid: [1, 1] });
    expect(warnings[0]).toMatch(/reach past the top of the cell/);
  });

  it("uses the atoms' x–y extent and +z without a cell", () => {
    const flat: Snapshot = {
      ...water(),
      nAtoms: 2,
      nBonds: 0,
      positions: new Float32Array([0, 0, 0, 4, 2, 1]),
      elements: new Uint8Array([6, 6]),
      bonds: new Uint32Array(0),
    };
    const { snapshot } = placeOnSurface(flat, water(), { height: 1, grid: [1, 1] });
    expect(snapshot.nAtoms).toBe(5);
    expect(zRange(snapshot, 2).lo).toBeCloseTo(2, 5);
  });

  it("refuses empty structures and bad settings", async () => {
    const surface = await slab();
    const empty = { ...water(), nAtoms: 0, positions: new Float32Array(0) };
    expect(() => placeOnSurface(empty, water(), { height: 1, grid: [1, 1] })).toThrow(
      /surface has no atoms/,
    );
    expect(() => placeOnSurface(surface, empty, { height: 1, grid: [1, 1] })).toThrow(
      /molecule has no atoms/,
    );
    expect(() => placeOnSurface(surface, water(), { height: NaN, grid: [1, 1] })).toThrow(/Height/);
    expect(() => placeOnSurface(surface, water(), { height: 1, grid: [0, 1] })).toThrow(/Copies/);
  });
});

describe("adsorb block", () => {
  it("places the molecule on the surface and labels the copies", async () => {
    const bulk = await crystalData();
    const { data: slab } = await runBuiltin(
      { type: "slab", miller: [1, 0, 0], layers: 1, vacuum: 6, repeat: [1, 1] },
      { bulk: ["b"] },
      { b: bulk },
      deps(),
    );
    const { data, warnings } = await runBuiltin(
      { type: "adsorb", height: 2, grid: [2, 1] },
      { surface: ["s"], molecule: ["m"] },
      { s: slab, m: waterData("water") },
      deps(),
    );
    expect(warnings).toEqual([]);
    expect(data.name).toBe(slab.name);
    expect(data.labels).toEqual([
      ...Array.from({ length: slab.snapshot.nAtoms }, () => "CUFC1"),
      "WATE1",
      "WATE1",
      "WATE1",
      "WATE2",
      "WATE2",
      "WATE2",
    ]);
    const kept = await runBuiltin(
      { type: "adsorb", height: 2, grid: [1, 1] },
      { surface: ["s"], molecule: ["m"] },
      { s: { ...slab, labels: Array(slab.snapshot.nAtoms).fill("PT1") }, m: waterData() },
      deps(),
    );
    expect(kept.data.labels?.[0]).toBe("PT1");
  });

  it("asks for both inputs", async () => {
    const params = defaultBuiltinParams("adsorb");
    await expect(runBuiltin(params, {}, {}, deps())).rejects.toThrow("Connect a block to Surface.");
    await expect(
      runBuiltin(params, { surface: ["s"] }, { s: waterData() }, deps()),
    ).rejects.toThrow("Connect a block to Molecule.");
  });
});

describe("builtinProblem", () => {
  it("says what running the block would refuse, before it runs", () => {
    for (const type of TYPES) expect(builtinProblem(defaultBuiltinParams(type))).toBeNull();
    expect(builtinProblem({ ...cu(), elements: ["Xx", "", ""] })).toContain("not an element");
    expect(builtinProblem({ ...cu(), a: 0 })).toBe("Lattice constant a must be positive.");
    expect(builtinProblem({ ...cu(), a: NaN })).toContain("positive");
    expect(builtinProblem({ ...cu(), structure: "hcp", elements: ["Mg", "", ""], covera: 0 })).toBe(
      "c/a must be positive.",
    );
    expect(builtinProblem({ type: "polymer", repeatUnit: "*CC*", length: 0, name: "" })).toContain(
      "whole number",
    );
    expect(builtinProblem({ type: "supercell", repeat: [1, 0, 1] })).toContain("Repeats");
    const slab = defaultBuiltinParams("slab") as Extract<BuiltinParams, { type: "slab" }>;
    expect(builtinProblem({ ...slab, miller: [0, 0, 0] })).toContain("not all zero");
    expect(builtinProblem({ ...slab, layers: 0 })).toContain("Layers");
    expect(builtinProblem({ ...slab, vacuum: -1 })).toContain("Vacuum");
    expect(builtinProblem({ type: "adsorb", height: NaN, grid: [1, 1] })).toContain("Height");
    expect(builtinProblem({ type: "adsorb", height: 2, grid: [1, 21] })).toContain("Copies");
  });

  it("is what a crystal block throws when run", async () => {
    await expect(crystalData({ ...cu(), a: -1 })).rejects.toThrow(
      "Lattice constant a must be positive.",
    );
  });
});

describe("abortable", () => {
  it("passes a result or an error through, and rejects as soon as the run stops", async () => {
    await expect(abortable(Promise.resolve(1))).resolves.toBe(1);
    const c = new AbortController();
    await expect(abortable(Promise.resolve(2), c.signal)).resolves.toBe(2);
    await expect(abortable(Promise.reject(new Error("x")), c.signal)).rejects.toThrow("x");
    const pending = abortable(new Promise(() => {}), c.signal);
    c.abort();
    await expect(pending).rejects.toThrow(CANCELLED);
    await expect(abortable(Promise.resolve(3), c.signal)).rejects.toThrow(CANCELLED);
  });

  it("stops a polymer chain's embedding", async () => {
    const c = new AbortController();
    const embedSmiles = vi.fn(() => new Promise<Snapshot>(() => {}));
    const pending = runBuiltin(
      { type: "polymer", repeatUnit: "*CC*", length: 2, name: "" },
      {},
      {},
      { embedSmiles },
      c.signal,
    );
    c.abort();
    await expect(pending).rejects.toThrow(CANCELLED);
  });
});
