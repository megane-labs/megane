import { describe, it, expect } from "vitest";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import { centroid } from "@/builder/library/fragment";
import { getCovalentRadius } from "@/constants";

describe("PRESET_MOLECULES", () => {
  it("has unique preset ids, names and formulas", () => {
    const ids = PRESET_MOLECULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of PRESET_MOLECULES) {
      expect(m.id).toMatch(/^preset:[a-z0-9-]+$/);
      expect(m.origin).toBe("preset");
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.formula.length).toBeGreaterThan(0);
    }
    const byId = Object.fromEntries(PRESET_MOLECULES.map((m) => [m.id, m.formula]));
    expect(byId["preset:water"]).toBe("H2O");
    expect(byId["preset:ethanol"]).toBe("C2H6O");
    expect(byId["preset:benzene"]).toBe("C6H6");
    expect(byId["preset:carbon-dioxide"]).toBe("CO2");
  });

  it("every preset is centred, connected, and has chemically sane bond lengths", () => {
    for (const m of PRESET_MOLECULES) {
      const n = m.elements.length;
      expect(m.positions).toHaveLength(n * 3);
      const c = centroid(m.positions);
      for (const v of c) expect(Math.abs(v)).toBeLessThan(1e-6);
      if (m.bondOrders) expect(m.bondOrders).toHaveLength(m.bonds.length);
      // Every atom is bonded (no stray atoms) and every bond is within 15 %
      // of the covalent-radius sum (H–H is the outlier at 0.74 Å vs 2 × 0.31).
      const touched = new Set<number>();
      for (const [i, j] of m.bonds) {
        touched.add(i);
        touched.add(j);
        const dx = m.positions[i * 3] - m.positions[j * 3];
        const dy = m.positions[i * 3 + 1] - m.positions[j * 3 + 1];
        const dz = m.positions[i * 3 + 2] - m.positions[j * 3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const expected = getCovalentRadius(m.elements[i]) + getCovalentRadius(m.elements[j]);
        expect(len, `${m.name} bond ${i}-${j}`).toBeGreaterThan(expected * 0.75);
        expect(len, `${m.name} bond ${i}-${j}`).toBeLessThan(expected * 1.25);
      }
      expect(touched.size).toBe(n);
      // No two atoms on top of each other.
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          const d = Math.hypot(
            m.positions[a * 3] - m.positions[b * 3],
            m.positions[a * 3 + 1] - m.positions[b * 3 + 1],
            m.positions[a * 3 + 2] - m.positions[b * 3 + 2],
          );
          expect(d, `${m.name} atoms ${a},${b}`).toBeGreaterThan(0.7);
        }
      }
    }
  });

  it("benzene alternates Kekulé bond orders; diatomics carry their multiplicity", () => {
    const benzene = PRESET_MOLECULES.find((m) => m.id === "preset:benzene")!;
    expect(benzene.bondOrders!.filter((o) => o === 2)).toHaveLength(3);
    expect(PRESET_MOLECULES.find((m) => m.id === "preset:nitrogen")!.bondOrders).toEqual([3]);
    expect(PRESET_MOLECULES.find((m) => m.id === "preset:water")!.bondOrders).toBeUndefined();
  });
});
