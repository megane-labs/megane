/**
 * "Clean up geometry": the mol block sent to RDKit, reading its answer back,
 * putting each molecule back in place, and the store / notice around it.
 * RDKit itself is replaced by a stub (the real worker runs in the E2E suite).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_CLEANUP_ATOMS,
  cleanUpMolecules,
  inferredCharges,
  moleculeMolblock,
  molblockPositions,
  runCleanup,
} from "@/builder/cleanup";
import type { EmbeddedSketch } from "@/builder/library/embed";
import { useBuilderStore } from "@/builder/store";
import type { Snapshot } from "@/types";

const s = () => useBuilderStore.getState();

/** Water (O, H, H) plus a lone Na at 5 Å, O–H bonds single; bond 1 marked aromatic for the test. */
function water(): Snapshot {
  return {
    nAtoms: 4,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0, 5, 5, 5]),
    elements: new Uint8Array([8, 1, 1, 11]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: new Uint8Array([1, 4]),
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** A stub RDKit: answers with the molecule it was sent, rotated 90° about z and shifted. */
function rotatingEmbed(calls: string[] = []) {
  return async (molfile: string): Promise<EmbeddedSketch> => {
    calls.push(molfile);
    const lines = molfile.split("\n");
    const counts = lines.findIndex((l) => l.includes("V2000"));
    const n = Number(lines[counts].slice(0, 3));
    for (let i = 0; i < n; i++) {
      const l = lines[counts + 1 + i];
      const [x, y, z] = [0, 1, 2].map((k) => Number(l.slice(k * 10, k * 10 + 10)));
      const f = (v: number) => v.toFixed(4).padStart(10);
      lines[counts + 1 + i] = `${f(-y + 7)}${f(x - 3)}${f(z + 1)}${l.slice(30)}`;
    }
    return {
      molblock: lines.join("\n"),
      energy: 1.5,
      converged: true,
      forceField: "MMFF94s",
      warnings: [],
      rdkitVersion: "test",
    };
  };
}

beforeEach(() => useBuilderStore.setState(useBuilderStore.getInitialState(), true));

describe("mol blocks", () => {
  it("writes the chosen atoms and the bonds among them as V2000", () => {
    const mb = moleculeMolblock(water(), [0, 1, 2]);
    const lines = mb.split("\n");
    expect(lines[3]).toMatch(/^ {2}3 {2}2 .*V2000$/);
    expect(lines[4]).toMatch(/^ {4}0\.0000 {4}0\.0000 {4}0\.0000 O /);
    expect(lines[7]).toBe("  1  2  1  0");
    expect(lines[8]).toBe("  1  3  4  0");
    expect(mb.trimEnd().endsWith("M  END")).toBe(true);
    // Bonds to atoms outside the molecule are left out.
    expect(moleculeMolblock(water(), [1, 2]).split("\n")[3]).toMatch(/^ {2}2 {2}0 /);
  });

  it("reads the positions back and refuses an unreadable answer", () => {
    const pos = molblockPositions(moleculeMolblock(water(), [0, 1, 2]), 3);
    expect(Array.from(pos)).toEqual([0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0].map((v) => v));
    expect(() => molblockPositions("nothing", 1)).toThrow("no V2000");
    const broken = moleculeMolblock(water(), [0, 1, 2]).replace("0.9600", "abcdef");
    expect(() => molblockPositions(broken, 3)).toThrow("unreadable");
  });
});

/** Atoms of the given elements, each bonded to the first with the given orders. */
function star(elements: number[], orders: number[]): Snapshot {
  const n = elements.length;
  return {
    ...water(),
    nAtoms: n,
    nBonds: n - 1,
    nFileBonds: n - 1,
    positions: new Float32Array(n * 3).map((_, i) => i * 0.3),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(Array.from({ length: n - 1 }, (_, i) => [0, i + 1]).flat()),
    bondOrders: new Uint8Array(orders),
  };
}

describe("inferred charges", () => {
  const charge = (elements: number[], orders: number[]) =>
    inferredCharges(star(elements, orders), [...elements.keys()]).get(0);

  it("charges an atom with more bonds than its neutral valence", () => {
    expect(charge([7, 1, 1, 1, 1], [1, 1, 1, 1])).toBe(1); // ammonium
    expect(charge([15, 6, 6, 6, 6], [1, 1, 1, 1])).toBe(1); // phosphonium
    expect(charge([8, 1, 1, 1], [1, 1, 1])).toBe(1); // hydronium
    expect(charge([16, 6, 6, 6], [1, 1, 1])).toBe(1); // sulfonium
    expect(charge([5, 9, 9, 9, 9], [1, 1, 1, 1])).toBe(-1); // tetrafluoroborate
    // Double bonds count twice: an iminium N.
    expect(charge([7, 6, 1, 1], [2, 1, 1])).toBe(1);
  });

  it("leaves neutral valences and aromatic atoms to RDKit", () => {
    expect(charge([7, 1, 1, 1], [1, 1, 1])).toBeUndefined();
    expect(charge([8, 1], [1])).toBeUndefined();
    expect(charge([7, 6, 6, 1], [4, 4, 1])).toBeUndefined(); // pyrrole N–H
    expect(charge([6, 1, 1, 1, 1], [1, 1, 1, 1])).toBeUndefined();
  });

  it("writes them as M  CHG lines, eight to a line", () => {
    const mb = moleculeMolblock(water(), [0, 1, 2], undefined, new Map([[0, 1]]));
    expect(mb).toContain("M  CHG  1   1   1\nM  END");
    const many = new Map(Array.from({ length: 9 }, (_, k) => [k, k % 2 ? -1 : 1]));
    const lines = moleculeMolblock(
      star(Array(9).fill(7), Array(8).fill(1)),
      [...many.keys()],
      undefined,
      many,
    )
      .split("\n")
      .filter((l) => l.startsWith("M  CHG"));
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("M  CHG  8   1   1   2  -1")).toBe(true);
    expect(lines[1]).toBe("M  CHG  1   9   1");
  });

  it("sends an ammonium to RDKit with its charge", async () => {
    const calls: string[] = [];
    await cleanUpMolecules(star([7, 1, 1, 1, 1], [1, 1, 1, 1]), [], rotatingEmbed(calls));
    expect(calls[0]).toContain("M  CHG  1   1   1");
  });
});

