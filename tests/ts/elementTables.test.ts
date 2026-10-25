// @vitest-environment node
/**
 * The display-side element tables in `src/constants.ts` against the Rust
 * parsers (through the real WASM module): every element the parsers resolve,
 * H..Og, comes back to the user under its own symbol, with a mass, a radius
 * and a colour, instead of a "#93"-style placeholder.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureInit, parseStructureCore } from "@/parsers/parseCore";
import {
  ATOMIC_MASSES,
  DEFAULT_COLOR,
  ELEMENT_SYMBOLS,
  VDW_RADII,
  getAtomicMass,
  getColor,
  getElementSymbol,
} from "@/constants";

// prettier-ignore
const ALL_SYMBOLS = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S",
  "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge",
  "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
  "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd",
  "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm",
  "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
  "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];

beforeAll(async () => {
  await ensureInit(
    new WebAssembly.Module(
      readFileSync(join(process.cwd(), "crates/megane-wasm/pkg/megane_wasm_bg.wasm")),
    ),
  );
});

describe("element tables", () => {
  it("cover H..Og (Z 1-118)", () => {
    expect(ALL_SYMBOLS).toHaveLength(118);
    expect(Object.keys(ELEMENT_SYMBOLS).map(Number)).toEqual(ALL_SYMBOLS.map((_, i) => i + 1));
    ALL_SYMBOLS.forEach((sym, i) => expect(getElementSymbol(i + 1)).toBe(sym));
    expect(getElementSymbol(119)).toBe("#119");
  });

  it("give every element a mass and a van der Waals radius", () => {
    for (let z = 1; z <= 118; z++) {
      expect(ATOMIC_MASSES[z], `mass of Z=${z}`).toBeGreaterThan(0);
      expect(VDW_RADII[z], `radius of Z=${z}`).toBeGreaterThan(0);
    }
    // Heavier elements weigh more, except where the periodic table itself
    // inverts (Ar/K, Co/Ni, Te/I, Th/Pa, U/Np, Pu/Am, Hs, Fl/Mc ...): masses
    // stay within a few u of each neighbour.
    for (let z = 2; z <= 118; z++) {
      expect(ATOMIC_MASSES[z] - ATOMIC_MASSES[z - 1], `Z=${z}`).toBeGreaterThan(-10);
    }
    expect(getAtomicMass(93)).toBe(237); // Np
    expect(getAtomicMass(94)).toBe(244); // Pu
    expect(getAtomicMass(118)).toBe(294); // Og
  });

  it("colour the actinides and transactinides the Jmol way, up to Mt", () => {
    expect(getColor(93)).toEqual([0.0, 0.502, 1.0]); // Np
    expect(getColor(103)).toEqual([0.78, 0.0, 0.4]); // Lr
    expect(getColor(109)).toEqual([0.922, 0.0, 0.149]); // Mt
    // No published scheme colours Ds..Og: they take the unknown-element colour.
    expect(getColor(110)).toEqual(DEFAULT_COLOR);
    expect(getColor(118)).toEqual(DEFAULT_COLOR);
  });

  it("name every element the Rust parsers resolve by its own symbol", () => {
    const text =
      `${ALL_SYMBOLS.length}\nevery element\n` +
      ALL_SYMBOLS.map((sym, i) => `${sym} ${i * 5}.0 0.0 0.0`).join("\n") +
      "\n";
    const { snapshot } = parseStructureCore({ ext: ".xyz", text });
    expect(snapshot.nAtoms).toBe(118);
    const shown = Array.from(snapshot.elements, (z) => getElementSymbol(z));
    expect(shown).toEqual(ALL_SYMBOLS);
  });
});