describe("cleanUpMolecules", () => {
  it("makes a molecule split across the cell whole again", async () => {
    // O at the cell's +x face, its H through the face on the other side.
    const split: Snapshot = {
      ...water(),
      nAtoms: 3,
      positions: new Float32Array([9.8, 5, 5, 0.76, 5, 5, 9.56, 5.93, 5]),
      elements: new Uint8Array([8, 1, 1]),
      bondOrders: null,
      box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    };
    const calls: string[] = [];
    const r = await cleanUpMolecules(split, [], rotatingEmbed(calls));
    // RDKit got the whole molecule: the H at x = 10.76, not 0.76.
    expect(calls[0].split("\n")[5]).toMatch(/^ {3}10\.7600/);
    // The H moves by one cell length to join its O; the others stay.
    expect(r.displacements.get(1)![0]).toBeCloseTo(10, 3);
    expect(Math.abs(r.displacements.get(0)![0])).toBeLessThan(1e-3);
  });

  it("cleans up the molecules RDKit accepts and counts the ones it rejects", async () => {
    // Two waters; RDKit fails on the second.
    const two: Snapshot = {
      ...water(),
      nAtoms: 6,
      nBonds: 4,
      positions: new Float32Array([
        0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0, 5, 0, 0, 5.96, 0, 0, 4.76, 0.93, 0,
      ]),
      elements: new Uint8Array([8, 1, 1, 8, 1, 1]),
      bonds: new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]),
      bondOrders: null,
    };
    let n = 0;
    const embed = async (molfile: string) => {
      if (n++ === 1) throw new Error("Can't kekulize mol");
      return rotatingEmbed()(molfile);
    };
    const r = await cleanUpMolecules(two, [], embed);
    expect(r).toMatchObject({ cleaned: 1, failed: 1, error: "Can't kekulize mol" });
    expect([...r.displacements.keys()]).toEqual([0, 1, 2]);

    s().openStructure(two, null, "two.xyz");
    n = 0;
    await runCleanup(useBuilderStore, embed);
    expect(s().notice).toEqual({
      level: "error",
      text: "Cleaned up 1 molecule (MMFF94s, 1.50 kcal/mol); 1 left as they are (RDKit: Can't kekulize mol).",
    });
  });

  it("re-embeds each chosen molecule and puts it back where it was", async () => {
    const calls: string[] = [];
    const r = await cleanUpMolecules(water(), [], rotatingEmbed(calls));
    // Water is cleaned; the lone Na is skipped.
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ cleaned: 1, skipped: 1, energy: 1.5, forceField: "MMFF94s" });
    // The stub only rotated and shifted the molecule: superposed back, nothing moves.
    for (const [, d] of r.displacements) for (const v of d) expect(Math.abs(v)).toBeLessThan(1e-3);
    expect([...r.displacements.keys()]).toEqual([0, 1, 2]);
  });

  it("works on the selected molecules only, and skips molecules too large for V2000", async () => {
    const r = await cleanUpMolecules(water(), [3], rotatingEmbed());
    expect(r.cleaned).toBe(0);
    expect(r.skipped).toBe(1);
    const n = MAX_CLEANUP_ATOMS + 1;
    const big: Snapshot = {
      ...water(),
      nAtoms: n,
      nBonds: n - 1,
      positions: new Float32Array(n * 3).map((_, i) => i),
      elements: new Uint8Array(n).fill(6),
      bonds: new Uint32Array(Array.from({ length: n - 1 }, (_, i) => [i, i + 1]).flat()),
      bondOrders: null,
    };
    const rb = await cleanUpMolecules(big, [], rotatingEmbed());
    expect(rb).toMatchObject({ cleaned: 0, skipped: 1, energy: null, forceField: null });
  });
});

describe("runCleanup", () => {
  it("moves the atoms as one Undo step and says so", async () => {
    s().openStructure(water(), null, "w.xyz");
    // A stub that also stretches the O–H bonds, so the atoms really move.
    const embed = async (molfile: string) => {
      const r = await rotatingEmbed()(molfile);
      return { ...r, molblock: r.molblock.replace("    7.0000   -2.0400", "    7.0000   -2.1400") };
    };
    await runCleanup(useBuilderStore, embed);
    expect(s().notice?.text).toBe(
      "Cleaned up 1 molecule (MMFF94s, 1.50 kcal/mol); 1 skipped (single atoms or too large).",
    );
    expect(s().edits.length).toBeGreaterThan(0);
    expect(s().edits.every((op) => op.op === "move_atoms")).toBe(true);
    s().undo();
    expect(s().edits).toEqual([]);
  });

  it("reports RDKit's refusal, a document that changed meanwhile, and nothing to do", async () => {
    s().openStructure(water(), null, "w.xyz");
    await runCleanup(useBuilderStore, async () => {
      throw new Error("Can't kekulize mol");
    });
    expect(s().notice).toEqual({
      level: "error",
      text: "Could not clean up the geometry: Can't kekulize mol",
    });

    await runCleanup(useBuilderStore, async (m) => {
      s().pushOp({ op: "wrap" });
      return rotatingEmbed()(m);
    });
    expect(s().notice?.text).toContain("structure changed");
    expect(s().edits).toHaveLength(1);

    s().setSelected([3]);
    await runCleanup(useBuilderStore, rotatingEmbed());
    expect(s().notice?.text).toContain("Nothing to clean up");

    // Not editable: nothing happens at all.
    s().setShowOriginal(true);
    s().setNotice(null);
    await runCleanup(useBuilderStore, rotatingEmbed());
    expect(s().notice).toBeNull();
  });

  it("uses the RDKit worker by default, which a host without workers lacks", async () => {
    s().openStructure(water(), null, "w.xyz");
    await runCleanup(useBuilderStore);
    expect(s().notice?.text).toContain("Web Workers");
  });
});
